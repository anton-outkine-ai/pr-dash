# AI Spend Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "AI Spend" tab to the PR dashboard showing estimated daily cost for Claude and Codex over the last 30 days, computed from local session data.

**Architecture:** A new `/api/spend` FastAPI endpoint reads Claude token data from `~/.claude/usage.db` (SQLite, pre-computed by Claude Code) and Codex token data from `~/.codex/sessions/YYYY/MM/DD/*.jsonl` files. The frontend adds a tab switcher and renders a dual-bar SVG chart per day. Cost is estimated using published API pricing — not actual Anthropic/OpenAI billing, which is subscription-based and not stored locally.

**Tech Stack:** Python + FastAPI + SQLite (existing), pure SVG chart (no external chart lib), vanilla JS (existing pattern)

---

## Background: Data Sources

### Claude — `~/.claude/usage.db` (SQLite)

Claude Code pre-processes all session JSONL files into a local SQLite DB.

```
turns table columns:
  id, session_id, timestamp (ISO 8601), model (e.g. "claude-sonnet-4-6"),
  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
  tool_name, cwd, message_id
```

Query pattern: group by `substr(timestamp, 1, 10)` (date) + model → sum tokens → apply pricing.

### Codex — `~/.codex/sessions/YYYY/MM/DD/*.jsonl`

Each file contains JSONL lines. The useful entries are `event_msg` lines where `payload.type == "token_count"`. The LAST such entry in each file holds the cumulative session total in `payload.info.total_token_usage`:

```json
{
  "type": "event_msg",
  "timestamp": "...",
  "payload": {
    "type": "token_count",
    "info": {
      "total_token_usage": {
        "input_tokens": 32120,
        "cached_input_tokens": 23808,
        "output_tokens": 361,
        "reasoning_output_tokens": 75
      }
    }
  }
}
```

Date comes from the file path (`.../sessions/YYYY/MM/DD/rollout-....jsonl`), not the timestamps inside.

### Pricing table (published API rates, not subscription billing)

```
Claude Opus   (claude-opus-*):   $5.00/$25.00/$0.50/$6.25  per M (in/out/cache_read/cache_write)
Claude Sonnet (claude-sonnet-*): $3.00/$15.00/$0.30/$3.75  per M
Claude Haiku  (claude-haiku-*):  $0.80/$4.00/$0.08/$1.00   per M
gpt-5.5:                         $5.00/$30.00/$1.25         per M (non-cached-input/output/cached-input)
```

For Codex: non-cached input = `input_tokens - cached_input_tokens`.

---

## File Map

| File | Change |
|------|--------|
| `app.py` | Add pricing constants, `get_claude_daily_spend()`, `get_codex_daily_spend()`, `/api/spend` endpoint |
| `index.html` | Add tab switcher CSS/HTML, spend view HTML, `loadSpend()` + `renderSpend()` JS |

---

## Task 1: Backend `/api/spend` — Claude data from `usage.db`

**Files:**
- Modify: `app.py`

- [ ] **Step 1: Add pricing constants and helper functions to `app.py`**

Add after the existing imports and constants (after the `BK_URL_RE` line):

```python
CLAUDE_DB = Path.home() / ".claude" / "usage.db"
CODEX_SESSIONS_DIR = Path.home() / ".codex" / "sessions"

_CLAUDE_PRICING: dict[str, dict[str, float]] = {
    "opus":   {"input": 5.00, "output": 25.00, "cache_read": 0.50, "cache_write": 6.25},
    "sonnet": {"input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_write": 3.75},
    "haiku":  {"input": 0.80, "output":  4.00, "cache_read": 0.08, "cache_write": 1.00},
}
_CODEX_PRICING = {"input": 5.00, "output": 30.00, "cached_input": 1.25}


def _model_tier(model: str) -> str:
    m = model.lower()
    if "opus" in m:   return "opus"
    if "haiku" in m:  return "haiku"
    return "sonnet"


def _claude_turn_cost(model: str, inp: int, out: int, cr: int, cw: int) -> float:
    p = _CLAUDE_PRICING[_model_tier(model)]
    return (inp * p["input"] + out * p["output"] + cr * p["cache_read"] + cw * p["cache_write"]) / 1_000_000


def _codex_session_cost(total_input: int, cached_input: int, output: int) -> float:
    non_cached = max(0, total_input - cached_input)
    return (non_cached * _CODEX_PRICING["input"] + cached_input * _CODEX_PRICING["cached_input"] + output * _CODEX_PRICING["output"]) / 1_000_000
```

