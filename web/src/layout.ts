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
export function computeLayout(territories: Territory[], heights?: Map<string, number>): Layout {
  const placed = territories.map((t) => layoutTerritory(t, heights))

  const nodes: LayoutNode[] = []
  const headers: TerritoryHeader[] = []
  const index = new Map<string, LayoutNode>()

  // Horizontal flow with row wrapping.
  let cursorX = 0
  let rowY = 0
  let rowMaxH = 0
  let rowWidth = 0
  let worldRight = 0
  let worldBottom = 0

  territories.forEach((territory, i) => {
    const t = placed[i]

    // Wrap to a new row when this territory would overflow the row width.
    if (rowWidth > 0 && rowWidth + GUTTER + t.w > MAX_ROW_W) {
      rowY += rowMaxH + GUTTER
      cursorX = 0
      rowMaxH = 0
      rowWidth = 0
    }

    const originX = cursorX
    const originY = rowY

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

    worldRight = Math.max(worldRight, originX + t.w)
    worldBottom = Math.max(worldBottom, originY + t.h)

    cursorX += t.w + GUTTER
    rowWidth = rowWidth === 0 ? t.w : rowWidth + GUTTER + t.w
    rowMaxH = Math.max(rowMaxH, t.h)
  })

  const bbox: Box = { x: 0, y: 0, w: worldRight, h: worldBottom }

  return { nodes, headers, bbox, index }
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
