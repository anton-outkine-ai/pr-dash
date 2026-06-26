type Theme = 'light' | 'dark'

const STORAGE_KEY = 'theme'

function readStored(): Theme | null {
  const v = localStorage.getItem(STORAGE_KEY)
  return v === 'light' || v === 'dark' ? v : null
}

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
}

/** Apply the persisted theme, or fall back to the OS preference. */
export function initTheme(): void {
  const theme = readStored() ?? (systemPrefersDark() ? 'dark' : 'light')
  applyTheme(theme)
}

/** A wired, accessible toggle button: flips + persists the theme. */
export function createThemeToggle(): HTMLElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'theme-toggle'

  const icon = document.createElement('span')
  icon.className = 'theme-toggle-icon'
  btn.appendChild(icon)

  function sync(): void {
    const theme = currentTheme()
    // Icon shows the theme you'd switch TO.
    icon.textContent = theme === 'dark' ? '☾' : '☀' // ☾ / ☀
    const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
    btn.setAttribute('aria-label', label)
    btn.title = label
  }

  btn.addEventListener('click', () => {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    localStorage.setItem(STORAGE_KEY, next)
    sync()
  })

  sync()
  return btn
}
