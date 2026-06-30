import type {
  Territory,
  StackNode,
  Layout,
  LayoutNode,
  CardStatus,
  PR,
  ThemeColor,
} from './types'
import { prKey } from './types'
import { repoColor } from './repo-color'
import { CARD_W } from './layout'

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Render the merge-yard world: repo-colored spines (SVG, behind), territory
 * headers, and PR cards (HTML, in front). Idempotent — clears prior children
 * so re-rendering with fresh data is safe.
 */
export function renderWorld(opts: {
  world: HTMLElement
  svg: SVGSVGElement
  territories: Territory[]
  layout: Layout
  statuses: Map<string, CardStatus>
}): void {
  const { world, svg, territories, layout, statuses } = opts
  const { bbox } = layout

  // 1. Size + clear the world and the spine svg (idempotent re-render).
  world.style.width = `${bbox.w}px`
  world.style.height = `${bbox.h}px`
  svg.setAttribute('width', String(bbox.w))
  svg.setAttribute('height', String(bbox.h))
  svg.setAttribute('viewBox', `0 0 ${bbox.w} ${bbox.h}`)

  // Wipe everything except the svg itself (svg lives inside #world, behind cards).
  for (const child of Array.from(world.children)) {
    if (child !== svg) child.remove()
  }
  while (svg.firstChild) svg.removeChild(svg.firstChild)

  // 2. Spines first (drawn behind cards within the svg layer).
  renderSpines(svg, territories, layout, statuses)

  // 3. Territory headers (trunk-rail anchor atop each territory).
  for (const header of layout.headers) {
    world.appendChild(renderHeader(header))
  }

  // 4. Cards (above the svg).
  for (const node of layout.nodes) {
    const status = statuses.get(prKey(node.pr))
    world.appendChild(renderCard(node, status))
  }
}

/* ----------------------------------------------------------------------- *
 * Measure pass                                                             *
 * ----------------------------------------------------------------------- */

/**
 * Measure the natural pixel height of every PR card at CARD_W width, returning
 * a `prKey(pr) -> height` map for `computeLayout`. Builds each card via the
 * shared `buildCard` (so measured heights match rendered cards) inside a single
 * offscreen container at static `auto` height. The collapsed <details> summary
 * is what's measured — its expanded list floats at runtime and is excluded here.
 */
export function measureHeights(territories: Territory[]): Map<string, number> {
  const heights = new Map<string, number>()

  const container = document.createElement('div')
  container.style.position = 'absolute'
  container.style.visibility = 'hidden'
  container.style.left = '-99999px'
  container.style.top = '0'
  container.style.width = `${CARD_W}px`
  document.body.appendChild(container)

  for (const territory of territories) {
    for (const stack of territory.stacks) {
      forEachStackNode(stack.root, (node) => {
        const card = buildCard(node.pr, undefined)
        card.style.width = `${CARD_W}px`
        card.style.height = 'auto'
        container.appendChild(card)
        heights.set(prKey(node.pr), card.offsetHeight)
      })
    }
  }

  container.remove()
  return heights
}

function forEachStackNode(node: StackNode, fn: (n: StackNode) => void): void {
  fn(node)
  for (const child of node.children) forEachStackNode(child, fn)
}

/* ----------------------------------------------------------------------- *
 * Spines                                                                   *
 * ----------------------------------------------------------------------- */

function setRepoShades(el: Element, color: ThemeColor): void {
  ;(el as HTMLElement | SVGElement).style.setProperty('--repo-light', color.light)
  ;(el as HTMLElement | SVGElement).style.setProperty('--repo-dark', color.dark)
}

/**
 * For each stack, draw a repo-colored vertical rail anchored at the territory
 * header (trunk band), threading down through the stack tree. Each segment
 * (header→root, parent→child) is its own <path> so blocked/ready state can be
 * encoded per edge via modifier classes.
 */
function renderSpines(
  svg: SVGSVGElement,
  territories: Territory[],
  layout: Layout,
  statuses: Map<string, CardStatus>,
): void {
  for (const territory of territories) {
    const header = layout.headers.find((h) => h.repo === territory.repo)
    for (const stack of territory.stacks) {
      const rootNode = layout.index.get(prKey(stack.root.pr))
      if (!rootNode) continue

      // Header/trunk band bottom-center → stack root top-center.
      if (header) {
        const from = { x: header.x + header.w / 2, y: header.y + header.h }
        drawSegment(svg, from, topCenter(rootNode), territory.color, stack.root, statuses, territory.repo)
      }

      // Walk the tree: each parent bottom-center → child top-center.
      walkStack(svg, stack.root, layout, territory.color, statuses, territory.repo)
    }
  }
}

