# PR-Dash Refetch — Design

Date: 2026-06-26

## Goal

Let the user re-run the `gh`/`bk` fetch and rebuild the dashboard on demand, via
a keybinding and a button, with a visible "fetching" indicator — without
reloading the page.

## Background

- Backend `/api/prs` (`app.py`) always runs `gh search prs` → `gh pr view`
  fan-out + `bk build view` fresh on every request. **No server-side cache** —
  "refetch" is simply re-calling `/api/prs`.
- Frontend (`web/src`) is a Vite/TS canvas app. `main.ts`'s `boot()` runs the
  pipeline once: `fetchPRs` → `buildForest` → `buildStatusMap` → `measureHeights`
  → `computeLayout` → `renderWorld` + `setupCanvas`/`setupMinimap`/`setupLegend`.
- `renderWorld` is already idempotent (clears prior children).
- Constraint: `setupCanvas` captures `worldBBox` in a closure `const`, and
  `onChange` has no unsubscribe. Rebuilding the HUD piecemeal each refetch would
  leak subscribers and leave the canvas with stale bounds. The design avoids
  this by **rebuilding the whole viewport** rather than patching it.

## Approach

### Chrome vs. viewport split (`main.ts`)

- **Persistent chrome**, created once and never torn down: theme toggle + new
  refetch button. The refetch button owns the fetching state.
- **Disposable viewport**, rebuilt on every load: extract
  `render(prs, { preserveCamera })`. It removes the existing `.viewport` element,
  builds a fresh one (world + spines → `renderWorld` → `setupCanvas` →
  `setupMinimap` → `setupLegend`), and appends it.

Removing the old `.viewport` DOM drops its d3-zoom listeners and HUD panels, and
lets the old `CanvasController` (with its subscriber array) get garbage
collected. Result: zero listener leaks, **no changes to `canvas.ts`**.

### Camera preservation

`render` keeps a module-level reference to the current controller. Before
teardown, capture `controller.getTransform()`. After rebuild:
- first load (`preserveCamera` false) → `zoomToFit` (current behavior, incl. HUD
  inset reservation),
- refetch (`preserveCamera` true) → `setTransform(prev)` so the view does not jump.

### Refetch control (`refetch.ts`, mirrors `theme.ts`)

`createRefetchButton(onRefetch)` returns `{ el, setFetching(bool) }`:
- Circular ⟳ button, fixed top-right, positioned left of the theme toggle.
- `setFetching(true)` → `disabled` + `is-fetching` class (CSS spins the ⟳).
- Click while already fetching is ignored (guarded by the disabled state).

### Keybinding `r`

Window `keydown` listener triggers refetch when:
- key is `r` (case-insensitive),
- no `Ctrl`/`Meta`/`Alt` modifier (so browser Cmd/Ctrl+R full reload still works),
- not an auto-repeat (`event.repeat`),
- focus is not in an `input`/`textarea`/`contenteditable`.

### Refetch orchestration

A single `refetch()` async function:
1. If already fetching, return.
2. `setFetching(true)`.
3. `await fetchPRs()`.
4. On success → `render(prs, { preserveCamera: true })`.
5. On failure → keep the current view, show a brief auto-dismiss toast.
6. `finally` → `setFetching(false)`.

Both the button click and the `r` key call `refetch()`.

### Error handling

- **Refetch failure:** current view stays intact (no teardown happens before
  fetch resolves). Show a transient toast (auto-dismiss ~4s).
- **First-load failure:** unchanged — existing `showMessage` overlay.

## Files touched

- `web/src/main.ts` — split chrome/viewport, `render(prs, opts)`, `refetch()`,
  `r` keybinding.
- `web/src/refetch.ts` — **new**; `createRefetchButton`.
- `web/src/styles/app.css` — `.refetch-btn` (reusing `.theme-toggle` look),
  `@keyframes spin` for `.is-fetching`, toast styles.
- No backend change.

## Verification

- `npm run build` (`tsc --noEmit && vite build`) passes.
- Run `uv run app.py`, load the dashboard:
  - ⟳ button visible top-right next to theme toggle.
  - Press `r` / click ⟳ → button spins + disables, network hits `/api/prs`,
    view rebuilds, spinner stops.
  - Pan/zoom, then refetch → camera unchanged.
  - Cmd/Ctrl+R still triggers a normal browser reload.

## Out of scope

- Auto-refresh / polling on a timer.
- Per-PR refetch.
- Backend caching.
