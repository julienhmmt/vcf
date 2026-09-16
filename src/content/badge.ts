/**
 * The in-page fill affordance: a small badge anchored next to a
 * detected password field. Renders into whatever container it's
 * given — the entrypoint mounts that container inside an isolated
 * shadow root (see createShadowRootUi in autofill.content.ts), kept
 * separate here so the interaction logic is testable without one.
 *
 * Mirrors src/entrypoints/popup/Picker.svelte's behaviour (same
 * downgrade-confirmation flow, same "Filled" pulse) since this is the
 * same action through a different surface.
 */
import { describeError, qualityLabel } from '../ui/lib/format'
import { RpcError } from '../ui/lib/messaging'
import type { Candidate } from '../background/service'

export interface BadgeDeps {
  readonly listCandidates: () => Promise<readonly Candidate[]>
  readonly fill: (candidate: Candidate, allowDowngrade: boolean) => Promise<void>
}

type BadgeState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'list'; readonly candidates: readonly Candidate[] }
  | { readonly kind: 'confirm-downgrade'; readonly candidates: readonly Candidate[]; readonly candidate: Candidate }
  | { readonly kind: 'filling'; readonly candidates: readonly Candidate[] }
  | { readonly kind: 'filled'; readonly candidates: readonly Candidate[] }
  | { readonly kind: 'error'; readonly message: string }

function keyOf(candidate: Pick<Candidate, 'mount' | 'path'>): string {
  return `${candidate.mount}:${candidate.path}`
}

export class BadgeController {
  private state: BadgeState = { kind: 'closed' }
  private filledTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly container: HTMLElement,
    private readonly deps: BadgeDeps,
  ) {
    this.render()
  }

  destroy(): void {
    clearTimeout(this.filledTimer)
    this.container.innerHTML = ''
  }

  private setState(state: BadgeState): void {
    this.state = state
    this.render()
  }

  private readonly toggle = (): void => {
    if (this.state.kind === 'closed' || this.state.kind === 'error') {
      void this.open()
      return
    }
    this.setState({ kind: 'closed' })
  }

  private async open(): Promise<void> {
    this.setState({ kind: 'loading' })
    try {
      const candidates = await this.deps.listCandidates()
      this.setState({ kind: 'list', candidates })
    } catch (error) {
      this.setState({ kind: 'error', message: describeError(error) })
    }
  }

  private async select(candidates: readonly Candidate[], candidate: Candidate, allowDowngrade: boolean): Promise<void> {
    this.setState({ kind: 'filling', candidates })
    try {
      await this.deps.fill(candidate, allowDowngrade)
      this.setState({ kind: 'filled', candidates })
      clearTimeout(this.filledTimer)
      this.filledTimer = setTimeout(() => {
        if (this.state.kind === 'filled') this.setState({ kind: 'closed' })
      }, 1500)
    } catch (error) {
      if (error instanceof RpcError && error.kind === 'downgrade') {
        this.setState({ kind: 'confirm-downgrade', candidates, candidate })
        return
      }
      this.setState({ kind: 'error', message: describeError(error) })
    }
  }

  private render(): void {
    const { container } = this
    container.innerHTML = ''

    const toggleButton = document.createElement('button')
    toggleButton.type = 'button'
    toggleButton.className = 'vcf-toggle'
    toggleButton.setAttribute('aria-label', 'VaultCredsFiller')
    toggleButton.textContent = '🔑'
    toggleButton.addEventListener('click', this.toggle)
    container.appendChild(toggleButton)

    if (this.state.kind === 'closed') return

    const panel = document.createElement('div')
    panel.className = 'vcf-panel'
    container.appendChild(panel)

    switch (this.state.kind) {
      case 'loading': {
        panel.textContent = 'Looking for credentials…'
        break
      }
      case 'error': {
        panel.setAttribute('role', 'alert')
        panel.textContent = this.state.message
        break
      }
      case 'list': {
        this.renderList(panel, this.state.candidates)
        break
      }
      case 'filling': {
        this.renderList(panel, this.state.candidates, { disabled: true })
        break
      }
      case 'filled': {
        panel.textContent = 'Filled ✓'
        break
      }
      case 'confirm-downgrade': {
        // Captured once, synchronously, so the click handlers below
        // close over this exact candidate/list rather than re-reading
        // `this.state` (narrowed here, not inside an async closure).
        const { candidates, candidate } = this.state
        this.renderList(panel, candidates, { disabled: true })

        const warning = document.createElement('div')
        warning.setAttribute('role', 'alert')
        warning.className = 'vcf-downgrade'
        const text = document.createElement('p')
        text.textContent = 'This page is not using https. Fill anyway?'
        warning.appendChild(text)

        const confirmButton = document.createElement('button')
        confirmButton.type = 'button'
        confirmButton.textContent = 'Fill anyway'
        confirmButton.addEventListener('click', () => void this.select(candidates, candidate, true))

        const cancelButton = document.createElement('button')
        cancelButton.type = 'button'
        cancelButton.textContent = 'Cancel'
        cancelButton.addEventListener('click', () => this.setState({ kind: 'list', candidates }))

        warning.appendChild(confirmButton)
        warning.appendChild(cancelButton)
        panel.appendChild(warning)
        break
      }
    }
  }

  private renderList(panel: HTMLElement, candidates: readonly Candidate[], options: { disabled?: boolean } = {}): void {
    if (candidates.length === 0) {
      const empty = document.createElement('p')
      empty.textContent = 'No credential matches this page.'
      panel.appendChild(empty)
      return
    }
    const list = document.createElement('ul')
    for (const candidate of candidates) {
      const item = document.createElement('li')
      const label = document.createElement('span')
      label.textContent = `${candidate.title} — ${qualityLabel(candidate.quality)}`
      item.appendChild(label)
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = 'Fill'
      button.disabled = options.disabled === true
      button.dataset['key'] = keyOf(candidate)
      button.addEventListener('click', () => void this.select(candidates, candidate, false))
      item.appendChild(button)
      list.appendChild(item)
    }
    panel.appendChild(list)
  }
}
