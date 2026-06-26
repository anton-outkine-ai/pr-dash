export interface RefetchButton {
  el: HTMLElement
  setFetching(fetching: boolean): void
}

/** A wired circular ⟳ button. Click invokes `onRefetch` unless already fetching. */
export function createRefetchButton(onRefetch: () => void): RefetchButton {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'refetch-btn'
  btn.setAttribute('aria-label', 'Refetch PRs')
  btn.title = 'Refetch PRs'

  const icon = document.createElement('span')
  icon.className = 'refetch-icon'
  icon.textContent = '⟳'
  btn.appendChild(icon)

  btn.addEventListener('click', () => {
    if (btn.disabled) return
    onRefetch()
  })

  function setFetching(fetching: boolean): void {
    btn.disabled = fetching
    if (fetching) {
      btn.classList.add('is-fetching')
    } else {
      btn.classList.remove('is-fetching')
    }
  }

  return { el: btn, setFetching }
}
