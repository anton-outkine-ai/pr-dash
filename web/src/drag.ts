import type { CanvasController } from './canvas'
import { saveOrigins } from './positions'

/**
 * Wire up header-drag for each territory. Dragging a `.territory-header`
 * translates all elements of that repo in world px; the ancestor `scale(k)`
 * handles zoom, so we divide screen deltas by `k`.
 *
 * Note: headers should set `touch-action: none` in CSS so touch drags don't
 * scroll the page (CSS handled elsewhere).
 */
export function setupDrag(opts: {
  world: HTMLElement
  controller: CanvasController
  stableOrigins: Map<string, { x: number; y: number }>
  onDrop: () => void
}): void {
  const { world, controller, stableOrigins, onDrop } = opts

  for (const header of world.querySelectorAll<HTMLElement>('.territory-header')) {
    header.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()

      const repo = header.dataset.repo
      if (!repo) return

      const startX = e.clientX
      const startY = e.clientY
      const k = controller.getTransform().k
      const startOrigin = stableOrigins.get(repo) ?? { x: 0, y: 0 }

      header.classList.add('dragging')
      let moved = false

      // Mirror d3's window pattern (no pointer capture): collect repo els once.
      const els = Array.from(
        world.querySelectorAll<HTMLElement | SVGElement>(
          '[data-repo="' + CSS.escape(repo) + '"]',
        ),
      )

      let dx = 0
      let dy = 0

      const onMove = (ev: MouseEvent): void => {
        dx = (ev.clientX - startX) / k
        dy = (ev.clientY - startY) / k
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 3) moved = true
        for (const el of els) {
          el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'
        }
      }

      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        header.classList.remove('dragging')

        if (!moved) {
          // Treat as a click: undo any transient transform, no save/relayout.
          for (const el of els) el.style.transform = ''
          return
        }

        const newOrigin = { x: startOrigin.x + dx, y: startOrigin.y + dy }
        // Pin every territory at its current position so unpinned repos never
        // reflow when one is dragged. The dragged repo takes its new origin;
        // everyone else keeps exactly where they currently sit.
        const origins = new Map(stableOrigins)
        origins.set(repo, newOrigin)
        saveOrigins(origins)
        // onDrop relayouts + rerenders, rebuilding els and clearing transient
        // transforms — so we deliberately don't clear them here.
        onDrop()
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    })
  }
}
