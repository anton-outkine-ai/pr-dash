import type { ThemeColor } from './types'

/** The 8 repo identity hues from spec §11, in table order. */
export const PALETTE: ThemeColor[] = [
  { name: 'Indigo', light: '#4f46e5', dark: '#818cf8' },
  { name: 'Cyan', light: '#0891b2', dark: '#22d3ee' },
  { name: 'Violet', light: '#7c3aed', dark: '#a78bfa' },
  { name: 'Pink/Magenta', light: '#db2777', dark: '#f472b6' },
  { name: 'Teal', light: '#0d9488', dark: '#2dd4bf' },
  { name: 'Orange-Coral', light: '#ea580c', dark: '#fb923c' },
  { name: 'Sky-Blue', light: '#0284c7', dark: '#38bdf8' },
  { name: 'Plum/Fuchsia', light: '#a21caf', dark: '#e879f9' },
]

/**
 * Deterministic repo → identity hue. Hashes the `owner/name` string so the
 * same repo always maps to the same palette entry.
 */
export function repoColor(repo: string): ThemeColor {
  const hash = Array.from(repo).reduce(
    (acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0,
    0,
  )
  return PALETTE[hash % PALETTE.length]
}
