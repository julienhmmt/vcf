/**
 * Framework-safe value injection. Setting `.value` directly does not
 * trigger React/Vue/Angular's own change tracking (some frameworks
 * add an instance-level `value` accessor to intercept and track
 * writes), so the field looks filled but the framework's state stays
 * stale and a submit sends the old value. Going through the
 * *prototype's* native setter bypasses any such instance wrapper;
 * dispatching `input`/`change` afterward is what makes the framework
 * notice. See .claude/skills/autofill-content-script.
 */
import type { LoginFormFields } from './detect'

const NATIVE_VALUE_SETTER = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set

export function setNativeValue(el: HTMLInputElement, value: string): void {
  if (NATIVE_VALUE_SETTER) {
    NATIVE_VALUE_SETTER.call(el, value)
  } else {
    el.value = value
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

export interface FillValues {
  readonly username: string | null
  readonly password: string | null
  readonly totp: string | null
}

/**
 * Writes whichever values are present into the matching fields, then
 * lets `values` (and the values it came from, in the caller) go out
 * of scope — nothing here caches a secret for a second fill.
 */
export function fillLoginForm(fields: LoginFormFields, values: FillValues): void {
  if (values.username !== null && fields.usernameEl !== null) {
    setNativeValue(fields.usernameEl, values.username)
  }
  if (values.password !== null) {
    setNativeValue(fields.passwordEl, values.password)
  }
  if (values.totp !== null && fields.otpEl !== null) {
    setNativeValue(fields.otpEl, values.totp)
  }
}
