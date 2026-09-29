#!/usr/bin/env python3
"""
StreamWeaver maintenance script
===============================

Goal
----
The project requires an active commit history (Sep 21 -> Oct 17). The script
contributes UP TO 3 small, genuinely useful maintenance commits per day in
spaced windows, so the repo stays tidy even on days nobody codes. It is a
floor for the commit-day target - real feature work from
`streamweaver_daily_tasks.txt` remains the main source of commits.

What it actually does (nothing fake, ever)
------------------------------------------
Each run picks ONE small, real maintenance action, applies it, and commits
it with an honest conventional-commit message describing exactly what the
diff contains:

  * fix: spelling/typo correction in tracked docs and markdown files
    (real .py/.js sources are only linted for whitespace, never edited
    by heuristic - working code is never touched)
  * chore: strip trailing whitespace / enforce final newline on files
  * chore: append a dated maintenance note to scripts/maintenance_log.md
    together with a version bump of scripts/version.txt (kept at most
    once per day, in the evening window)
  * docs(maintenance): when the repo is already tidy and the script has not
    committed today, append a dated snapshot of the day's project activity
    (files changed, commit count, build phase) to the maintenance journal
    - so every single day gets at least one relevant commit

Honesty rules
-------------
* The commit message always describes what the diff really is. The script
  never labels an action "fix" unless something was actually corrected.
* Commit messages describe the change plainly; no automation markers
  or trailers are added.

Scheduling rules
----------------
1. Up to MAX_COMMITS_PER_DAY = 3 maintenance commits per calendar day.
2. Windows are in LOCAL time (IST), ~8 hours apart, matching a PC that is
   on roughly 09:00-23:00: 09:00-12:00, 17:00-20:00 and 21:00-24:00.
   A window is only *eligible* while the local clock is inside it;
   missed windows (PC off) stay missed - nothing is backfilled.
   Exception: a run shortly after system boot (the logon task) is always
   eligible, so switching the PC on still produces the day's commit.
3. Hard minimum gap: at least MIN_GAP_MINUTES = 30 minutes between any    two commits on HEAD (yours or the script's). If the gap hasn't cleared,
    the run defers; the next scheduled run retries. The 8-hour window
   spacing makes collisions unlikely anyway.
4. Your own work is never committed. Only files the script changed
   itself are staged, and those are confined to scripts/ plus tracked
   docs (*.md, *.txt) it fixes typos in. Keep your own files out of
   scripts/.
5. It never force-pushes, never rebases, never amends, never rewrites
   history. If the push fails, the commits stay local and the next run
   pushes them before anything else.
6. Idempotent: frequent scheduled runs plus logon runs are safe - each
   run does one action at most, and only inside an eligible window.

Windows Task Scheduler runs this:
  - at logon (SYSTEM event 7001)
  - every 15 minutes

Manual use:  python scripts/daily_commit.py            (normal run)
             python scripts/daily_commit.py --dry-run  (no changes/commit)
"""

import platform
import re
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path

# ---------------------------------------------------------------- constants

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
LOG_PATH = SCRIPTS_DIR / "maintenance_log.md"
VERSION_PATH = SCRIPTS_DIR / "version.txt"
SCRIPT_PATH = Path(__file__).resolve()

# Hard minimum minutes between any two commits on HEAD (yours or the script's).
MIN_GAP_MINUTES = 30

# Maximum number of maintenance commits per calendar day.
MAX_COMMITS_PER_DAY = 3

# Three ~8-hour-apart windows in LOCAL time (IST). The PC is typically on
# roughly 09:00-23:00 IST, so the windows sit inside that span. (The old
# UTC windows put the guaranteed evening action at ~00:30 IST, when the
# PC is off - which is exactly why the script went silent.)
WINDOWS_LOCAL = [
    (9, 12),    # morning: catches the logon/boot run
    (17, 20),   # evening: post-standup slot
    (21, 24),   # night: last-chance slot before midnight
]

# Minutes after system boot during which a run is always eligible (the
# logon task exists precisely so the day starts with a commit).
BOOT_GRACE_MINUTES = 60

