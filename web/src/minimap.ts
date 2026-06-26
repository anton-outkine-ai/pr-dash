import type { Layout, Territory, Box } from './types'
import type { CanvasController, Transform } from './canvas'
import { repoColor } from './repo-color'

/** Target longest-edge size of the minimap content in px. */
const MINIMAP_MAX = 200

function setRepoShades(el: HTMLElement, repo: string): void {
  const color = repoColor(repo)
  el.style.setProperty('--repo-light', color.light)
  el.style.setProperty('--repo-dark', color.dark)
}

/** Union the layout nodes whose pr.repo matches into one bounding box. */
function territoryBox(layout: Layout, repo: string): Box | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of layout.nodes) {
    if (n.pr.repo !== repo) continue
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + n.w)
    maxY = Math.max(maxY, n.y + n.h)
  }
  if (!isFinite(minX)) return null
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function setupMinimap(opts: {
  parent: HTMLElement
  layout: Layout
  worldBBox: Box
  canvas: CanvasController
  viewport: HTMLElement
}): void {
  const { parent, layout, worldBBox, canvas, viewport } = opts

  // Scale factor maps world coords → minimap coords (fit longest edge to MINIMAP_MAX).
  const worldW = Math.max(worldBBox.w, 1)
  const worldH = Math.max(worldBBox.h, 1)
  const scale = MINIMAP_MAX / Math.max(worldW, worldH)
  const mmW = worldW * scale
  const mmH = worldH * scale

  const panel = document.createElement('div')
  panel.className = 'minimap'
  panel.style.width = `${mmW}px`
  panel.style.height = `${mmH}px`

  // One rect per card, tinted by repo color.
  for (const node of layout.nodes) {
    const rect = document.createElement('div')
    rect.className = 'minimap-rect'
    rect.style.left = `${(node.x - worldBBox.x) * scale}px`
    rect.style.top = `${(node.y - worldBBox.y) * scale}px`
    rect.style.width = `${node.w * scale}px`
    rect.style.height = `${node.h * scale}px`
    setRepoShades(rect, node.pr.repo)
    panel.appendChild(rect)
  }

  // Viewport rectangle: reflects the current canvas transform.
  const vpRect = document.createElement('div')
  vpRect.className = 'minimap-viewport'
  panel.appendChild(vpRect)

  parent.appendChild(panel)

  function syncViewport(t: Transform): void {
    // World coords currently visible = invert of the screen viewport corners.
    const vw = viewport.clientWidth
    const vh = viewport.clientHeight
    const worldLeft = (0 - t.x) / t.k
    const worldTop = (0 - t.y) / t.k
    const worldVW = vw / t.k
    const worldVH = vh / t.k
    vpRect.style.left = `${(worldLeft - worldBBox.x) * scale}px`
    vpRect.style.top = `${(worldTop - worldBBox.y) * scale}px`
    vpRect.style.width = `${worldVW * scale}px`
    vpRect.style.height = `${worldVH * scale}px`
  }

  canvas.onChange(syncViewport)
  // Initial sync from whatever the canvas currently holds.
  syncViewport(canvas.getTransform())

  /** Recenter the canvas on the world point under a minimap pointer event. */
  function recenter(ev: PointerEvent): void {
    const r = panel.getBoundingClientRect()
    const mmX = ev.clientX - r.left
    const mmY = ev.clientY - r.top
    // Minimap point → world point.
    const worldX = worldBBox.x + mmX / scale
    const worldY = worldBBox.y + mmY / scale
    const t = canvas.getTransform()
    const vw = viewport.clientWidth
    const vh = viewport.clientHeight
    // Keep current zoom; translate so the world point sits at viewport center.
    const x = vw / 2 - worldX * t.k
    const y = vh / 2 - worldY * t.k
    canvas.setTransform({ x, y, k: t.k })
  }

  let dragging = false
  panel.addEventListener('pointerdown', (ev) => {
    dragging = true
    panel.setPointerCapture(ev.pointerId)
    recenter(ev)
  })
  panel.addEventListener('pointermove', (ev) => {
    if (dragging) recenter(ev)
  })
  const endDrag = (ev: PointerEvent): void => {
    if (!dragging) return
    dragging = false
    if (panel.hasPointerCapture(ev.pointerId)) {
      panel.releasePointerCapture(ev.pointerId)
    }
  }
  panel.addEventListener('pointerup', endDrag)
  panel.addEventListener('pointercancel', endDrag)
}

export function setupLegend(opts: {
  parent: HTMLElement
  territories: Territory[]
  layout: Layout
  canvas: CanvasController
}): void {
  const { parent, territories, layout, canvas } = opts

  const panel = document.createElement('div')
  panel.className = 'legend'

  const fitBtn = document.createElement('button')
  fitBtn.type = 'button'
  fitBtn.className = 'fit-btn'
  fitBtn.textContent = 'Fit'
  fitBtn.addEventListener('click', () => canvas.zoomToFit({ animate: true }))
  panel.appendChild(fitBtn)

  for (const territory of territories) {
    const box = territoryBox(layout, territory.repo)
    if (!box) continue

    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'legend-item'

    const dot = document.createElement('span')
    dot.className = 'legend-dot'
    setRepoShades(dot, territory.repo)

    const label = document.createElement('span')
    label.className = 'legend-label'
    label.textContent = territory.repo

    item.append(dot, label)
    item.addEventListener('click', () =>
      canvas.panToBox(box, { animate: true }),
    )
    panel.appendChild(item)
  }

  parent.appendChild(panel)
}
