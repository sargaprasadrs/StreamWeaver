#!/usr/bin/env python3
"""
One-time setup for the StreamWeaver daily commit bot
====================================================

Registers two Windows scheduled tasks that run scripts\\daily_commit.py:

  1. "StreamWeaver Daily Commit (Logon)"  - at logon (Event 7001), so the
     day's commit happens shortly after you switch on your PC.
  2. "StreamWeaver Daily Commit (Hourly)" - hourly, for days when the PC
     stays on or you log in later; the bot itself is a no-op if a commit
     already exists for today.

The bot is idempotent (max 1 commit/day, only touches its own standup log),
so frequent runs are safe.

Run as:   python scripts\\setup_daily_task.py
Re-runnable: it deletes and re-creates its own tasks; nothing else is touched.
"""

import getpass
import os
import subprocess
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
BOT = SCRIPTS_DIR / "daily_commit.py"
TASK_PREFIX = "StreamWeaver Daily Commit"
LOG_FILE = SCRIPTS_DIR / "scheduler_setup.log"

# Python launcher: prefer the real python.exe (Windows Store shim in
# WindowsApps cannot see command-line args reliably under schtasks).
def find_python() -> str:
    for cand in (
        Path(sys.executable),
        Path(r"C:\Program Files\Python311\python.exe"),
    ):
        if cand.exists() and "WindowsApps" not in str(cand):
            return str(cand)
    return "python.exe"  # fallback: rely on PATH


def python_exe() -> str:
    exe = find_python()
    return f'"{exe}"' if " " in exe else exe


def task_xml(name: str, trigger: str) -> str:
    """Build a Task Scheduler XML definition for the bot task."""
    author = getpass.getuser()
    python_cmd = python_exe()
    bot_cmd = str(BOT)
    # Escape XML entities in paths
    bot_cmd = bot_cmd.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    python_cmd_x = python_cmd.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    working_dir = str(SCRIPTS_DIR.parent).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    if trigger == "logon":
        trigger_block = (
            "<LogonTrigger>"
            "<Enabled>true</Enabled>"
            "<UserId>S-1-5-18</UserId>"  # placeholder; replaced below by user SID
            "</LogonTrigger>"
        )
    else:  # hourly
        trigger_block = (
            "<TimeTrigger>"
            "<Repetition><Interval>PT1H</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>"
            "<StartBoundary>2026-01-01T09:00:00</StartBoundary>"
            "<Enabled>true</Enabled>"
            "</TimeTrigger>"
        )

    return f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>StreamWeaver daily standup-log commit (max 1/day, pushes to origin/main).</Description>
    <Author>{author}</Author>
  </RegistrationInfo>
  <Triggers>{trigger_block}</Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{python_cmd_x}</Command>
      <Arguments>"{bot_cmd}"</Arguments>
      <WorkingDirectory>{working_dir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"""


def run(cmd: list[str]) -> int:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    out = (proc.stdout + proc.stderr).strip()
    print(out)
    return proc.returncode


def install(name: str, trigger: str, user_sid: str) -> None:
    xml = task_xml(name, trigger)
    # For the logon task, set the actual current user SID
    xml = xml.replace("S-1-5-18", user_sid)

    xml_path = SCRIPTS_DIR / f"scheduled_task_{trigger}.xml"
    xml_path.write_text(xml, encoding="utf-16")
    print(f"[setup] wrote {xml_path.name}")

    # Delete pre-existing task of the same name (idempotent re-runs)
    subprocess.run(["schtasks", "/Delete", "/TN", name, "/F"],
                   capture_output=True, text=True)

    code = run(["schtasks", "/Create", "/TN", name, "/XML", str(xml_path)])
    if code == 0:
        print(f"[setup] task installed: {name}")
    else:
        print(f"[setup] FAILED to install task: {name} (exit {code})")


def main() -> None:
    if not BOT.exists():
        print(f"[setup] ERROR: bot script not found: {BOT}")
        sys.exit(1)

    # Resolve current user's SID via PowerShell
    sid_proc = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         "(New-Object System.Security.Principal.NTAccount($env:USERNAME)).Translate("
         "[System.Security.Principal.SecurityIdentifier]).Value"],
        capture_output=True, text=True)
    user_sid = sid_proc.stdout.strip() or "S-1-5-21-0-0-0-1001"
    print(f"[setup] user SID: {user_sid}")

    install(f"{TASK_PREFIX} (Logon)", "logon", user_sid)
    install(f"{TASK_PREFIX} (Hourly)", "hourly", user_sid)

    print("\n[setup] verifying tasks:")
    run(["schtasks", "/Query", "/FO", "LIST", "/TN", f"{TASK_PREFIX} (Logon)"])
    run(["schtasks", "/Query", "/FO", "LIST", "/TN", f"{TASK_PREFIX} (Hourly)"])

    LOG_FILE.write_text("setup completed", encoding="utf-8")
    print("[setup] done. Run manually any time with:")
    print("   python scripts/daily_commit.py")
    print("(use --dry-run to preview without committing)")


if __name__ == "__main__":
    main()
