import { browser } from 'wxt/browser'

/**
 * Non-secret wizard progress only: address, namespace, the chosen
 * auth method and its non-secret fields (mount, username, role id,
 * role). Never a password or secret id, even transiently — see
 * .claude/skills/svelte-extension-ui and extension-security-review.
 *
 * Lives under its own key, separate from `vcf.config` (the real,
 * validated configuration the service worker reads).
 */
const DRAFT_KEY = 'vcf.wizardDraft'

export interface WizardDraft {
  readonly address?: string
  readonly namespace?: string
  readonly authMethod?: 'token' | 'userpass' | 'ldap' | 'approle' | 'oidc'
  readonly mount?: string
  readonly username?: string
  readonly roleId?: string
  readonly role?: string
}

export async function loadDraft(): Promise<WizardDraft> {
  const result = await browser.storage.local.get(DRAFT_KEY)
  const draft = result[DRAFT_KEY]
  return draft !== null && typeof draft === 'object' ? (draft as WizardDraft) : {}
}

export async function saveDraft(draft: WizardDraft): Promise<void> {
  await browser.storage.local.set({ [DRAFT_KEY]: draft })
}

export async function clearDraft(): Promise<void> {
  await browser.storage.local.remove(DRAFT_KEY)
}
