# Claude Stop Hook Cost Logger

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the harness-computed `total_cost_usd` per session into `~/.claude/cost-state/`, providing exact session costs (same number shown in the status bar) for future dashboard integration.

**Architecture (CORRECTED):** The original plan assumed the `Stop` hook JSON carries `cost.total_cost_usd`. **It does not** — Stop hook stdin only has `session_id`, `transcript_path`, `cwd`, `permission_mode`, `last_assistant_message`, etc. The transcript JSONL holds `message.usage` token counts but **no** cost. The **only** place the harness exposes the authoritative `cost.total_cost_usd` is the **statusline** command input.

So cost logging lives in `~/.claude/statusline-command.sh`: each render it writes `{session_id, date, cost_usd}` to `~/.claude/cost-state/<session_id>.json` (overwrite, not append). `total_cost_usd` is cumulative, so the last write per session is the final cost. The consumer reads one file per session — no dedup, no unbounded growth.

**Tech Stack:** Python 3 (system), `~/.claude/settings.json` (existing)

---

## Codex sanity check — can we do the same for Codex?

**No.** Codex (0.137.0) has no hook system. `config.toml` has no hook config; there is no `~/.codex/hooks/` directory. The status bar line is configured via `tui.status_line` in `config.toml` but offers no exec callback.

**Best available Codex sources:**
- `~/.codex/state_5.sqlite` → `threads` table has `tokens_used` (total), `created_at` (unix ms), `model` per session — but no input/output/cached breakdown.
- `~/.codex/sessions/YYYY/MM/DD/*.jsonl` → `event_msg` entries with `type: "token_count"` hold full breakdown (`input_tokens`, `cached_input_tokens`, `output_tokens`) in `payload.info.total_token_usage`.

**Conclusion for Codex:** use JSONL parsing (full breakdown → accurate pricing). The SQLite route is simpler but less accurate because input ($5/M), output ($30/M), and cached input ($1.25/M) differ 6×.

---

## File Map

| File | Change |
|------|--------|
| `~/.claude/statusline-command.sh` | **Modify** — write per-session cost to `~/.claude/cost-state/<sid>.json` |
| `~/.claude/cost-state/` | **Created at runtime** — one JSON per session |

> **Note:** The Stop-hook approach (`cost-logger.py` + `settings.json` Stop entry) was tried and **abandoned** — Stop hook JSON has no cost field. Those steps below are kept for the record but the statusline approach above is the one in effect.

---

## Task 1: Write and install the Stop hook

- [ ] **Step 1: Create the hook script**

Create `~/.claude/hooks/cost-logger.py`:

```python
#!/usr/bin/env python3
"""Claude Code Stop hook — appends session cost to ~/.claude/cost-log.jsonl.

Stop fires after every turn (not just at session exit). total_cost_usd is
cumulative, so each entry is a running total. Consumers take max per session_id.
"""
import json
import os
import sys
from datetime import datetime, timezone

try:
    data = json.load(sys.stdin)
except json.JSONDecodeError:
    sys.exit(0)

cost_obj = data.get("cost") or {}
cost = cost_obj.get("total_cost_usd") if isinstance(cost_obj, dict) else None
if cost is None:
    sys.exit(0)

session_id = data.get("session_id") or data.get("sessionId") or ""
date = datetime.now(timezone.utc).strftime("%Y-%m-%d")

log_path = os.path.expanduser("~/.claude/cost-log.jsonl")
with open(log_path, "a", encoding="utf-8") as f:
    f.write(json.dumps({"session_id": session_id, "date": date, "cost_usd": cost}) + "\n")
```

Make it executable:

```bash
chmod +x ~/.claude/hooks/cost-logger.py
```

- [ ] **Step 2: Register the Stop hook in `~/.claude/settings.json`**

Read the current file first. It looks like:

```json
{
  "hooks": {
    "SessionStart": [...],
    "UserPromptSubmit": [...]
  }
}
```

Add a `"Stop"` key inside `"hooks"`:

```json
"Stop": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "python3 /home/anton.outkine/.claude/hooks/cost-logger.py",
        "timeout": 5
      }
    ]
  }
]
```

Full resulting `"hooks"` block:

```json
"hooks": {
  "SessionStart": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "\"/home/anton.outkine/.nvm/versions/node/v25.9.0/bin/node\" \"/home/anton.outkine/.claude/hooks/caveman-activate.js\"",
          "timeout": 5,
          "statusMessage": "Loading caveman mode..."
        }
      ]
    }
  ],
  "UserPromptSubmit": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "\"/home/anton.outkine/.nvm/versions/node/v25.9.0/bin/node\" \"/home/anton.outkine/.claude/hooks/caveman-mode-tracker.js\"",
          "timeout": 5,
          "statusMessage": "Tracking caveman mode..."
        }
      ]
    }
  ],
  "Stop": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "python3 /home/anton.outkine/.claude/hooks/cost-logger.py",
          "timeout": 5
        }
      ]
    }
  ]
}
```