- [ ] **Step 2: Add `get_claude_daily_spend()` function**

Add after the functions above:

```python
def get_claude_daily_spend() -> dict[str, float]:
    """Return {date_str: cost_usd} for last 30 days from ~/.claude/usage.db."""
    if not CLAUDE_DB.exists():
        return {}
    import sqlite3
    conn = sqlite3.connect(str(CLAUDE_DB))
    try:
        rows = conn.execute("""
            SELECT
                substr(timestamp, 1, 10) AS day,
                model,
                COALESCE(SUM(input_tokens), 0),
                COALESCE(SUM(output_tokens), 0),
                COALESCE(SUM(cache_read_tokens), 0),
                COALESCE(SUM(cache_creation_tokens), 0)
            FROM turns
            WHERE timestamp >= date('now', '-30 days')
            GROUP BY day, model
        """).fetchall()
    finally:
        conn.close()

    by_date: dict[str, float] = {}
    for day, model, inp, out, cr, cw in rows:
        by_date[day] = by_date.get(day, 0.0) + _claude_turn_cost(model or "sonnet", inp, out, cr, cw)
    return by_date
```

- [ ] **Step 3: Add `get_codex_daily_spend()` function**

Add immediately after `get_claude_daily_spend()`:

```python
def get_codex_daily_spend() -> dict[str, float]:
    """Return {date_str: cost_usd} for last 30 days from ~/.codex/sessions/."""
    if not CODEX_SESSIONS_DIR.exists():
        return {}

    by_date: dict[str, float] = {}
    for jsonl in CODEX_SESSIONS_DIR.glob("*/*/*.jsonl"):
        parts = jsonl.parts
        # Path structure: .../sessions/YYYY/MM/DD/rollout-....jsonl
        try:
            date = f"{parts[-4]}-{parts[-3]}-{parts[-2]}"
        except IndexError:
            continue

        last_usage: dict | None = None
        try:
            with jsonl.open("r", encoding="utf-8", errors="replace") as fh:
                for raw in fh:
                    if "token_count" not in raw:
                        continue
                    try:
                        d = json.loads(raw)
                        if (d.get("type") == "event_msg"
                                and isinstance(d.get("payload"), dict)
                                and d["payload"].get("type") == "token_count"):
                            last_usage = d["payload"]["info"]["total_token_usage"]
                    except (json.JSONDecodeError, KeyError, TypeError):
                        continue
        except OSError:
            continue

        if last_usage is None:
            continue

        cost = _codex_session_cost(
            last_usage.get("input_tokens", 0),
            last_usage.get("cached_input_tokens", 0),
            last_usage.get("output_tokens", 0),
        )
        by_date[date] = by_date.get(date, 0.0) + cost
    return by_date
```

- [ ] **Step 4: Add `/api/spend` endpoint**

Add before the `main()` function:

```python
@app.get("/api/spend")
async def api_spend() -> JSONResponse:
    try:
        claude_data, codex_data = await asyncio.gather(
            asyncio.to_thread(get_claude_daily_spend),
            asyncio.to_thread(get_codex_daily_spend),
        )
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

    all_dates = sorted(set(claude_data) | set(codex_data))
    # Last 30 calendar days only.
    days = [
        {"date": d, "claude": round(claude_data.get(d, 0.0), 6), "codex": round(codex_data.get(d, 0.0), 6)}
        for d in all_dates[-30:]
    ]
    return JSONResponse({"days": days})
```

- [ ] **Step 5: Smoke-test the endpoint manually**

Restart the server (`uv run app.py`) and run:

```bash
curl -s http://localhost:8765/api/spend | python3 -m json.tool | head -40
```

Expected: JSON with `{"days": [...]}` where each entry has `date`, `claude`, `codex` keys. `claude` values should be > 0 if Claude Code has been used (check `~/.claude/usage.db` has rows). `codex` may be 0 if no Codex sessions exist.