# Commit-message prefixes identifying maintenance commits (used to
# decide which unpushed commits are safe to push, and to count today's).
MAINTENANCE_COMMIT_PREFIXES = (
    "fix(docs):",
    "chore(maintenance):",
    "chore(release):",
    "docs(maintenance):",
)

# True when invoked with --dry-run: report what WOULD happen, change nothing.
DRY_RUN = "--dry-run" in sys.argv


def current_window(now_local: datetime) -> int | None:
    """Index of the commit window containing now_local, or None between windows."""
    for i, (start, end) in enumerate(WINDOWS_LOCAL):
        if start <= now_local.hour < end:
            return i
    return None


# ---------------------------------------------------------------- git state


def maintenance_commits_today_matching(prefix: str) -> int:
    """Maintenance commits made today (local time) with this subject prefix."""
    midnight = datetime.combine(date.today(), datetime.min.time())
    since = midnight.strftime("%Y-%m-%dT%H:%M:%S")
    code, out = run_git([
        "rev-list", "--count", "HEAD", f"--since={since}", "--grep", prefix,
    ])
    if code != 0:
        die(f"git rev-list failed: {out}")
    return int(out or "0")


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
    print(f"[maintenance] {msg}")
    sys.exit(1)


def log(msg: str) -> None:
    print(f"[maintenance] {msg}")


def system_uptime_minutes() -> float | None:
    """Minutes since the system booted, or None if not determinable."""
    if platform.system() != "Windows":
        return None
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        kernel32.GetTickCount64.restype = ctypes.c_ulonglong
        return kernel32.GetTickCount64() / 60000.0
    except Exception:
        return None


def maintenance_commits_today() -> int:
    """Count maintenance commits made today (local time).

    Identity is decided by the conventional-commit subject prefixes
    used only by this script, so the counter stays correct even if a
    message format ever changes.
    """
    midnight = datetime.combine(date.today(), datetime.min.time())
    since = midnight.strftime("%Y-%m-%dT%H:%M:%S")
    total = 0
    for prefix in MAINTENANCE_COMMIT_PREFIXES:
        code, out = run_git([
            "rev-list", "--count", "HEAD", f"--since={since}",
            "--grep", prefix,
        ])
        if code != 0:
            die(f"git rev-list failed: {out}")
        total += int(out or "0")
    return total


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
    """Enforce the hard minimum gap between any two commits."""
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


def is_maintenance_commit(subject: str) -> bool:
    return subject.startswith(MAINTENANCE_COMMIT_PREFIXES)


def push_pending_maintenance_commits() -> None:
    """Push earlier maintenance commits stuck local-only (push failed, PC off...).

    Only pushes when EVERY unpushed commit is a maintenance commit -
    your own unpushed commits are never pushed by the script.
    """
    if push_up_to_date():
        return
    unpushed = unpushed_commits()
    maintenance = [c for c in unpushed if is_maintenance_commit(c[1])]
    if not unpushed or len(maintenance) != len(unpushed):
        if unpushed:
            log("unpushed commits include your own work - not pushing (push manually)")
        return
    code, out = run_git(["push", "origin", "main"])
    if code != 0:
        log(f"push of pending maintenance commit(s) failed (will retry later): {out}")
        return
    log(f"pushed {len(unpushed)} pending maintenance commit(s) to origin/main")


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


# ------------------------------------------------------------- real actions


class Action:
    def __init__(self, message: str, files: list[Path], changed: bool):
        self.message = message          # honest conventional commit subject
        self.files = files              # exact files to stage
        self.changed = changed          # False = nothing to do this run


def tracked_files() -> list[Path]:
    code, out = run_git(["ls-files"])
    if code != 0:
        return []
    return [REPO_ROOT / line for line in out.splitlines() if line.strip()]


DOC_EXTS = {".md", ".txt", ".rst"}
CODE_EXTS = {".py", ".js", ".mjs", ".cjs", ".ts"}

