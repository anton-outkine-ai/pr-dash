import type { PR, Territory, Stack, StackNode } from './types'
import { repoColor } from './repo-color'

/** Newest timestamp for a single PR: last_commit_at, falling back to created_at. */
function prTime(pr: PR): string {
  return pr.last_commit_at ?? pr.created_at
}

/**
 * Reconstruct the forest of stacks from base-branch chains (spec §7).
 * Returns one Territory per repo, stacks ordered by base PR number ascending,
 * territories ordered newest-first.
 */
export function buildForest(prs: PR[]): Territory[] {
  // 1. Group PRs by repo.
  const byRepo = new Map<string, PR[]>()
  for (const pr of prs) {
    const list = byRepo.get(pr.repo)
    if (list) list.push(pr)
    else byRepo.set(pr.repo, [pr])
  }

  const territories: Territory[] = []

  for (const [repo, repoPrs] of byRepo) {
    // 2. Map head branch → PR, so a child's base_branch resolves to its parent.
    const headRef = new Map<string, PR>()
    for (const pr of repoPrs) headRef.set(pr.branch, pr)

    // 3. Roots = PRs whose base_branch is NOT the head of any open PR in repo.
    const roots = repoPrs.filter((pr) => !headRef.has(pr.base_branch))

    const stacks: Stack[] = []
    for (const root of roots) {
      const visited = new Set<string>()
      const rootNode = buildNode(root, 0, repoPrs, visited)
      stacks.push({
        repo,
        root: rootNode,
        newest: stackNewest(rootNode),
        size: visited.size,
      })
    }

    // 6. Order stacks left-to-right: lowest base PR number leftmost.
    stacks.sort((a, b) => a.root.pr.number - b.root.pr.number)

    const territoryNewest = stacks.reduce(
      (max, s) => (s.newest > max ? s.newest : max),
      '',
    )

    territories.push({
      repo,
      color: repoColor(repo),
      stacks,
      newest: territoryNewest,
    })
  }

  // 7. Order territories by recency, newest first.
  territories.sort((a, b) => (a.newest < b.newest ? 1 : a.newest > b.newest ? -1 : 0))

  return territories
}

/**
 * Build a StackNode and its descendants. A child of `pr` is any PR whose
 * base_branch equals this PR's branch. Guards against cycles via `visited`.
 */
function buildNode(
  pr: PR,
  depth: number,
  repoPrs: PR[],
  visited: Set<string>,
): StackNode {
  visited.add(pr.branch)
  const children: StackNode[] = []
  for (const candidate of repoPrs) {
    if (candidate.base_branch === pr.branch && !visited.has(candidate.branch)) {
      children.push(buildNode(candidate, depth + 1, repoPrs, visited))
    }
  }
  return { pr, children, depth }
}

/** Max recency timestamp across a node and all its descendants. */
function stackNewest(node: StackNode): string {
  let newest = prTime(node.pr)
  for (const child of node.children) {
    const childNewest = stackNewest(child)
    if (childNewest > newest) newest = childNewest
  }
  return newest
}
