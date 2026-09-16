// @vitest-environment jsdom
import { describe, expect, test } from 'vitest'
import { fillLoginForm, setNativeValue } from './inject'
import { detectLoginForms } from './detect'

describe('setNativeValue', () => {
  test('sets the value and fires input + change', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    const events: string[] = []
    input.addEventListener('input', () => events.push('input'))
    input.addEventListener('change', () => events.push('change'))

    setNativeValue(input, 'hunter2')

    expect(input.value).toBe('hunter2')
    expect(events).toEqual(['input', 'change'])
  })

  test('bypasses a React-style instance value tracker, unlike plain .value=', () => {
    // React wraps the native `value` accessor on the DOM node itself
    // to track writes it made vs. writes it didn't. A plain `.value =`
    // goes through that wrapper (React "sees" it, but assignment alone
    // still isn't enough to trigger its onChange); going through the
    // *prototype's* setter, as setNativeValue does, bypasses the
    // wrapper entirely — the real signal frameworks rely on is the
    // dispatched `input` event, which this proves still fires.
    const input = document.createElement('input')
    document.body.appendChild(input)
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!
    let sawWrappedWrite = false
    Object.defineProperty(input, 'value', {
      configurable: true,
      get() {
        return native.get!.call(this)
      },
      set(v: string) {
        sawWrappedWrite = true
        native.set!.call(this, v)
      },
    })

    const events: string[] = []
    input.addEventListener('input', () => events.push('input'))

    setNativeValue(input, 'p@ssw0rd')

    expect(sawWrappedWrite).toBe(false)
    expect(native.get!.call(input)).toBe('p@ssw0rd')
    expect(events).toEqual(['input'])
  })
})

describe('fillLoginForm', () => {
  function detectOne() {
    document.body.innerHTML = `
      <form>
        <input type="text" autocomplete="username" id="user">
        <input type="password" id="pw">
        <input id="otp" autocomplete="one-time-code">
      </form>
    `
    const forms = detectLoginForms(document)
    const form = forms[0]
    if (!form) throw new Error('expected a detected form')
    return form
  }

  test('fills username, password and otp when all are present', () => {
    const form = detectOne()
    fillLoginForm(form, { username: 'julien', password: 'hunter2', totp: '123456' })
    expect(form.usernameEl?.value).toBe('julien')
    expect(form.passwordEl.value).toBe('hunter2')
    expect(form.otpEl?.value).toBe('123456')
  })

  test('skips null values and missing fields without throwing', () => {
    document.body.innerHTML = '<form><input type="password" id="pw"></form>'
    const forms = detectLoginForms(document)
    const form = forms[0]
    if (!form) throw new Error('expected a detected form')
    expect(() => fillLoginForm(form, { username: 'julien', password: null, totp: '123456' })).not.toThrow()
    expect(form.passwordEl.value).toBe('')
  })
})
