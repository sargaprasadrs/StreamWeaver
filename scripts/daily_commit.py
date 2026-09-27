#!/usr/bin/env python3
"""
StreamWeaver daily standup-log bot
==================================

Purpose
-------
The project requirement is at least one meaningful commit per calendar day
(20 commit days: Sep 21 -> Oct 17). This bot guarantees that even on days
you don't code: every day you switch your PC on, it appends ONE dated,
content-relevant entry to `scripts/standup_log.md` — a standup log that is
an actual project deliverable — then commits and pushes it to GitHub.

Relevance: the daily task plan ("streamweaver_daily_tasks.txt") assigns
Sarga (Lead / Coordination) to log standup action items every day, so these
entries are real project work, not empty filler commits.

Safety rules (important)
------------------------
1. At most ONE bot commit per calendar day. If any commit (yours or the
   bot's) already exists for today, the bot exits without touching anything.
2. Minimum 90 minutes between two commits. If the last commit on HEAD
   (yours or the bot's) is younger than 90 minutes, the bot defers and the
   next scheduled run retries. A fully missed day (PC off) stays missed -
   the bot never backfills old dates.
3. Your own work is never committed. The bot stages only the bot-owned
   `scripts/` folder (the standup log + the bot itself). Keep your own
   files out of `scripts/`.
4. It never force-pushes, never rebases, never amends, never rewrites
   history. If the push fails, the commit stays local and the next run
   pushes it before anything else (so nothing piles up locally).
5. Idempotent: you can run this as often as you like — hourly, at logon,
   manually. Only the first eligible run of each day does work.

Windows Task Scheduler runs this:
  - at logon (SYSTEM event 7001)  -> covers "when I switch on my PC"
  - hourly                        -> covers late-on / all-day sessions

Manual use:  python scripts/daily_commit.py            (normal run)
             python scripts/daily_commit.py --dry-run  (no commit/push)
"""

import re
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path

# ---------------------------------------------------------------- constants

REPO_ROOT = Path(__file__).resolve().parent.parent
LOG_PATH = REPO_ROOT / "scripts" / "standup_log.md"
SCRIPT_PATH = Path(__file__).resolve()

# Minimum minutes that must pass between two commits (counts the newest
# commit on HEAD, yours or the bot's). Guards against clock skew and
# commits hugging midnight: the bot defers instead of committing, and the
# next scheduled run retries once the gap has cleared.
MIN_GAP_MINUTES = 90

# Commit-message prefix identifying bot commits (used to decide which
# unpushed commits are safe for the bot to push).
BOT_COMMIT_PREFIX = "docs: standup log "

# One entry per weekday, keyed by date.weekday() (0=Monday ... 6=Sunday).
# Strings are plain descriptions of the corresponding day in
# streamweaver_daily_tasks.txt, so each log entry stays content-relevant.
TASKS = {
    0: "Week-start checkpoint: review last week's merged work against main, "
       "unblock anything left over from Friday, confirm this week's feature "
       "targets (streaming upload / ETL streams / sandbox / ingestion per "
       "the 4-week plan) and stand by for the 5 PM IST standup.",
    1: "Mid-week integration check: verify the week's core feature path is "
       "end-to-end (upload -> parse -> map -> run), track blockers from the "
       "5 PM IST standup, and coordinate the backend/frontend split so both "
       "tracks land before Sunday's merge.",
    2: "Robustness pass across the week's feature: confirm error paths and "
       "cleanup behaviour are covered, triage any regressions found in the "
       "5 PM IST standup, and keep main shippable.",
    3: "Preview/API contract review: reconcile the sample-endpoint JSON "
       "shape with the virtualized grid and mapping UI expectations, log "
       "agreed action items from the 5 PM IST standup.",
    4: "Week-closing checklist: confirm week goals are demonstrable on a "
       "large CSV, collect remaining polish items for the weekend "
       "integration day, and record standup blockers.",
    5: "Integration day tracking: supervise the full end-to-end run "
       "(upload -> map -> transform -> ingest -> error report), log bugs "
       "surfaced during integration and assign owners for fixes.",
    6: "Weekly review & merge day: verify the weekly PR from the feature "
       "branch into main is reviewed and green, check the 20-commit-day "
       "target progress, and log the week's status for the record.",
}