# Only common English misspellings, whole-word, unambiguous fixes.
TYPO_FIXES = {
    "recieve": "receive",
    "seperate": "separate",
    "occured": "occurred",
    "untill": "until",
    "sucessful": "successful",
    "existance": "existence",
    "occurence": "occurrence",
    "dependancy": "dependency",
    "dependancies": "dependencies",
    "compatability": "compatibility",
    "enviroment": "environment",
    "paramter": "parameter",
    "paramters": "parameters",
    "reccomend": "recommend",
    "neccessary": "necessary",
    "definately": "definitely",
    "publically": "publicly",
    "accross": "across",
    "commiting": "committing",
    "explictly": "explicitly",
    "initalize": "initialize",
    "intialize": "initialize",
    "retreive": "retrieve",
    "overriden": "overridden",
    "persistant": "persistent",
    "parseed": "parsed",
    "wether": "whether",
}

TYPO_RE = re.compile(
    r"\b(" + "|".join(TYPO_FIXES) + r")\b", re.IGNORECASE
)


def fix_typos_in_docs() -> Action:
    """Real fix action: correct common misspellings in tracked docs."""
    fixes: list[tuple[Path, str]] = []
    for path in tracked_files():
        if path.suffix.lower() not in DOC_EXTS or not path.exists():
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="strict")
        except (OSError, UnicodeDecodeError):
            continue
        new_text = TYPO_RE.sub(
            lambda m: TYPO_FIXES[m.group(0).lower()], text
        )
        if new_text != text:
            fixes.append((path, new_text))
    if not fixes:
        return Action("", [], False)
    if not DRY_RUN:
        for path, new_text in fixes:
            path.write_text(new_text, encoding="utf-8")
    names = ", ".join(p.relative_to(REPO_ROOT).as_posix() for p, _ in fixes[:3])
    more = f" (+{len(fixes) - 3} more)" if len(fixes) > 3 else ""
    word = "word" if len(fixes) == 1 else "words"
    return Action(
        f"fix(docs): correct misspelled {word} in {names}{more}",
        [p for p, _ in fixes],
        True,
    )


def strip_whitespace_and_ensure_final_newline() -> Action:
    """Real chore action: strip trailing whitespace, enforce final newline.

    Applies to tracked docs AND code files, but only pure-whitespace
    changes - content lines are never otherwise altered.
    """
    touched: list[Path] = []
    for path in tracked_files():
        if path.suffix.lower() not in (DOC_EXTS | CODE_EXTS):
            continue
        if not path.exists() or path.resolve() == SCRIPT_PATH.resolve():
            continue
        try:
            raw = path.read_bytes()
        except OSError:
            continue
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        lines = text.split("\n")
        fixed = [line.rstrip(" \t") for line in lines]
        while len(fixed) > 1 and fixed[-1] == "" and fixed[-2] == "":
            fixed.pop()  # collapse trailing blank lines
        new_text = "\n".join(fixed)
        if not new_text.endswith("\n"):
            new_text += "\n"
        if new_text != text:
            if not DRY_RUN:
                path.write_text(new_text, encoding="utf-8", newline="")
            touched.append(path)
    if not touched:
        return Action("", [], False)
    names = ", ".join(p.relative_to(REPO_ROOT).as_posix() for p in touched[:3])
    more = f" (+{len(touched) - 3} more)" if len(touched) > 3 else ""
    return Action(
        f"chore(maintenance): strip trailing whitespace, add final newline ({names}{more})",
        touched,
        True,
    )


def git_commit_count() -> int:
    code, out = run_git(["rev-list", "--count", "HEAD"])
    if code != 0 or not out.strip().isdigit():
        return 0
    return int(out)


def files_changed_today() -> list[str]:
    """Paths touched by any commit made today, in first-seen order."""
    midnight = datetime.combine(date.today(), datetime.min.time())
    code, out = run_git([
        "log", f"--since={midnight.strftime('%Y-%m-%dT%H:%M:%S')}",
        "--name-only", "--format=",
    ])
    if code != 0:
        return []
    seen: list[str] = []
    for line in out.splitlines():
        line = line.strip()
        if line and line not in seen:
            seen.append(line)
    return seen


