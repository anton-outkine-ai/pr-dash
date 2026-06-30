export interface BkData {
  state: string | null
  pipeline: string
  build: string
  failed_jobs: { name: string; state: string; url: string | null }[]
  broken_count: number
  error?: string
}

export interface FailingCheck {
  name: string
  state: string
  url: string | null
  buildkite: BkData | null
}

export interface TrunkMerge {
  state: string | null
  comment_url: string | null
}

export interface PR {
  number: number
  title: string
  url: string
  repo: string            // "owner/name"
  branch: string          // headRefName
  base_branch: string     // baseRefName
  draft: boolean
  review_decision: string // "" | "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED"
  approvals: number
  changes_requested: number
  pending_reviewers: number
  checks_passing: number
  checks_failing: number
  checks_pending: number
  failing_checks: FailingCheck[]
  updated_at: string
  created_at: string
  last_commit_at: string | null
  trunk_merge: TrunkMerge
}

/** Identity hue for a repo, with a per-theme shade. */
export interface ThemeColor {
  name: string   // hue name, e.g. "Indigo"
  light: string  // hex for light canvas
  dark: string   // hex for dark canvas
}

export interface StackNode {
  pr: PR
  children: StackNode[]
  depth: number   // 0 at root (nearest trunk)
}

export interface Stack {
  repo: string
  root: StackNode
  newest: string  // ISO timestamp of newest member
  size: number
}

export interface Territory {
  repo: string
  color: ThemeColor
  stacks: Stack[]
  newest: string  // ISO timestamp of newest stack
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface LayoutNode {
  pr: PR
  x: number
  y: number
  w: number
  h: number
}

export interface TerritoryHeader {
  repo: string
  color: ThemeColor
  x: number
  y: number
  w: number
  h: number
}

export interface Layout {
  nodes: LayoutNode[]
  headers: TerritoryHeader[]
  bbox: Box
  /** prKey(pr) -> LayoutNode, for connecting spines and lookups. */
  index: Map<string, LayoutNode>
  /** Pre-normalization origin per repo (drag start needs it). */
  stableOrigins: Map<string, { x: number; y: number }>
  /** The (minX,minY) subtracted during normalization (camera compensation needs it). */
  offset: { x: number; y: number }
}

export interface CardStatus {
  ci: 'passing' | 'failing' | 'pending' | 'none'
  review: 'approved' | 'changes' | 'draft' | 'awaiting'
  trunk: string | null
  blocked: boolean
  ready: boolean
}

/** Stable per-PR key (PR numbers are only unique within a repo). */
export function prKey(pr: Pick<PR, 'repo' | 'number'>): string {
  return `${pr.repo}#${pr.number}`
}