- [ ] **Step 3: Verify the hook will be picked up**

```bash
python3 -c "
import json
with open('/home/anton.outkine/.claude/settings.json') as f:
    d = json.load(f)
stop = d.get('hooks', {}).get('Stop')
print('Stop hook registered:', bool(stop))
print(json.dumps(stop, indent=2))
"
```

Expected: `Stop hook registered: True` with the hook entry printed.

- [ ] **Step 4: Test the hook in a new Claude session**

The hook only fires in sessions started AFTER it was registered (hooks are loaded at session start).

Open a new terminal and start a minimal claude session:

```bash
cd /tmp && claude -p "say the word hello and nothing else"
```

Wait for the response, then exit. Then verify the log was written:

```bash
cat ~/.claude/cost-log.jsonl | tail -5
```

Expected output (values will vary):

```json
{"session_id": "some-uuid", "date": "2026-06-04", "cost_usd": 0.012}
```

If the file doesn't exist or is empty:
- Check if the hook fired: `cat ~/.claude/cost-log.jsonl` (file should exist even if empty means hook ran but cost was null)
- Inspect hook stdin format by adding a debug line to the script temporarily: `with open('/tmp/hook-debug.json','w') as dbg: json.dump(data, dbg, indent=2)` — then check `/tmp/hook-debug.json` to see the actual JSON fields available

- [ ] **Step 5: Verify deduplication logic works for multi-turn sessions**

Run a slightly longer session (2-3 prompts) and check the log accumulates multiple entries for the same session_id with increasing cost_usd:

```bash
python3 -c "
import json
entries = []
with open('/home/anton.outkine/.claude/cost-log.jsonl') as f:
    for line in f:
        line = line.strip()
        if line:
            entries.append(json.loads(line))

# Group by session_id
from collections import defaultdict
by_session = defaultdict(list)
for e in entries:
    by_session[e['session_id']].append(e['cost_usd'])

for sid, costs in by_session.items():
    print(f'{sid[:8]}... entries={len(costs)} min={min(costs):.4f} max={max(costs):.4f}')
"
```

Expected: multi-turn sessions show `entries > 1` with `max > min` (cost grows each turn). This confirms the consumer logic (take `max` per session) is the right deduplication strategy.

- [ ] **Step 6: Commit**

```bash
git -C /home/anton.outkine/apps/pr-dash add docs/
git add /home/anton.outkine/.claude/hooks/cost-logger.py
# Note: settings.json is not committed (personal config, not repo)
git -C /home/anton.outkine/apps/pr-dash commit -m "docs: add stop-hook cost logger plan and hook script"
```

---

## What comes next (separate plan)

Once the hook is verified and accumulating data, the dashboard integration plan (`2026-06-04-ai-spend-dashboard.md`) needs one change in Task 1:

Replace `get_claude_daily_spend()` to read the per-session state files in `~/.claude/cost-state/` instead of `~/.claude/usage.db`. Each file already holds the final cumulative cost for one session, so no per-session max is needed — just sum by date:

```python
CLAUDE_COST_STATE = Path.home() / ".claude" / "cost-state"

def get_claude_daily_spend() -> dict[str, float]:
    if not CLAUDE_COST_STATE.is_dir():
        return {}
    by_date: dict[str, float] = {}
    for f in CLAUDE_COST_STATE.glob("*.json"):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            date = d.get("date", "")
            cost = float(d.get("cost_usd") or 0)
        except (json.JSONDecodeError, ValueError, OSError):
            continue
        if date:
            by_date[date] = by_date.get(date, 0.0) + cost
    return by_date
```

**Caveat:** the per-session file records the *date of the last statusline render*. A session spanning midnight attributes its whole cost to the later day — acceptable for a daily-spend dashboard.

The rest of Task 1 (Codex JSONL parsing, `/api/spend` endpoint) and Tasks 2–3 (frontend) are unchanged.

---

## Notes

- **Stop hook has no cost field** — verified empirically. Stop stdin keys: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `effort`, `hook_event_name`, `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`. The statusline input is the only source of `cost.total_cost_usd`.
- `cost.total_cost_usd` is the same value shown in the status bar — exact, not estimated
- Statusline fires on every render; the per-session file is overwritten each time (cheap, bounded). Only written when cost > 0.
- Historical sessions (before this was added) show $0 for Claude; only new sessions accumulate.