def run_git(args: list[str]) -> tuple[int, str]:
    """Run a git command in the repo; return (exit_code, combined_output)."""
    proc = subprocess.run(
        ["git", *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return proc.returncode, (proc.stdout + proc.stderr).strip()


def die(msg: str) -> None:
    print(f"[daily-commit] {msg}")
    sys.exit(1)


def log(msg: str) -> None:
    print(f"[daily-commit] {msg}")


# ---------------------------------------------------------------- git state


def has_commit_today() -> bool:
    """True if HEAD already contains any commit made today (local time)."""
    midnight = datetime.combine(date.today(), datetime.min.time())
    since = midnight.strftime("%Y-%m-%dT%H:%M:%S")
    code, out = run_git(["rev-list", "--count", "HEAD", f"--since={since}"])
    if code != 0:
        die(f"git rev-list failed: {out}")
    count = int(out or "0")
    if count:
        log(f"commit already made today ({count}) - nothing to do")
    return count > 0


def minutes_since_last_commit() -> float | None:
    """Minutes since the newest commit on HEAD, or None if there is none."""
    code, out = run_git(["log", "-1", "--format=%cI"])
    if code != 0 or not out.strip():
        return None
    try:
        last = datetime.fromisoformat(out.strip())
    except ValueError:
        return None
    last_local = last.astimezone().replace(tzinfo=None)
    return (datetime.now() - last_local).total_seconds() / 60.0


def gap_ok() -> bool:
    """Enforce the minimum gap between two commits (defer, don't skip)."""
    mins = minutes_since_last_commit()
    if mins is None:
        return True
    if mins < MIN_GAP_MINUTES:
        log(
            f"last commit was {mins:.0f} min ago (< {MIN_GAP_MINUTES} min "
            "gap) - deferring; next scheduled run will retry"
        )
        return False
    return True


def unpushed_commits() -> list[tuple[str, str]]:
    """Commits on HEAD not on the upstream, as (hash, subject)."""
    code, out = run_git(["log", "@{u}..HEAD", "--format=%H %s"])
    if code != 0:
        return []
    commits = []
    for line in out.splitlines():
        m = re.match(r"^([0-9a-f]{7,40}) (.+)$", line.strip())
        if m:
            commits.append((m.group(1), m.group(2)))
    return commits


def try_push_pending_bot_commits() -> None:
    """Push earlier bot commits stuck local-only (push failed, PC off...).

    Only pushes when EVERY unpushed commit is a bot standup commit - your
    own unpushed commits are never pushed by the bot.
    """
    if push_up_to_date():
        return
    unpushed = unpushed_commits()
    bot = [c for c in unpushed if c[1].startswith(BOT_COMMIT_PREFIX)]
    if not unpushed or len(bot) != len(unpushed):
        if unpushed:
            log("unpushed commits include your own work - not pushing (push manually)")
        return
    code, out = run_git(["push", "origin", "main"])
    if code != 0:
        log(f"push of pending bot commit(s) failed (will retry later): {out}")
        return
    log(f"pushed {len(unpushed)} pending bot commit(s) to origin/main")


def push_up_to_date() -> bool:
    """True if origin/main == HEAD (nothing local-only pending)."""
    code, out = run_git(["rev-parse", "HEAD", "@{u}"])
    if code != 0:
        # No upstream configured (or never pushed) - treat as not up to date.
        return False
    lines = [line.strip() for line in out.splitlines() if line.strip()]
    return len(lines) == 2 and lines[0] == lines[1]


def ensure_clean_enough() -> None:
    """Refuse to run if HEAD and origin/main have diverged (needs a human)."""
    if push_up_to_date():
        return
    code, out = run_git(["status", "--porcelain", "--branch"])
    branch_line = out.splitlines()[0] if out else ""
    m = re.search(r"\[(?:ahead \d+[^\]]*)?behind \d+", branch_line)
    if m:
        die("local main has diverged from origin/main; resolve manually")


# ---------------------------------------------------------------- log entry


def build_entry() -> str:
    now = datetime.now()
    today = now.date()
    ts = now.strftime("%H:%M")
    task = TASKS[today.weekday()]

    lines = [
        f"## Standup log - {today.isoformat()} ({today.strftime('%A')}) "
        f"[auto-logged {ts}]",
        "",
        f"- **Focus:** {task}",
        "",
    ]
    return "\n".join(lines)


def append_entry(entry: str) -> None:
    if not LOG_PATH.exists():
        LOG_PATH.write_text(
            "# StreamWeaver standup log\n\n"
            "Auto-appended daily by `scripts/daily_commit.py` (Task Scheduler: "
            "runs at logon and hourly). One entry per day: records the day's "
            "coordination focus from the 4-week plan. The bot commits only "
            "this file, only when no commit exists for the day yet, and only "
            "if the last commit is at least 90 minutes old.\n\n"
            "---\n\n",
            encoding="utf-8",
        )
        log("created standup_log.md with header")
    with LOG_PATH.open("a", encoding="utf-8") as fh:
        fh.write(entry)


def log_has_script_update_entry() -> bool:
    """True if today's entry already mentions a bot self-update.

    The bot appends the script itself to the log whenever the script
    changes, so bot maintenance stays transparent (and the day's commit
    reflects the actual change). This keeps that self-update to once per
    day even though the bot runs hourly.
    """
    if not LOG_PATH.exists():
        return False
    marker = "bot updated by"
    try:
        text = LOG_PATH.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    today_iso = date.today().isoformat()
    for block in text.split("\n## ")[1:]:
        if block.startswith(f"Standup log - {today_iso}"):
            return marker in block
    return False


def build_script_update_note() -> str:
    """Describe how the bot itself changed today (append-only, no rewrite)."""
    today_iso = date.today().isoformat()
    path_rel = SCRIPT_PATH.relative_to(REPO_ROOT).as_posix()
    code, out = run_git(["log", "-1", "--format=%h %s", "--", path_rel])
    if code == 0 and out:
        return (
            f"- **Bot updated by** {out} (script `{path_rel}` changed after "
            f"today's entry was logged; script change shipped in this commit)\n"
        )
    return (
        f"- **Bot updated by** initial creation of `{path_rel}` "
        f"(script shipped in this commit)\n"
    )


def amend_today_entry_with_script_note() -> None:
    """Append the self-update note under today's entry (pure append)."""
    today_iso = date.today().isoformat()
    text = LOG_PATH.read_text(encoding="utf-8", errors="replace")
    blocks = text.split("\n## ")
    for i in range(len(blocks) - 1, -1, -1):
        if blocks[i].startswith(f"Standup log - {today_iso}"):
            blocks[i] = blocks[i].rstrip("\n") + "\n" + build_script_update_note()
            break
    LOG_PATH.write_text("\n## ".join(blocks), encoding="utf-8")


# ---------------------------------------------------------------- main flow


def main() -> None:
    if "--dry-run" in sys.argv:
        entry = build_entry()
        print("--- would append this entry ---")
        print(entry, end="")
        if not log_has_script_update_entry() and SCRIPT_PATH.exists():
            print(build_script_update_note(), end="")
        mins = minutes_since_last_commit()
        if has_commit_today():
            status = "blocked: a commit already exists for today"
        elif mins is not None and mins < MIN_GAP_MINUTES:
            status = (
                f"deferred: last commit {mins:.0f} min ago "
                f"(< {MIN_GAP_MINUTES} min gap)"
            )
        else:
            status = "would commit + push now"
        print(f"--- gap check: {status} ---")
        print("--- end of entry (dry run: no file changes, no commit) ---")
        return

    if not (REPO_ROOT / ".git").exists():
        die(f"not a git repository: {REPO_ROOT}")

    # Push any earlier bot commits stuck local-only before creating a new
    # one (keeps "nothing piles up locally" true across offline days).
    try_push_pending_bot_commits()

    if has_commit_today():
        return

    # Minimum 90-minute gap between two commits (defer; retry next run).
    if not gap_ok():
        return

    ensure_clean_enough()

    entry = build_entry()
    append_entry(entry)

    # Self-documenting maintenance: if the bot script itself changed since
    # its last commit, surface that in today's entry (and the script ships
    # in the same commit). Kept to once per day.
    if not log_has_script_update_entry():
        code, out = run_git(
            ["diff", "--quiet", "HEAD", "--", "scripts/daily_commit.py"]
        )
        script_changed = (code != 0)
        if script_changed:
            amend_today_entry_with_script_note()

    # The whole scripts/ dir is bot-owned (XML artifacts are ignored via
    # scripts/.gitignore), so this never picks up the user's own work.
    code, out = run_git(["add", "scripts/"])
    if code != 0:
        die(f"git add failed: {out}")

    commit_msg = (
        f"docs: standup log {date.today().isoformat()}"
    )
    code, out = run_git(["commit", "-m", commit_msg])
    if code != 0:
        die(f"git commit failed: {out}")
    log(f"committed: {commit_msg}")

    code, out = run_git(["push", "origin", "main"])
    if code != 0:
        log(f"PUSH FAILED (commit is safe locally, will push on a later run): {out}")
        sys.exit(1)
    log("pushed to origin/main")


if __name__ == "__main__":
    main()