function walkStack(
  svg: SVGSVGElement,
  node: StackNode,
  layout: Layout,
  color: ThemeColor,
  statuses: Map<string, CardStatus>,
  repo: string,
): void {
  const parent = layout.index.get(prKey(node.pr))
  if (!parent) return
  for (const child of node.children) {
    const childNode = layout.index.get(prKey(child.pr))
    if (childNode) {
      drawSegment(svg, bottomCenter(parent), topCenter(childNode), color, child, statuses, repo)
    }
    walkStack(svg, child, layout, color, statuses, repo)
  }
}

function topCenter(n: LayoutNode): { x: number; y: number } {
  return { x: n.x + n.w / 2, y: n.y }
}
function bottomCenter(n: LayoutNode): { x: number; y: number } {
  return { x: n.x + n.w / 2, y: n.y + n.h }
}

/**
 * Draw one spine segment as a smooth vertical S-curve (cubic Bézier with
 * vertical control handles). `target` is the node the segment LEADS INTO — its
 * status drives the blocked/ready modifier on this segment.
 */
function drawSegment(
  svg: SVGSVGElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
  color: ThemeColor,
  target: StackNode,
  statuses: Map<string, CardStatus>,
  repo: string,
): void {
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('data-repo', repo)
  const dy = to.y - from.y
  const c = Math.max(dy * 0.5, 12)
  path.setAttribute(
    'd',
    `M ${from.x} ${from.y} C ${from.x} ${from.y + c}, ${to.x} ${to.y - c}, ${to.x} ${to.y}`,
  )
  path.setAttribute('class', 'spine')
  setRepoShades(path, color)

  const status = statuses.get(prKey(target.pr))
  if (status?.ready) path.classList.add('spine--ready')
  if (status?.blocked) path.classList.add('spine--blocked')

  svg.appendChild(path)
}

/* ----------------------------------------------------------------------- *
 * Territory header                                                         *
 * ----------------------------------------------------------------------- */

function renderHeader(header: {
  repo: string
  color: ThemeColor
  x: number
  y: number
  w: number
  h: number
}): HTMLElement {
  const el = document.createElement('div')
  el.className = 'territory-header'
  el.dataset.repo = header.repo
  el.style.left = `${header.x}px`
  el.style.top = `${header.y}px`
  el.style.width = `${header.w}px`
  el.style.height = `${header.h}px`
  setRepoShades(el, header.color)

  const [owner, name] = splitRepo(header.repo)
  const ownerEl = document.createElement('span')
  ownerEl.className = 'territory-owner'
  ownerEl.textContent = owner ? `${owner}/` : ''
  const nameEl = document.createElement('span')
  nameEl.className = 'territory-name'
  nameEl.textContent = name
  el.append(ownerEl, nameEl)
  return el
}

function splitRepo(repo: string): [string, string] {
  const i = repo.indexOf('/')
  if (i === -1) return ['', repo]
  return [repo.slice(0, i), repo.slice(i + 1)]
}

/* ----------------------------------------------------------------------- *
 * Card                                                                     *
 * ----------------------------------------------------------------------- */

/**
 * Position + size a card from its layout node, then fill it via the shared
 * `buildCard`. Absolute coords and the measured height live here (not in
 * `buildCard`) so the same content builder serves both measure and render.
 */
function renderCard(node: LayoutNode, status: CardStatus | undefined): HTMLElement {
  const card = buildCard(node.pr, status)
  card.style.left = `${node.x}px`
  card.style.top = `${node.y}px`
  card.style.width = `${node.w}px`
  card.style.minHeight = `${node.h}px`
  return card
}

/**
 * Build a PR card's content + classes only — NO absolute positioning and NO
 * fixed height (those are applied by `renderWorld` from layout coords, or by
 * the measure pass which lets it flow at `auto` height). Shared by the measure
 * pass and `renderWorld` so measured heights match rendered cards exactly.
 */