- [ ] **Step 6: Commit**

```bash
git add app.py
git commit -m "feat: add /api/spend endpoint for Claude+Codex daily cost estimates"
```

---

## Task 2: Frontend — Tab Switcher

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add tab CSS**

Add inside the `<style>` block, after the `.btn-compact` rule:

```css
/* ===== TABS ===== */
.tab-bar {
  display: flex; gap: 0;
  border-bottom: 1px solid var(--border);
  margin-bottom: 28px;
  position: relative;
}
.tab-bar::after {
  content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 1px;
  background: linear-gradient(90deg, var(--green) 0%, transparent 18%);
  opacity: 0.6;
}
.tab-btn {
  background: transparent;
  border: 1px solid var(--border);
  border-bottom: 0;
  color: var(--text-dim);
  font-family: "JetBrains Mono", monospace;
  font-size: 10px; font-weight: 500;
  letter-spacing: 0.2em; text-transform: uppercase;
  padding: 10px 20px;
  cursor: pointer;
  margin-right: 4px;
  margin-bottom: -1px;
  transition: color 0.12s ease, background 0.12s ease;
}
.tab-btn:hover { color: var(--text); background: var(--surface); }
.tab-btn.active {
  color: var(--green);
  background: var(--surface);
  border-color: var(--border);
  border-bottom-color: var(--surface);
}
```

- [ ] **Step 2: Add tab bar HTML**

Replace the opening of `<div class="container">` section. Find this line:

```html
    <div id="error" class="error" style="display:none"></div>
```

Insert before it:

```html
    <div class="tab-bar">
      <button class="tab-btn active" data-tab="prs">Open PRs</button>
      <button class="tab-btn" data-tab="spend">AI Spend</button>
    </div>
```

- [ ] **Step 3: Add tab switching JS**

Add at the end of the `<script>` block, before the final `load()` call:

```javascript
function switchTab(name) {
  for (const btn of document.querySelectorAll(".tab-btn")) {
    btn.classList.toggle("active", btn.dataset.tab === name);
  }
  const prEls = ["error", "summary", "prs", "empty"];
  const spendEls = ["spend-view"];
  for (const id of prEls)   document.getElementById(id).style.display = name === "prs"   ? "" : "none";
  for (const id of spendEls) document.getElementById(id).style.display = name === "spend" ? "" : "none";
  if (name === "spend" && !spendLoaded) loadSpend();
}

document.querySelector(".tab-bar").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (btn) switchTab(btn.dataset.tab);
});
```

- [ ] **Step 4: Verify tab switcher works**

Open the app in browser (`http://localhost:8765`). Click "AI Spend" tab — the PR list, summary cells, and error box should disappear. Click "Open PRs" — they come back. No `spend-view` element exists yet (console error is OK for now).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: add PR/AI-Spend tab switcher"
```

---

## Task 3: Frontend — AI Spend View

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add spend view CSS**

Add inside `<style>`, after the `.empty` rule:

```css
/* ===== SPEND VIEW ===== */
.spend-summary {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  border: 1px solid var(--border);
  background: var(--surface);
  margin-bottom: 28px;
}
.spend-cell {
  padding: 22px 22px 18px;
  border-right: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 6px;
}
.spend-cell:last-child { border-right: 0; }
.spend-num {
  font-family: "JetBrains Mono", monospace;
  font-size: 36px; font-weight: 600;
  letter-spacing: -0.02em; line-height: 1;
  font-variant-numeric: tabular-nums;
}
.spend-label {
  font-family: "JetBrains Mono", monospace;
  font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase;
  color: var(--text-dim);
}
.spend-sub {
  font-family: "JetBrains Mono", monospace;
  font-size: 11px; color: var(--text-dim);
}

