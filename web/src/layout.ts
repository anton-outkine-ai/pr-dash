import dagre, { type Graph } from '@dagrejs/dagre'
import type {
  Territory,
  StackNode,
  LayoutNode,
  TerritoryHeader,
  Layout,
  Box,
} from './types'
import { prKey } from './types'

/** Card dimensions — single source of truth shared with the render layer. */
export const CARD_W = 300
export const CARD_H = 132

// Dagre tuning (spec §8): downward ranks with breathing room.
const RANKSEP = 70
const NODESEP = 44
// Header band height drawn at the top of each territory; also the height of the
// synthetic trunk node so taller headers push the first card row down.
const HEADER_H = 80
// Territory packing (spec §8).
const GUTTER = 200
const MAX_ROW_W = 2600

interface Placed {
  /** Local (origin-normalized) coordinates within the territory. */
  nodes: LayoutNode[]
  /** Local top of the trunk band (header sits here, spanning the territory width). */
  trunkY: number
  /** Territory local bounding box size. */
  w: number
  h: number
}

/**
 * Compute world coordinates for every PR card.
 *
 * One dagre graph per territory (trunk as synthetic root → stacks rank
 * downward, base-on-top), then pack territories left→right with row wrapping.
 * Pure: data in → coordinates out, no DOM.
 */
export function computeLayout(
  territories: Territory[],
  heights?: Map<string, number>,
  pinned?: Map<string, { x: number; y: number }>,
): Layout {
  const placed = territories.map((t) => layoutTerritory(t, heights))

  const nodes: LayoutNode[] = []
  const headers: TerritoryHeader[] = []
  const index = new Map<string, LayoutNode>()
  const stableOrigins = new Map<string, { x: number; y: number }>()

  // Horizontal flow with row wrapping (auto-flow for unpinned territories only).
  let cursorX = 0
  let rowY = 0
  let rowMaxH = 0
  let rowWidth = 0

  territories.forEach((territory, i) => {
    const t = placed[i]

    let originX: number
    let originY: number

    const pin = pinned?.get(territory.repo)
    if (pin) {
      // Pinned: use the stored origin as-is (may be negative); do not touch
      // the auto-flow cursor or trigger row-wrap.
      originX = pin.x
      originY = pin.y
    } else {
      // Wrap to a new row when this territory would overflow the row width.
      if (rowWidth > 0 && rowWidth + GUTTER + t.w > MAX_ROW_W) {
        rowY += rowMaxH + GUTTER
        cursorX = 0
        rowMaxH = 0
        rowWidth = 0
      }

      originX = cursorX
      originY = rowY

      cursorX += t.w + GUTTER
      rowWidth = rowWidth === 0 ? t.w : rowWidth + GUTTER + t.w
      rowMaxH = Math.max(rowMaxH, t.h)
    }

    // Offset every local node coord by the packing origin.
    for (const ln of t.nodes) {
      const node: LayoutNode = {
        pr: ln.pr,
        x: ln.x + originX,
        y: ln.y + originY,
        w: CARD_W,
        h: ln.h,
      }
      nodes.push(node)
      index.set(prKey(node.pr), node)
    }

    headers.push({
      repo: territory.repo,
      color: territory.color,
      x: originX,
      y: originY + t.trunkY,
      w: t.w,
      h: HEADER_H,
    })

    // Record the pre-normalization origin (drag start reads this).
    stableOrigins.set(territory.repo, { x: originX, y: originY })
  })

  // Normalization pass: shift the whole world so its top-left is (0,0).
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const n of nodes) {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + n.w)
    maxY = Math.max(maxY, n.y + n.h)
  }
  for (const hd of headers) {
    minX = Math.min(minX, hd.x)
    minY = Math.min(minY, hd.y)
    maxX = Math.max(maxX, hd.x + hd.w)
    maxY = Math.max(maxY, hd.y + hd.h)
  }

  // Empty world guard.
  if (!isFinite(minX)) {
    return {
      nodes,
      headers,
      bbox: { x: 0, y: 0, w: 0, h: 0 },
      index,
      stableOrigins,
      offset: { x: 0, y: 0 },
    }
  }

  // Subtract (minX,minY) from every node + header (index shares the objects).
  for (const n of nodes) {
    n.x -= minX
    n.y -= minY
  }
  for (const hd of headers) {
    hd.x -= minX
    hd.y -= minY
  }

  const bbox: Box = { x: 0, y: 0, w: maxX - minX, h: maxY - minY }

  return { nodes, headers, bbox, index, stableOrigins, offset: { x: minX, y: minY } }
}

