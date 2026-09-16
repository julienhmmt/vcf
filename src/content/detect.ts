/**
 * Login-form detection. Pure DOM, no browser extension APIs — testable
 * under plain jsdom. See .claude/skills/autofill-content-script.
 */

export interface LoginFormFields {
  /** Nearest `<form>`, or a bounded ancestor when there is none. */
  readonly root: Element
  readonly usernameEl: HTMLInputElement | null
  readonly passwordEl: HTMLInputElement
  readonly otpEl: HTMLInputElement | null
}

const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset'])

/**
 * All `<input type="password">` in `root`, including ones nested in
 * open shadow roots. `querySelectorAll` does not pierce shadow
 * boundaries, so each element with a `shadowRoot` is walked
 * separately; closed shadow roots are unreachable by design.
 */
export function findPasswordInputs(root: ParentNode = document): HTMLInputElement[] {
  const found: HTMLInputElement[] = []
  const visit = (scope: ParentNode) => {
    for (const el of scope.querySelectorAll('*')) {
      if (el instanceof HTMLInputElement && el.type === 'password') found.push(el)
      if (el.shadowRoot) visit(el.shadowRoot)
    }
  }
  visit(root)
  return found
}

/**
 * Climbs from `el` looking for a `<form>` ancestor, bounded so a page
 * with no `<form>` at all (common on SPA login screens) doesn't walk
 * all the way to `<html>`. `parentElement` does not cross shadow
 * boundaries, so this naturally stops at the local shadow root too.
 */
export function findScope(el: Element, maxDepth = 6): Element {
  let node = el
  for (let i = 0; i < maxDepth; i++) {
    if (node.tagName === 'FORM') return node
    const parent = node.parentElement
    if (parent === null) break
    node = parent
  }
  return node
}

function isPlausibleUsername(input: HTMLInputElement): boolean {
  if (SKIP_TYPES.has(input.type)) return false
  if (input.type === 'password') return false
  const autocomplete = input.autocomplete.toLowerCase()
  return autocomplete !== 'new-password' && autocomplete !== 'current-password'
}

function precedes(a: Element, b: Element): boolean {
  // True when `a` comes before `b` in document order.
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

/**
 * The field paired with `passwordEl` within `scope`. Prefers the
 * standard autofill hints (`autocomplete="username"` / `"email"`,
 * `type="email"`), then the nearest plausible text field immediately
 * before the password field, then the nearest one after (some forms
 * ask for the password first).
 */
export function findUsernameField(passwordEl: HTMLInputElement, scope: Element): HTMLInputElement | null {
  const candidates = Array.from(scope.querySelectorAll('input')).filter(isPlausibleUsername)
  if (candidates.length === 0) return null

  const byAutocomplete = candidates.find((el) => {
    const ac = el.autocomplete.toLowerCase()
    return ac === 'username' || ac === 'email'
  })
  if (byAutocomplete) return byAutocomplete

  const byType = candidates.find((el) => el.type === 'email')
  if (byType) return byType

  const before = candidates.filter((el) => precedes(el, passwordEl))
  const closestBefore = before.at(-1)
  if (closestBefore) return closestBefore

  return candidates[0] ?? null
}

const OTP_NAME_PATTERN = /(?:^|[-_ ])(?:otp|totp|mfa|2fa)(?:[-_ ]|$)|one[-_ ]?time[-_ ]?code|verification[-_ ]?code/i

function looksLikeOtpField(input: HTMLInputElement): boolean {
  if (SKIP_TYPES.has(input.type) || input.type === 'password') return false
  const haystack = `${input.name} ${input.id} ${input.placeholder}`
  if (!OTP_NAME_PATTERN.test(haystack)) return false
  // A guess based on the field's name still needs a numeric-ish shape
  // to be trusted — otherwise a field merely named "..._code" (a
  // coupon, a country code) would match.
  const maxLength = input.maxLength
  const numericHint = input.inputMode === 'numeric' || /^[0-9]*$/.test(input.pattern)
  return numericHint || (maxLength > 0 && maxLength <= 10)
}

/**
 * A field for a one-time code. The standard autofill hint
 * (`autocomplete="one-time-code"`) is authoritative when present;
 * otherwise a conservative name/placeholder + numeric-shape heuristic
 * is used as a fallback, since most sites don't set the hint.
 */
export function findOtpField(scope: Element): HTMLInputElement | null {
  const inputs = Array.from(scope.querySelectorAll<HTMLInputElement>('input'))
  const byHint = inputs.find((el) => el.autocomplete.toLowerCase() === 'one-time-code')
  if (byHint) return byHint
  return inputs.find(looksLikeOtpField) ?? null
}

/**
 * Every login form in `root`. A scope with more than one password
 * field (change-password, sign-up with confirmation, reset) is
 * skipped rather than guessed at — this only detects single-password
 * sign-in forms.
 */
export function detectLoginForms(root: ParentNode = document): LoginFormFields[] {
  const byScope = new Map<Element, HTMLInputElement[]>()
  for (const passwordEl of findPasswordInputs(root)) {
    const scope = findScope(passwordEl)
    const list = byScope.get(scope) ?? []
    list.push(passwordEl)
    byScope.set(scope, list)
  }

  const forms: LoginFormFields[] = []
  for (const [scope, passwords] of byScope) {
    if (passwords.length !== 1) continue
    const passwordEl = passwords[0]
    if (passwordEl === undefined) continue
    forms.push({
      root: scope,
      passwordEl,
      usernameEl: findUsernameField(passwordEl, scope),
      otpEl: findOtpField(scope),
    })
  }
  return forms
}
