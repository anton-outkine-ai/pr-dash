import type { PR, StackNode, Stack, Territory, CardStatus } from './types'
import { prKey } from './types'

/** CI rollup state for a PR (spec §10). */
function ciStatus(pr: PR): CardStatus['ci'] {
  if (pr.checks_failing > 0) return 'failing'
  if (pr.checks_pending > 0) return 'pending'
  if (pr.checks_passing > 0) return 'passing'
  return 'none'
}

/** Review rollup state for a PR (spec §10). */
function reviewStatus(pr: PR): CardStatus['review'] {
  if (pr.draft) return 'draft'
  if (pr.changes_requested > 0 || pr.review_decision === 'CHANGES_REQUESTED') return 'changes'
  if (pr.review_decision === 'APPROVED' || pr.approvals > 0) return 'approved'
  return 'awaiting'
}

/** A PR is merge-ready when CI is green, review approved, not draft, no changes requested. */
function mergeReady(pr: PR): boolean {
  return (
    ciStatus(pr) === 'passing' &&
    reviewStatus(pr) === 'approved' &&
    !pr.draft &&
    pr.changes_requested === 0 &&
    pr.review_decision !== 'CHANGES_REQUESTED'
  )
}

/**
 * Walk the stack tree from the root to find the chain of ancestors leading to
 * `target` (exclusive of `target` itself). Returns null if not found.
 */
function ancestorsOf(root: StackNode, target: StackNode): StackNode[] | null {
  if (root.pr === target.pr || prKey(root.pr) === prKey(target.pr)) return []
  for (const child of root.children) {
    const sub = ancestorsOf(child, target)
    if (sub) return [root, ...sub]
  }
  return null
}

/** Derive the full status for a node within its stack (spec §10). */
export function deriveStatus(node: StackNode, stack: Stack): CardStatus {
  const pr = node.pr
  const ci = ciStatus(pr)
  const review = reviewStatus(pr)

  const ancestors = ancestorsOf(stack.root, node) ?? []
  const ancestorBlocking = ancestors.some((a) => !mergeReady(a.pr))

  const blocked = ci === 'failing' || review === 'changes' || ancestorBlocking
  const isRoot = node.depth === 0
  const ready = isRoot && mergeReady(pr) && !blocked

  return {
    ci,
    review,
    trunk: pr.trunk_merge.state,
    blocked,
    ready,
  }
}

/**
 * Walk every territory → stack → node (DFS) and build a status map keyed by
 * prKey(pr).
 */
export function buildStatusMap(territories: Territory[]): Map<string, CardStatus> {
  const map = new Map<string, CardStatus>()
  for (const territory of territories) {
    for (const stack of territory.stacks) {
      visit(stack.root, stack, map)
    }
  }
  return map
}

function visit(node: StackNode, stack: Stack, map: Map<string, CardStatus>): void {
  map.set(prKey(node.pr), deriveStatus(node, stack))
  for (const child of node.children) visit(child, stack, map)
}