/** Lay out a single territory with dagre and normalize to a local origin of (0,0). */
function layoutTerritory(territory: Territory, heights?: Map<string, number>): Placed {
  const g = new dagre.graphlib.Graph()
  g.setGraph({
    rankdir: 'TB',
    ranksep: RANKSEP,
    nodesep: NODESEP,
    marginx: 0,
    marginy: 0,
  })
  g.setDefaultEdgeLabel(() => ({}))

  const trunkId = `__trunk__:${territory.repo}`
  g.setNode(trunkId, { width: CARD_W, height: HEADER_H })

  // Map each dagre node id back to its PR.
  const nodeById = new Map<string, StackNode>()
  for (const stack of territory.stacks) {
    addStack(g, trunkId, stack.root, nodeById, heights)
  }

  dagre.layout(g)
  packStacksLeftToRight(g, territory, trunkId)

  // Collect laid-out positions (dagre gives node CENTER coords).
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  const localNodes: LayoutNode[] = []
  let trunkTop = 0

  for (const id of g.nodes()) {
    const n = g.node(id)
    const w = n.width ?? CARD_W
    const h = n.height ?? CARD_H
    const cx = n.x ?? 0
    const cy = n.y ?? 0
    const left = cx - w / 2
    const top = cy - h / 2

    minX = Math.min(minX, left)
    minY = Math.min(minY, top)
    maxX = Math.max(maxX, left + w)
    maxY = Math.max(maxY, top + h)
  }

  // Empty territory guard.
  if (!isFinite(minX)) {
    minX = 0
    minY = 0
    maxX = CARD_W
    maxY = HEADER_H
  }

  // Second pass: emit origin-normalized coords for real nodes + trunk band.
  for (const id of g.nodes()) {
    const n = g.node(id)
    const w = n.width ?? CARD_W
    const h = n.height ?? CARD_H
    const cx = n.x ?? 0
    const cy = n.y ?? 0
    const left = cx - w / 2 - minX
    const top = cy - h / 2 - minY

    if (id === trunkId) {
      trunkTop = top
      continue
    }
    const node = nodeById.get(id)
    if (node) {
      localNodes.push({ pr: node.pr, x: left, y: top, w: CARD_W, h })
    }
  }

  return {
    nodes: localNodes,
    trunkY: trunkTop,
    w: maxX - minX,
    h: maxY - minY,
  }
}

/** Collect every dagre node id in a stack tree. */
function stackNodeIds(root: StackNode): string[] {
  const ids: string[] = []
  const walk: StackNode[] = [root]
  while (walk.length > 0) {
    const node = walk.pop()!
    ids.push(prKey(node.pr))
    for (const child of node.children) walk.push(child)
  }
  return ids
}

/**
 * Dagre's order heuristic can place sibling stack roots right-to-left.
 * Repack stacks in `territory.stacks` order (lowest base PR leftmost).
 */
function packStacksLeftToRight(g: Graph, territory: Territory, trunkId: string): void {
  let cursorX = 0

  for (const stack of territory.stacks) {
    const ids = stackNodeIds(stack.root)
    let minLeft = Infinity
    let maxRight = -Infinity

    for (const id of ids) {
      const n = g.node(id)
      const w = n.width ?? CARD_W
      const left = (n.x ?? 0) - w / 2
      const right = left + w
      minLeft = Math.min(minLeft, left)
      maxRight = Math.max(maxRight, right)
    }

    if (!isFinite(minLeft)) continue

    const shift = cursorX - minLeft
    for (const id of ids) {
      const n = g.node(id)
      n.x = (n.x ?? 0) + shift
    }

    cursorX = maxRight + shift + NODESEP
  }

  if (cursorX > NODESEP && g.hasNode(trunkId)) {
    g.node(trunkId).x = (cursorX - NODESEP) / 2
  }
}

/** Add a stack's nodes + edges (trunk→root, parent→child) walking the tree. */
function addStack(
  g: Graph,
  trunkId: string,
  root: StackNode,
  nodeById: Map<string, StackNode>,
  heights?: Map<string, number>,
): void {
  const stack: StackNode[] = [root]
  let isRoot = true
  while (stack.length > 0) {
    const node = stack.pop()!
    const id = prKey(node.pr)
    const h = heights?.get(prKey(node.pr)) ?? CARD_H
    g.setNode(id, { width: CARD_W, height: h })
    nodeById.set(id, node)
    if (isRoot) {
      g.setEdge(trunkId, id)
      isRoot = false
    }
    for (const child of node.children) {
      g.setEdge(id, prKey(child.pr))
      stack.push(child)
    }
  }
}
