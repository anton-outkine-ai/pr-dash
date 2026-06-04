#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "fastapi",
#   "uvicorn",
# ]
# ///
"""PR dashboard backend.

Wraps `gh pr list` + `bk build view` and exposes a single JSON endpoint that
the frontend renders into PR cards.

Run:  uv run app.py
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse

BASE = Path(__file__).parent
INDEX = BASE / "index.html"

# Claude Code stores per-session transcripts as jsonl under ~/.claude/projects/<slug>/<sid>.jsonl.
CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"

BK_URL_RE = re.compile(r"buildkite\.com/([^/]+)/([^/]+)/builds/(\d+)")

# Cache: path -> (mtime, summary) so we re-parse a session file only when it changes.
_SESSION_CACHE: dict[str, tuple[float, dict]] = {}

app = FastAPI()


async def run_cmd(*args: str, cwd: str | None = None) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
    )
    out, err = await proc.communicate()
    return proc.returncode or 0, out.decode(), err.decode()


def check_state(c: dict) -> str:
    return (c.get("conclusion") or c.get("state") or "").upper()


def is_failing(c: dict) -> bool:
    return check_state(c) in {"FAILURE", "TIMED_OUT", "ERROR", "CANCELLED"}


def is_passing(c: dict) -> bool:
    return check_state(c) == "SUCCESS"


def is_pending(c: dict) -> bool:
    status = (c.get("status") or "").upper()
    if status in {"IN_PROGRESS", "QUEUED", "PENDING", "WAITING"}:
        return True
    return check_state(c) == "PENDING"


def bk_key(url: str | None) -> tuple[str, str] | None:
    if not url:
        return None
    m = BK_URL_RE.search(url)
    if not m:
        return None
    return m.group(2), m.group(3)


async def fetch_buildkite(pipeline: str, build: str) -> dict:
    rc, out, err = await run_cmd("bk", "build", "view", "-p", pipeline, build)
    if rc != 0:
        msg = err.strip().splitlines()[-1] if err.strip() else "bk build view failed"
        return {"error": msg}
    try:
        data = json.loads(out)
    except json.JSONDecodeError as e:
        return {"error": f"bk returned non-JSON: {e}"}

    failed = [
        {
            "name": j.get("name") or j.get("id"),
            "state": j.get("state"),
            "url": j.get("web_url"),
        }
        for j in data.get("jobs", [])
        if j.get("state") in {"failed", "timed_out"}
    ]
    broken_count = sum(1 for j in data.get("jobs", []) if j.get("state") == "broken")
    return {
        "state": data.get("state"),
        "pipeline": pipeline,
        "build": build,
        "failed_jobs": failed,
        "broken_count": broken_count,
    }


def detect_trunk_merge(comments: list[dict]) -> dict:
    """Inspect PR comments for trunk-io's merge-queue marker comment.

    Returns {"state": one of (None, "not_staged", "staged", "queued", "running", "failed",
                              "merged"),
             "comment_url": link to the trunk comment, or None}.

    Trunk-io posts a single sticky comment on every managed PR with the marker
    "<!-- Trunk Merge -->". The checkbox state encodes user intent:
      - "[ ] <!-- End PR Submit Checkbox -->"  → user has not requested merge ("not_staged")
      - "[x] <!-- End PR Submit Checkbox -->"  → user has requested merge ("staged")
    Once queued, trunk rewrites the comment body with status keywords.
    """
    body = None
    url = None
    for c in comments or []:
        author = ((c.get("author") or {}).get("login") or "").lower()
        if author != "trunk-io":
            continue
        b = c.get("body") or ""
        if "<!-- trunk merge -->" in b.lower():
            body = b
            url = c.get("url")
            break

    if not body:
        return {"state": None, "comment_url": None}

    low = body.lower()
    # Use only the checkbox state as a robust signal. Trunk's default template body
    # contains the phrase "If the PR fails, failure details will also be posted here",
    # so substring keyword scans for "failed"/"failure" false-positive on every PR.
    # The checkbox flips reliably: [ ] = user has not requested merge; [x] = requested.
    # Trunk later rewrites the body for queued/running/failed states; without sample
    # bodies on hand we don't try to classify those — call them "in_progress" instead.
    if "[x] <!-- end pr submit checkbox -->" in low:
        state = "staged"
    elif "[ ] <!-- end pr submit checkbox -->" in low:
        state = "not_staged"
    else:
        state = "in_progress"

    return {"state": state, "comment_url": url}


def last_commit_at(commits: list[dict]) -> str | None:
    """Return the committedDate of the head commit (the last push)."""
    if not commits:
        return None
    last = commits[-1]
    return last.get("committedDate") or last.get("authoredDate")


def _summarize_session_file(path: Path) -> dict | None:
    """Parse a Claude session jsonl and return a compact summary, or None if empty."""
    branch: str | None = None
    title: str | None = None
    first_ts: str | None = None
    last_ts: str | None = None
    user_msgs = 0
    assistant_msgs = 0
    cwd: str | None = None

    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if not line.strip():
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                t = d.get("type")
                if t == "user":
                    user_msgs += 1
                elif t == "assistant":
                    assistant_msgs += 1
                elif t == "ai-title":
                    title = d.get("aiTitle") or title
                if branch is None and d.get("gitBranch"):
                    branch = d["gitBranch"]
                if cwd is None and d.get("cwd"):
                    cwd = d["cwd"]
                ts = d.get("timestamp")
                if ts:
                    if first_ts is None or ts < first_ts:
                        first_ts = ts
                    if last_ts is None or ts > last_ts:
                        last_ts = ts
    except OSError:
        return None

    if not branch and user_msgs == 0 and assistant_msgs == 0:
        return None

    return {
        "session_id": path.stem,
        "branch": branch,
        "title": title,
        "cwd": cwd,
        "first_ts": first_ts,
        "last_ts": last_ts,
        "user_msgs": user_msgs,
        "assistant_msgs": assistant_msgs,
    }


def build_session_index() -> dict[str, list[dict]]:
    """Walk all Claude project dirs, build {branch: [session_summary, ...]} index.

    Uses mtime-keyed cache: a session file is only re-parsed when its mtime changes.
    """
    if not CLAUDE_PROJECTS_DIR.exists():
        return {}

    by_branch: dict[str, list[dict]] = {}
    for jsonl in CLAUDE_PROJECTS_DIR.glob("*/*.jsonl"):
        try:
            mtime = jsonl.stat().st_mtime
        except OSError:
            continue
        key = str(jsonl)
        cached = _SESSION_CACHE.get(key)
        if cached and cached[0] == mtime:
            summary = cached[1]
        else:
            summary = _summarize_session_file(jsonl)
            if summary is None:
                continue
            _SESSION_CACHE[key] = (mtime, summary)
        branch = summary.get("branch")
        if not branch:
            continue
        # Skip sessions with no exchanges (started but never used).
        if summary.get("user_msgs", 0) == 0 and summary.get("assistant_msgs", 0) == 0:
            continue
        by_branch.setdefault(branch, []).append(summary)

    for sessions in by_branch.values():
        sessions.sort(key=lambda s: s.get("last_ts") or "", reverse=True)
    return by_branch


async def enrich(pr: dict, bk_cache: dict[tuple[str, str], asyncio.Task], session_index: dict[str, list[dict]]) -> dict:
    checks = pr.get("statusCheckRollup") or []
    failing = [c for c in checks if is_failing(c)]
    passing = [c for c in checks if is_passing(c)]
    pending = [c for c in checks if is_pending(c)]

    failing_out = []
    for c in failing:
        url = c.get("targetUrl") or c.get("detailsUrl") or ""
        key = bk_key(url)
        bk_data = await bk_cache[key] if key in bk_cache else None
        failing_out.append(
            {
                "name": c.get("name") or c.get("context") or "<unnamed>",
                "state": check_state(c),
                "url": url or None,
                "buildkite": bk_data,
            }
        )

    reviews = pr.get("latestReviews") or []
    approvals = sum(1 for r in reviews if r.get("state") == "APPROVED")
    changes = sum(1 for r in reviews if r.get("state") == "CHANGES_REQUESTED")
    pending_reviewers = len(pr.get("reviewRequests") or [])

    sessions = session_index.get(pr["headRefName"], [])

    return {
        "number": pr["number"],
        "title": pr["title"],
        "url": pr["url"],
        "repo": pr.get("_repo"),
        "branch": pr["headRefName"],
        "draft": bool(pr.get("isDraft")),
        "review_decision": pr.get("reviewDecision") or "",
        "approvals": approvals,
        "changes_requested": changes,
        "pending_reviewers": pending_reviewers,
        "checks_passing": len(passing),
        "checks_failing": len(failing),
        "checks_pending": len(pending),
        "failing_checks": failing_out,
        "claude_sessions": sessions,
        "updated_at": pr.get("updatedAt"),
        "created_at": pr.get("createdAt"),
        "last_commit_at": last_commit_at(pr.get("_commits") or []),
        "trunk_merge": detect_trunk_merge(pr.get("_comments") or []),
    }


async def fetch_prs() -> list[dict]:
    # `gh search prs` works across every org/repo the user can see — no cwd dependency.
    # It only returns a thin set of fields, so we fan out to `gh pr view --repo ...` below
    # to fetch the rich data the dashboard renders (checks, reviews, comments, commits).
    rc, out, err = await run_cmd(
        "gh", "search", "prs",
        "--author", "@me",
        "--state", "open",
        "--limit", "100",
        "--json", "number,url,repository",
    )
    if rc != 0:
        raise RuntimeError(f"gh search prs failed: {err.strip()}")
    hits = json.loads(out)

    refs = []
    for h in hits:
        repo = (h.get("repository") or {}).get("nameWithOwner")
        if not repo:
            continue
        refs.append({"repo": repo, "number": h["number"], "url": h.get("url")})

    detail_tasks = [asyncio.create_task(fetch_pr_full(r["repo"], r["number"])) for r in refs]
    prs: list[dict] = []
    for ref, task in zip(refs, detail_tasks):
        pr = await task
        if not pr:
            continue
        pr["_repo"] = ref["repo"]
        prs.append(pr)

    bk_targets: set[tuple[str, str]] = set()
    for pr in prs:
        for c in pr.get("statusCheckRollup") or []:
            if not is_failing(c):
                continue
            key = bk_key(c.get("targetUrl") or c.get("detailsUrl"))
            if key:
                bk_targets.add(key)

    bk_cache = {key: asyncio.create_task(fetch_buildkite(*key)) for key in bk_targets}
    session_index = await asyncio.to_thread(build_session_index)

    enriched = await asyncio.gather(*(enrich(pr, bk_cache, session_index) for pr in prs))
    return list(enriched)


async def fetch_pr_full(repo: str, number: int) -> dict:
    rc, out, _ = await run_cmd(
        "gh", "pr", "view", str(number),
        "--repo", repo,
        "--json",
        "number,title,url,headRefName,isDraft,reviewDecision,latestReviews,reviewRequests,"
        "statusCheckRollup,updatedAt,createdAt,comments,commits",
    )
    if rc != 0:
        return {}
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return {}
    # enrich() reads these under the `_comments` / `_commits` keys (kept separate so the
    # raw GraphQL response doesn't leak into the API output).
    data["_comments"] = data.pop("comments", []) or []
    data["_commits"] = data.pop("commits", []) or []
    return data


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(INDEX)


@app.get("/api/prs")
async def api_prs() -> JSONResponse:
    try:
        prs = await fetch_prs()
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    return JSONResponse({"prs": prs})


def main() -> None:
    import uvicorn

    port = 8765
    for arg in sys.argv[1:]:
        if arg.startswith("--port="):
            port = int(arg.split("=", 1)[1])
    uvicorn.run(app, host="127.0.0.1", port=port)


if __name__ == "__main__":
    main()
