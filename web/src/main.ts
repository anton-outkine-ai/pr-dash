import './styles/tokens.css'
import './styles/app.css'
import './styles/canvas.css'

import { fetchPRs } from './data'
import { buildForest } from './forest'
import { buildStatusMap } from './status'
import { computeLayout } from './layout'
import { renderWorld, measureHeights } from './render'
import { initTheme, createThemeToggle } from './theme'
import { setupCanvas } from './canvas'
import { setupMinimap, setupLegend } from './minimap'

initTheme()

const app = document.querySelector<HTMLDivElement>('#app')!

const viewport = document.createElement('div')
viewport.className = 'viewport'

const canvas = document.createElement('div')
canvas.className = 'canvas'

const world = document.createElement('div')
world.id = 'world'

// SVG layer behind cards for spines; render.ts populates it and keeps it as a #world child.
const svgNS = 'http://www.w3.org/2000/svg'
const spines = document.createElementNS(svgNS, 'svg') as SVGSVGElement
spines.id = 'spines'

world.append(spines)
viewport.append(canvas, world)
app.append(viewport, createThemeToggle())

function showMessage(text: string): void {
  const el = document.createElement('div')
  el.className = 'overlay-message'
  el.textContent = text
  el.style.cssText =
    'position:absolute;inset:0;display:grid;place-items:center;' +
    'font-family:var(--font-display);font-size:20px;color:var(--text-dim);'
  app.append(el)
}

async function boot(): Promise<void> {
  let prs
  try {
    prs = await fetchPRs()
  } catch (e) {
    showMessage(`Failed to load PRs: ${e instanceof Error ? e.message : String(e)}`)
    return
  }

  const territories = buildForest(prs)
  const statuses = buildStatusMap(territories)
  const heights = measureHeights(territories)
  const layout = computeLayout(territories, heights)

  if (layout.nodes.length === 0) {
    showMessage('No open PRs.')
    return
  }

  renderWorld({ world, svg: spines, territories, layout, statuses })

  const controller = setupCanvas({ viewport, world, worldBBox: layout.bbox })
  setupMinimap({ parent: viewport, layout, worldBBox: layout.bbox, canvas: controller, viewport })
  setupLegend({ parent: viewport, territories, layout, canvas: controller })

  // The legend (top-right) and minimap (bottom-right) are fixed HUD overlays; reserve
  // their column on the right so zoom-to-fit never drops a territory behind them.
  const legendW = viewport.querySelector('.legend')?.getBoundingClientRect().width ?? 0
  const minimapW = viewport.querySelector('.minimap')?.getBoundingClientRect().width ?? 0
  controller.zoomToFit({ insets: { right: Math.max(legendW, minimapW) + 24 } })
}

void boot()
