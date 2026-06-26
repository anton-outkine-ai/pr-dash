import {
  zoom,
  zoomIdentity,
  ZoomTransform,
  type ZoomBehavior,
  type D3ZoomEvent,
} from 'd3-zoom'
import { select, type Selection } from 'd3-selection'
import type { Box } from './types'

export interface Transform {
  x: number
  y: number
  k: number
}

/** Reserved viewport edges (px) kept clear of content — e.g. the legend / minimap HUD. */
export interface Insets {
  top?: number
  right?: number
  bottom?: number
  left?: number
}

export interface CanvasController {
  /**
   * Fit the whole world bbox into the viewport with padding.
   * `insets` (when given) reserves viewport edges for HUD overlays and is
   * remembered for subsequent fits / quick-nav so content never lands under them.
   */
  zoomToFit(opts?: { animate?: boolean; insets?: Insets }): void
  /** Center & fit a sub-region (legend quick-nav flies to a territory). */
  panToBox(box: Box, opts?: { animate?: boolean }): void
  getTransform(): Transform
  /** Subscribe to transform changes (minimap viewport-rect tracks this). */
  onChange(cb: (t: Transform) => void): void
  /** Programmatically set the transform (minimap drag drives this). */
  setTransform(t: Transform, opts?: { animate?: boolean }): void
}

const SCALE_MIN = 0.1
const SCALE_MAX = 2.5
const FIT_PADDING = 48
const ANIM_MS = 320

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

const clampScale = (k: number): number =>
  Math.max(SCALE_MIN, Math.min(SCALE_MAX, k))

/** Cubic ease-in-out for the hand-rolled transform animation. */
const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

export function setupCanvas(opts: {
  viewport: HTMLElement
  world: HTMLElement
  worldBBox: Box
}): CanvasController {
  const { viewport, world, worldBBox } = opts

  const subscribers: ((t: Transform) => void)[] = []
  let anim: number | null = null
  let activeInsets: Required<Insets> = { top: 0, right: 0, bottom: 0, left: 0 }

  const selection: Selection<HTMLElement, unknown, null, undefined> =
    select(viewport)

  const zoomBehavior: ZoomBehavior<HTMLElement, unknown> = zoom<
    HTMLElement,
    unknown
  >()
    .scaleExtent([SCALE_MIN, SCALE_MAX])
    .on('zoom', (event: D3ZoomEvent<HTMLElement, unknown>) => {
      apply(event.transform)
    })

  selection.call(zoomBehavior)

  /** Write the transform to the world layer (integer-snapped) and notify. */
  function apply(t: ZoomTransform): void {
    const tx = Math.round(t.x)
    const ty = Math.round(t.y)
    world.style.transform = `translate(${tx}px, ${ty}px) scale(${t.k})`
    const snapshot: Transform = { x: t.x, y: t.y, k: t.k }
    for (const cb of subscribers) cb(snapshot)
  }

  function cancelAnim(): void {
    if (anim !== null) {
      cancelAnimationFrame(anim)
      anim = null
    }
  }

  /** Commit a target transform to d3-zoom's internal state (keeps gestures in sync). */
  function commit(target: ZoomTransform): void {
    selection.call(zoomBehavior.transform, target)
  }

  /** Set the transform, optionally animating via a rAF interpolation. */
  function go(target: ZoomTransform, animate: boolean): void {
    cancelAnim()
    if (!animate || prefersReducedMotion()) {
      commit(target)
      return
    }
    const from = currentTransform()
    const t0 = performance.now()
    const step = (now: number): void => {
      const p = Math.min(1, (now - t0) / ANIM_MS)
      const e = easeInOut(p)
      const k = from.k + (target.k - from.k) * e
      const x = from.x + (target.x - from.x) * e
      const y = from.y + (target.y - from.y) * e
      commit(new ZoomTransform(k, x, y))
      if (p < 1) {
        anim = requestAnimationFrame(step)
      } else {
        anim = null
      }
    }
    anim = requestAnimationFrame(step)
  }

  function currentTransform(): ZoomTransform {
    const node = selection.node()
    if (!node) return zoomIdentity
    return zoomTransformOf(node)
  }

  /** Read d3-zoom's stored transform off the node (avoids importing zoomTransform name twice). */
  function zoomTransformOf(node: HTMLElement): ZoomTransform {
    const stored = (node as { __zoom?: ZoomTransform }).__zoom
    return stored ?? zoomIdentity
  }

  /** Compute the transform that fits a box into the viewport's free area (minus insets). */
  function fitTransform(box: Box): ZoomTransform {
    const vw = viewport.clientWidth
    const vh = viewport.clientHeight
    const bw = Math.max(box.w, 1)
    const bh = Math.max(box.h, 1)
    // Free area = viewport minus reserved HUD insets, minus symmetric padding.
    const availW = Math.max(
      vw - activeInsets.left - activeInsets.right - FIT_PADDING * 2,
      1,
    )
    const availH = Math.max(
      vh - activeInsets.top - activeInsets.bottom - FIT_PADDING * 2,
      1,
    )
    const k = clampScale(Math.min(availW / bw, availH / bh))
    // Center the box within the free area (not the whole viewport).
    const cx = box.x + bw / 2
    const cy = box.y + bh / 2
    const ax = activeInsets.left + FIT_PADDING + availW / 2
    const ay = activeInsets.top + FIT_PADDING + availH / 2
    const x = ax - cx * k
    const y = ay - cy * k
    return new ZoomTransform(k, x, y)
  }

  return {
    zoomToFit(o) {
      if (o?.insets) {
        activeInsets = {
          top: o.insets.top ?? 0,
          right: o.insets.right ?? 0,
          bottom: o.insets.bottom ?? 0,
          left: o.insets.left ?? 0,
        }
      }
      go(fitTransform(worldBBox), o?.animate ?? false)
    },
    panToBox(box, o) {
      go(fitTransform(box), o?.animate ?? true)
    },
    getTransform() {
      const t = currentTransform()
      return { x: t.x, y: t.y, k: t.k }
    },
    onChange(cb) {
      subscribers.push(cb)
    },
    setTransform(t, o) {
      go(new ZoomTransform(clampScale(t.k), t.x, t.y), o?.animate ?? false)
    },
  }
}