function buildCard(pr: PR, status: CardStatus | undefined): HTMLElement {
  const card = document.createElement('div')
  card.className = 'card'
  card.dataset.repo = pr.repo
  setRepoShades(card, repoColor(pr.repo))

  if (status?.ready) card.classList.add('ready')
  if (status?.blocked) card.classList.add('blocked')

  // --- Title (link) -----------------------------------------------------
  const title = document.createElement('a')
  title.className = 'card-title'
  title.href = pr.url
  title.target = '_blank'
  title.rel = 'noopener'
  title.textContent = pr.title
  card.appendChild(title)

  // --- Ref line: #number + branch (mono, dim) ---------------------------
  const ref = document.createElement('div')
  ref.className = 'card-ref'
  const num = document.createElement('span')
  num.className = 'card-num'
  num.textContent = `#${pr.number}`
  const branch = document.createElement('span')
  branch.className = 'card-branch'
  branch.textContent = pr.branch
  ref.append(num, branch)
  card.appendChild(ref)

  // --- Signal row: CI + review + trunk + ready tag ----------------------
  const signals = document.createElement('div')
  signals.className = 'card-signals'
  if (status) {
    signals.appendChild(ciSignal(pr, status))
    signals.appendChild(reviewSignal(status))
    if (status.trunk) signals.appendChild(trunkBadge(status.trunk))
    if (status.ready) {
      const tag = document.createElement('span')
      tag.className = 'tag tag--ready'
      tag.textContent = 'merge next'
      signals.appendChild(tag)
    }
  }
  card.appendChild(signals)

  // --- Footer: failing-check detail + relative time ---------------------
  const footer = document.createElement('div')
  footer.className = 'card-footer'

  if (pr.failing_checks.length > 0) {
    footer.appendChild(failingDetail(pr))
  } else {
    // Keep the footer balanced when nothing failing — spacer for the time.
    footer.appendChild(document.createElement('span'))
  }

  const time = document.createElement('span')
  time.className = 'card-time'
  time.textContent = relTime(pr.last_commit_at ?? pr.created_at)
  footer.appendChild(time)

  card.appendChild(footer)
  return card
}

function ciSignal(pr: PR, status: CardStatus): HTMLElement {
  const pill = document.createElement('span')
  pill.className = `pill pill--ci pill--ci-${status.ci}`
  const dot = document.createElement('span')
  dot.className = 'pill-dot'
  pill.appendChild(dot)
  const label = document.createElement('span')
  switch (status.ci) {
    case 'passing':
      label.textContent = 'CI'
      break
    case 'failing':
      label.textContent = `${pr.checks_failing} failed`
      break
    case 'pending':
      label.textContent = 'pending'
      break
    default:
      label.textContent = 'no CI'
  }
  pill.appendChild(label)
  return pill
}

function reviewSignal(status: CardStatus): HTMLElement {
  const badge = document.createElement('span')
  badge.className = `pill pill--review pill--review-${status.review}`
  const text: Record<CardStatus['review'], string> = {
    approved: 'approved',
    changes: 'changes',
    draft: 'draft',
    awaiting: 'review',
  }
  badge.textContent = text[status.review]
  return badge
}

function trunkBadge(state: string): HTMLElement {
  const badge = document.createElement('span')
  badge.className = 'pill pill--trunk'
  badge.textContent = state
  return badge
}

/** Disclosure listing failing check names + Buildkite failed-job names. */
function failingDetail(pr: PR): HTMLElement {
  const details = document.createElement('details')
  details.className = 'card-failing'

  const summary = document.createElement('summary')
  summary.className = 'card-failing-summary'
  summary.textContent = `${pr.failing_checks.length} failing`
  details.appendChild(summary)

  const list = document.createElement('ul')
  list.className = 'card-failing-list'
  for (const check of pr.failing_checks) {
    const li = document.createElement('li')
    li.appendChild(failingLink(check.name, check.url))
    const jobs = check.buildkite?.failed_jobs ?? []
    if (jobs.length > 0) {
      const sub = document.createElement('ul')
      for (const job of jobs) {
        const jli = document.createElement('li')
        jli.className = 'card-failing-job'
        jli.appendChild(failingLink(job.name, job.url))
        sub.appendChild(jli)
      }
      li.appendChild(sub)
    }
    list.appendChild(li)
  }
  details.appendChild(list)
  return details
}

/** Check or Buildkite job name; link when a URL is available. */
function failingLink(name: string, url: string | null): HTMLElement {
  if (!url) {
    const span = document.createElement('span')
    span.textContent = name
    return span
  }
  const a = document.createElement('a')
  a.href = url
  a.target = '_blank'
  a.rel = 'noreferrer'
  a.textContent = name
  return a
}

/* ----------------------------------------------------------------------- *
 * Helpers                                                                  *
 * ----------------------------------------------------------------------- */

/** Compact relative time: "just now", "3h", "2d", "3w". */
export function relTime(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const secs = Math.max(0, (Date.now() - then) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(days / 365)}y`
}