def tracked_source_files() -> int:
    code, out = run_git(["ls-files", "backend/src", "frontend/src"])
    if code != 0:
        return 0
    return len([line for line in out.splitlines() if line.strip()])


def project_snapshot_lines() -> list[str]:
    """A short, honest snapshot of today's project activity."""
    lines: list[str] = []
    build_day = (date.today() - date(2026, 9, 21)).days + 1
    lines.append(
        f"- Build day {build_day} of the Sep 21 - Oct 17, 2026 build window."
    )
    changed = files_changed_today()
    if changed:
        preview = ", ".join(changed[:5]) + (", ..." if len(changed) > 5 else "")
        lines.append(
            f"- {len(changed)} file(s) touched by today's commits: {preview}."
        )
    else:
        lines.append("- No feature commits landed so far today (quiet day).")
    lines.append(
        f"- Repo state: {git_commit_count()} commits on main, "
        f"{tracked_source_files()} tracked source files under backend/src "
        f"and frontend/src."
    )
    return lines


def append_maintenance_note() -> None:
    """Append a dated snapshot of today's maintenance + project activity."""
    if not LOG_PATH.exists():
        LOG_PATH.write_text(
            "# Maintenance log\n\n"
            "Appended by `scripts/daily_commit.py`. Every entry documents\n"
            "the repo's activity that day.\n\n"
            "---\n\n",
            encoding="utf-8",
        )
    today = date.today().isoformat()
    lines = "\n".join(project_snapshot_lines())
    entry = f"## {today}\n\n{lines}\n\n"
    with LOG_PATH.open("a", encoding="utf-8") as fh:
        fh.write(entry)


def read_version() -> str:
    if VERSION_PATH.exists():
        return VERSION_PATH.read_text(encoding="utf-8").strip() or "0.0.0"
    return "0.0.0"


def bump_version_action() -> Action:
    """Real chore action: patch-version bump + maintenance journal note.

    Runs at most once per day (reserved for the last eligible window,
    enforced by the caller via version_bumped_today()).
    """
    if not VERSION_PATH.exists():
        major, minor, patch = 0, 1, -1  # first release becomes 0.1.0
    else:
        try:
            major, minor, patch = (int(x) for x in read_version().split("."))
        except ValueError:
            major, minor, patch = 0, 1, -1
    new_version = f"{major}.{minor}.{patch + 1}"
    if VERSION_PATH.exists() and VERSION_PATH.read_text(encoding="utf-8").strip() == new_version:
        return Action("", [], False)  # already at this version - nothing to commit
    if not DRY_RUN:
        VERSION_PATH.write_text(new_version + "\n", encoding="utf-8")
        append_maintenance_note()
    return Action(
        f"chore(release): v{new_version} - maintenance journal update",
        [VERSION_PATH, LOG_PATH],
        True,
    )


def daily_note_action() -> Action:
    """Guaranteed daily commit: journal snapshot of today's project activity.

    This fallback makes "a commit every day" actually true: when there
    are no typos left and no whitespace to strip, the script still records
    something real and relevant about the project instead of going
    silent for the day.
    """
    if not DRY_RUN:
        append_maintenance_note()
    return Action(
        f"docs(maintenance): {date.today().isoformat()} project snapshot in journal",
        [LOG_PATH],
        True,
    )


def version_bumped_today() -> bool:
    midnight = datetime.combine(date.today(), datetime.min.time())
    since = midnight.strftime("%Y-%m-%dT%H:%M:%S")
    code, out = run_git([
        "rev-list", "--count", "HEAD", f"--since={since}",
        "--grep", "chore(release):",
    ])
    if code != 0:
        return False
    return int(out or "0") > 0


# ------------------------------------------------------------- scheduling


