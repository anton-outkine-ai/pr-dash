import type { PR } from './types'

/**
 * Fetch the current user's open PRs from the backend.
 *
 * The backend returns `{ "prs": PR[] }` on success or `{ "error": string }`
 * with HTTP 500 on failure. Throws an Error carrying the backend message when
 * the response is not ok or contains an `error` field.
 */
export async function fetchPRs(): Promise<PR[]> {
  const res = await fetch('/api/prs')
  const data = (await res.json()) as { prs?: PR[]; error?: string }
  if (data.error) throw new Error(data.error)
  if (!res.ok) throw new Error(`Request failed with status ${res.status}`)
  return data.prs ?? []
}