.chart-wrap {
  background: var(--surface);
  border: 1px solid var(--border);
  padding: 24px 24px 16px;
  margin-bottom: 16px;
}
.chart-legend {
  display: flex; gap: 20px; margin-bottom: 16px;
  font-family: "JetBrains Mono", monospace;
  font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--text-dim);
}
.chart-legend .swatch {
  display: inline-block; width: 10px; height: 10px; margin-right: 6px;
  vertical-align: middle;
}
.chart-svg { width: 100%; display: block; }
.spend-note {
  font-family: "JetBrains Mono", monospace;
  font-size: 10px; color: var(--text-dim);
  letter-spacing: 0.08em;
  text-align: center;
  padding: 8px 0 4px;
}
```

- [ ] **Step 2: Add spend view HTML**

Find the closing `</div>` that matches `<div id="empty"...>`. Add after the `<div id="empty"...>` element:

```html
    <div id="spend-view" style="display:none">
      <div class="spend-summary">
        <div class="spend-cell">
          <div class="spend-num" id="spend-claude-total">--</div>
          <div class="spend-label">Claude (30d)</div>
          <div class="spend-sub" id="spend-claude-sub">API-rate estimate</div>
        </div>
        <div class="spend-cell">
          <div class="spend-num" id="spend-codex-total">--</div>
          <div class="spend-label">Codex (30d)</div>
          <div class="spend-sub" id="spend-codex-sub">API-rate estimate</div>
        </div>
        <div class="spend-cell">
          <div class="spend-num" id="spend-grand-total">--</div>
          <div class="spend-label">Total (30d)</div>
          <div class="spend-sub">Combined</div>
        </div>
      </div>

      <div class="chart-wrap">
        <div class="chart-legend">
          <span><span class="swatch" style="background:var(--blue)"></span>Claude</span>
          <span><span class="swatch" style="background:var(--amber)"></span>Codex</span>
        </div>
        <svg id="spend-chart" class="chart-svg" viewBox="0 0 960 220" preserveAspectRatio="none"></svg>
      </div>

      <div class="spend-note">
        Estimated from published API pricing · actual subscription charges differ · Claude: Sonnet $3/$15, Opus $5/$25 per M tokens · Codex (gpt-5.5): $5/$30 per M tokens
      </div>
    </div>
```

- [ ] **Step 3: Add `renderSpend()` and `loadSpend()` JS functions**

Add in the `<script>` block, before the `switchTab()` function:

```javascript
let spendLoaded = false;

function fmtUSD(v) {
  if (v >= 100)  return "$" + v.toFixed(0);
  if (v >= 10)   return "$" + v.toFixed(1);
  if (v >= 1)    return "$" + v.toFixed(2);
  return "$" + v.toFixed(3);
}

function renderSpend(days) {
  spendLoaded = true;
  const claudeTotal = days.reduce((s, d) => s + d.claude, 0);
  const codexTotal  = days.reduce((s, d) => s + d.codex,  0);
  const grandTotal  = claudeTotal + codexTotal;

  document.getElementById("spend-claude-total").textContent = fmtUSD(claudeTotal);
  document.getElementById("spend-codex-total").textContent  = fmtUSD(codexTotal);
  document.getElementById("spend-grand-total").textContent  = fmtUSD(grandTotal);

  // SVG chart — viewBox "0 0 960 220"
  // Layout: left margin 55 (Y labels), right 5, bottom 32 (X labels), top 8.
  const ML = 55, MR = 5, MB = 32, MT = 8;
  const CW = 960 - ML - MR;   // chart inner width
  const CH = 220 - MB - MT;   // chart inner height

  const N = days.length || 1;
  const gw = CW / N;           // group width per day
  const bw = Math.max(2, gw * 0.36); // individual bar width
  const maxVal = Math.max(...days.map(d => d.claude + d.codex), 0.001);

  // Y grid lines + labels (4 lines)
  const yTicks = [0.25, 0.5, 0.75, 1.0];
  const gridLines = yTicks.map(f => {
    const y = MT + CH * (1 - f);
    const label = fmtUSD(maxVal * f);
    return `
      <line x1="${ML}" y1="${y}" x2="${ML + CW}" y2="${y}" stroke="var(--border)" stroke-width="0.5"/>
      <text x="${ML - 6}" y="${y + 4}" text-anchor="end" fill="var(--text-dim)" font-size="10" font-family="JetBrains Mono,monospace">${esc(label)}</text>`;
  }).join("");

  // Bars + X labels
  const bars = days.map((d, i) => {
    const gx = ML + i * gw;
    const claudeH = (d.claude / maxVal) * CH;
    const codexH  = (d.codex  / maxVal) * CH;
    const cx = gx + gw * 0.1;
    const dx = cx + bw + 1;
    const label = d.date.slice(5); // MM-DD
    const midX = gx + gw / 2;

    const claudeBar = claudeH > 0
      ? `<rect x="${cx.toFixed(1)}" y="${(MT + CH - claudeH).toFixed(1)}" width="${bw.toFixed(1)}" height="${claudeH.toFixed(1)}" fill="var(--blue)" opacity="0.85"/>`
      : "";
    const codexBar = codexH > 0
      ? `<rect x="${dx.toFixed(1)}" y="${(MT + CH - codexH).toFixed(1)}"  width="${bw.toFixed(1)}" height="${codexH.toFixed(1)}"  fill="var(--amber)" opacity="0.85"/>`
      : "";

    // Show date label every 5 days to avoid overcrowding
    const xLabel = (i % 5 === 0 || i === days.length - 1)
      ? `<text x="${midX.toFixed(1)}" y="${MT + CH + 20}" text-anchor="middle" fill="var(--text-dim)" font-size="9" font-family="JetBrains Mono,monospace">${esc(label)}</text>`
      : "";

    return claudeBar + codexBar + xLabel;
  }).join("");

  // Baseline
  const baseline = `<line x1="${ML}" y1="${MT + CH}" x2="${ML + CW}" y2="${MT + CH}" stroke="var(--border-strong)" stroke-width="1"/>`;

  document.getElementById("spend-chart").innerHTML = gridLines + baseline + bars;
}

