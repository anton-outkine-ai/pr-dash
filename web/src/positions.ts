const KEY = 'pr-dash:territory-origins'

export interface Origin {
  x: number
  y: number
}

/** Load all per-repo territory origins. Returns an empty Map on missing/invalid JSON. */
export function loadOrigins(): Map<string, Origin> {
  try {
    const obj = JSON.parse(localStorage.getItem(KEY) ?? '') as Record<string, Origin>
    return new Map(Object.entries(obj))
  } catch {
    return new Map()
  }
}

/** Persist many repo origins at once, merging into the stored object. */
export function saveOrigins(origins: Map<string, Origin>): void {
  const obj = Object.fromEntries(loadOrigins())
  for (const [repo, o] of origins) obj[repo] = { x: o.x, y: o.y }
  localStorage.setItem(KEY, JSON.stringify(obj))
}

/** Forget all stored origins. */
export function clearOrigins(): void {
  localStorage.removeItem(KEY)
}
