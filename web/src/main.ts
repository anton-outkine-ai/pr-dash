import './styles/tokens.css'
import './styles/app.css'
import './styles/canvas.css'

import { fetchPRs } from './data'
import { buildForest } from './forest'
import { buildStatusMap } from './status'
import { computeLayout } from './layout'
import { renderWorld, measureHeights } from './render'
import { initTheme, createThemeToggle } from './theme'
import { setupCanvas, type CanvasController } from './canvas'
import { setupMinimap, setupLegend } from './minimap'
import { createRefetchButton } from './refetch'
import { loadOrigins } from './positions'
import { setupDrag } from './drag'
import type { PR } from './types'

initTheme()

const app = document.querySelector<HTMLDivElement>('#app')!

// Persistent chrome — created once, never torn down.
const refetchBtn = createRefetchButton(() => void refetch())
app.append(createThemeToggle(), refetchBtn.el)

// Module-level controller ref for camera preservation.
let controller: CanvasController | null = null

// Last rendered PR set, so a drop can relayout/rerender without a refetch.
let lastPRs: PR[] = []

// Previous normalization offset, for camera compensation across relayouts.
let prevOffset = { x: 0, y: 0 }

// Guard against concurrent refetches.
let fetching = false

function showMessage(text: string): void {
  const el = document.createElement('div')
  el.className = 'overlay-message'
  el.textContent = text
  el.style.cssText =
    'position:absolute;inset:0;display:grid;place-items:center;' +
    'font-family:var(--font-display);font-size:20px;color:var(--text-dim);'
  app.append(el)
}

function showToast(text: string): void {
  // Remove any existing toast first.
  app.querySelector('.toast')?.remove()

  const toast = document.createElement('div')
  toast.className = 'toast'
  toast.textContent = text
  app.append(toast)

  setTimeout(() => {
    // Guard: only remove if it's still the same element.
    if (toast.isConnected) toast.remove()
  }, 4000)
}

function render(prs: PR[], opts: { preserveCamera?: boolean } = {}): void {
  lastPRs = prs

  // 1. Capture previous transform before teardown.
  const prev = controller?.getTransform() ?? null

  // 2. Remove existing viewport and overlay-message from app.
  app.querySelector('.viewport')?.remove()
  app.querySelector('.overlay-message')?.remove()

  // 3. Pipeline.
  const territories = buildForest(prs)
  const statuses = buildStatusMap(territories)
  const heights = measureHeights(territories)
  const pinned = loadOrigins()
  const layout = computeLayout(territories, heights, pinned)

  // 4. Empty state.
  if (layout.nodes.length === 0) {
    showMessage('No open PRs.')
    controller = null
    prevOffset = layout.offset
    return
  }

  // 5. Build fresh viewport DOM.
  const viewport = document.createElement('div')
  viewport.className = 'viewport'

  const canvas = document.createElement('div')
  canvas.className = 'canvas'

  const world = document.createElement('div')
  world.id = 'world'

  const svgNS = 'http://www.w3.org/2000/svg'
  const spines = document.createElementNS(svgNS, 'svg') as SVGSVGElement
  spines.id = 'spines'

  world.append(spines)
  viewport.append(canvas, world)

  renderWorld({ world, svg: spines, territories, layout, statuses })
  controller = setupCanvas({ viewport, world, worldBBox: layout.bbox })
  setupMinimap({ parent: viewport, layout, worldBBox: layout.bbox, canvas: controller, viewport })
  setupLegend({ parent: viewport, territories, layout, canvas: controller })
  setupDrag({
    world,
    controller,
    stableOrigins: layout.stableOrigins,
    onDrop: () => render(lastPRs, { preserveCamera: true }),
  })

  app.append(viewport)

  // 6. Camera.
  if (opts.preserveCamera && prev) {
    // Compensate for any change in the normalization offset so non-dragged
    // territories stay visually fixed. (screen = worldNorm*k + cam, with
    // worldNorm = stable - offset ⇒ hold screen by cam += Δoffset*k.)
    const off = layout.offset
    prev.x += (off.x - prevOffset.x) * prev.k
    prev.y += (off.y - prevOffset.y) * prev.k
    controller.setTransform(prev)
  } else {
    const legendW = viewport.querySelector('.legend')?.getBoundingClientRect().width ?? 0
    const minimapW = viewport.querySelector('.minimap')?.getBoundingClientRect().width ?? 0
    controller.zoomToFit({ insets: { right: Math.max(legendW, minimapW) + 24 } })
  }

  prevOffset = layout.offset
}

async function refetch(): Promise<void> {
  if (fetching) return
  fetching = true
  refetchBtn.setFetching(true)
  try {
    const prs = await fetchPRs()
    render(prs, { preserveCamera: true })
  } catch (e) {
    showToast(`Refetch failed: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    refetchBtn.setFetching(false)
    fetching = false
  }
}

// `r` keybinding — triggers refetch without modifier keys, not in editable fields.
window.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() !== 'r') return
  if (event.ctrlKey || event.metaKey || event.altKey) return
  if (event.repeat) return
  const target = event.target as HTMLElement
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
  if (target.isContentEditable) return
  void refetch()
})

async function boot(): Promise<void> {
  let prs: PR[]
  try {
    prs = await fetchPRs()
  } catch (e) {
    showMessage(`Failed to load PRs: ${e instanceof Error ? e.message : String(e)}`)
    return
  }
  render(prs, { preserveCamera: false })
}

void boot()