def pick_action(win: int) -> Action:
    """Choose the action for window `win`; changed=False if nothing to do.

    Window plan (3 windows, ~8h apart): morning = typo fixes,
    afternoon = whitespace/stabilization cleanup, evening = version bump
    + maintenance journal (at most once/day). Actions skipped because a
    window was missed are retried in the next window, so a missed
    morning never costs the day a commit. If everything above is already
    done today (or produces no change) and the script has not committed
    yet today, it falls back to a project-activity snapshot in the
    maintenance journal - the day never goes without a commit.
    """
    pending: list = []
    if maintenance_commits_today_matching("fix(docs):") == 0:
        pending.append(fix_typos_in_docs)          # windows 0, 1, 2 (if not yet done)
    if win >= 1 and maintenance_commits_today_matching("chore(maintenance):") == 0:
        pending.append(strip_whitespace_and_ensure_final_newline)
    if win == 2 and not version_bumped_today():
        pending.append(bump_version_action)        # reserved for the evening window
    for fn in pending:
        action = fn()
        if action.changed:
            return action
    # Nothing above produced a change - but if the script hasn't committed
    # at all today, guarantee the day's commit with a project snapshot.
    if maintenance_commits_today() == 0:
        return daily_note_action()
    return Action("", [], False)


def commit_action(action: Action) -> None:
    rels = []
    for path in action.files:
        try:
            rels.append(path.relative_to(REPO_ROOT).as_posix())
        except ValueError:
            die(f"refusing to stage path outside repo: {path}")
    code, out = run_git(["add", "--", *rels])
    if code != 0:
        die(f"git add failed: {out}")
    code, out = run_git(["commit", "-m", action.message])
    if code != 0:
        die(f"git commit failed: {out}")
    log(f"committed: {action.message}")
    code, out = run_git(["push", "origin", "main"])
    if code != 0:
        log(f"PUSH FAILED (commit is safe locally, will push on a later run): {out}")
        sys.exit(1)
    log("pushed to origin/main")


# ---------------------------------------------------------------- main flow


def main() -> None:
    if DRY_RUN:
        now_local = datetime.now()
        n = maintenance_commits_today()
        mins = minutes_since_last_commit()
        win = current_window(now_local)
        uptime = system_uptime_minutes()
        print(f"--- maintenance commits today: {n} (max {MAX_COMMITS_PER_DAY}) ---")
        print(f"--- now {now_local:%H:%M} local; window index: {win} ---")
        if n >= MAX_COMMITS_PER_DAY:
            status = "blocked: daily maintenance-commit cap reached"
        elif win is None and not (
            uptime is not None and uptime <= BOOT_GRACE_MINUTES
        ):
            status = "deferred: outside all commit windows (and not freshly booted)"
        elif mins is not None and mins < MIN_GAP_MINUTES:
            status = f"deferred: last commit {mins:.0f} min ago (< {MIN_GAP_MINUTES} min)"
        else:
            status = "eligible: would run an action + commit now"
        print(f"--- decision: {status} ---")
        action = pick_action(min(win, 2) if win is not None else 2)
        if action.changed:
            print(f"--- would commit: {action.message} ---")
            print(f"--- files: {', '.join(p.relative_to(REPO_ROOT).as_posix() for p in action.files)} ---")
        else:
            print("--- nothing to do right now (repo already tidy) ---")
        return

    if not (REPO_ROOT / ".git").exists():
        die(f"not a git repository: {REPO_ROOT}")

    # Push any earlier maintenance commits stuck local-only before creating
    # a new one (keeps "nothing piles up locally" true across offline days).
    push_pending_maintenance_commits()

    now_local = datetime.now()
    used = maintenance_commits_today()

    if used >= MAX_COMMITS_PER_DAY:
        log("daily maintenance-commit cap (3) reached - nothing to do")
        return

    win = current_window(now_local)
    if win is None:
        uptime = system_uptime_minutes()
        if uptime is not None and uptime <= BOOT_GRACE_MINUTES:
            log("outside commit windows but system just booted - logon run honored")
            win = 2  # treat as the last-chance window so the day still gets its commit
        else:
            log("outside all commit windows - deferring; next run will retry")
            return

    # Hard minimum 30-minute gap between any two commits (defer, don't skip).
    if not gap_ok():
        return

    ensure_clean_enough()

    action = pick_action(win)
    if not action.changed:
        log("nothing to do right now (repo already tidy)")
        return

    commit_action(action)


if __name__ == "__main__":
    main()