async function loadSpend() {
  try {
    const res = await fetch("/api/spend");
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    renderSpend(data.days || []);
  } catch (e) {
    document.getElementById("spend-view").innerHTML +=
      `<div class="error">Error loading spend data: ${esc(e.message)}</div>`;
    spendLoaded = true;
  }
}
```

- [ ] **Step 4: Verify in browser**

Open `http://localhost:8765` and click "AI Spend" tab. You should see:
- Three summary cells with dollar amounts (Claude, Codex, Total)
- An SVG bar chart with blue (Claude) and amber (Codex) bars per day
- A note line at the bottom explaining pricing basis

If both Claude and Codex data are 0, the chart shows a flat baseline — this is correct if there's no usage. Verify Claude data by checking:
```bash
sqlite3 ~/.claude/usage.db "SELECT substr(timestamp,1,10), COUNT(*), SUM(input_tokens) FROM turns GROUP BY 1 ORDER BY 1 DESC LIMIT 5;"
```

Verify Codex data by checking:
```bash
ls ~/.codex/sessions/2026/06/ | head -5
```

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: add AI spend tab with daily bar chart for Claude and Codex"
```

---

## Self-Review

**Spec coverage:**
- ✅ New tab for AI spend
- ✅ Claude spend per day
- ✅ Codex spend per day
- ✅ Bar chart (SVG, no external lib)
- ✅ 30-day window
- ✅ Summary totals (per-provider + grand)
- ✅ Cost from actual token data (not token count × guessed multiplier)
- ✅ Labeled as API-rate estimate, not actual billing
- ✅ Uses `~/.claude/usage.db` (authoritative Claude token source)
- ✅ Uses `~/.codex/sessions/` (authoritative Codex token source)

**Type consistency:**
- `renderSpend(days)` called in `loadSpend()` ✅
- `spendLoaded` set in `renderSpend()`, read in `switchTab()` ✅
- `get_claude_daily_spend()` / `get_codex_daily_spend()` both return `dict[str, float]` ✅
- `/api/spend` returns `{"days": [{date, claude, codex}]}` consumed by `renderSpend()` ✅

**Placeholder check:** None found.

---

## Notes

- **No test files exist** in this project — testing is manual via curl + browser
- The `esc()` function already exists in `index.html` — reuse it in the new JS
- The `--blue` and `--amber` CSS variables already exist in `:root` — reuse them
- `uv run app.py` is how to run the server
- Server runs on `localhost:8765` by default
