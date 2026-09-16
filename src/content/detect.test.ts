// @vitest-environment jsdom
import { describe, expect, test } from 'vitest'
import { detectLoginForms, findOtpField, findPasswordInputs, findScope, findUsernameField } from './detect'

function setBody(html: string): void {
  document.body.innerHTML = html
}

describe('findPasswordInputs', () => {
  test('finds a plain password field', () => {
    setBody('<input type="text"><input type="password">')
    expect(findPasswordInputs(document)).toHaveLength(1)
  })

  test('recurses into open shadow roots', () => {
    setBody('<div id="host"></div>')
    const host = document.getElementById('host')!
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<input type="password">'
    expect(findPasswordInputs(document)).toHaveLength(1)
  })

  test('ignores closed shadow roots (unreachable by design)', () => {
    setBody('<div id="host"></div>')
    const host = document.getElementById('host')!
    host.attachShadow({ mode: 'closed' }).innerHTML = '<input type="password">'
    expect(findPasswordInputs(document)).toHaveLength(0)
  })
})

describe('findScope', () => {
  test('finds the nearest form ancestor', () => {
    setBody('<form id="f"><div><input id="pw" type="password"></div></form>')
    const scope = findScope(document.getElementById('pw')!)
    expect(scope.id).toBe('f')
  })

  test('stops at maxDepth when there is no form', () => {
    setBody('<div><div><input id="pw" type="password"></div></div>')
    const scope = findScope(document.getElementById('pw')!, 1)
    expect(scope.tagName).toBe('DIV')
    expect(scope).not.toBe(document.body)
  })
})

describe('findUsernameField', () => {
  test('prefers autocomplete="username"', () => {
    setBody(`
      <form id="f">
        <input type="text" id="decoy">
        <input type="text" id="user" autocomplete="username">
        <input type="password" id="pw">
      </form>
    `)
    const field = findUsernameField(document.getElementById('pw') as HTMLInputElement, document.getElementById('f')!)
    expect(field?.id).toBe('user')
  })

  test('falls back to type="email"', () => {
    setBody(`
      <form id="f">
        <input type="email" id="mail">
        <input type="password" id="pw">
      </form>
    `)
    const field = findUsernameField(document.getElementById('pw') as HTMLInputElement, document.getElementById('f')!)
    expect(field?.id).toBe('mail')
  })

  test('otherwise picks the nearest plausible field before the password', () => {
    setBody(`
      <form id="f">
        <input type="text" id="far">
        <input type="text" id="near">
        <input type="password" id="pw">
      </form>
    `)
    const field = findUsernameField(document.getElementById('pw') as HTMLInputElement, document.getElementById('f')!)
    expect(field?.id).toBe('near')
  })

  test('falls back to a field after the password when there is none before', () => {
    setBody(`
      <form id="f">
        <input type="password" id="pw">
        <input type="text" id="after">
      </form>
    `)
    const field = findUsernameField(document.getElementById('pw') as HTMLInputElement, document.getElementById('f')!)
    expect(field?.id).toBe('after')
  })

  test('excludes new-password / current-password autocomplete fields', () => {
    setBody(`
      <form id="f">
        <input type="text" id="confirm" autocomplete="new-password">
        <input type="password" id="pw">
      </form>
    `)
    const field = findUsernameField(document.getElementById('pw') as HTMLInputElement, document.getElementById('f')!)
    expect(field).toBeNull()
  })

  test('returns null with nothing plausible', () => {
    setBody('<form id="f"><input type="password" id="pw"></form>')
    const field = findUsernameField(document.getElementById('pw') as HTMLInputElement, document.getElementById('f')!)
    expect(field).toBeNull()
  })
})

describe('findOtpField', () => {
  test('finds autocomplete="one-time-code"', () => {
    setBody('<form id="f"><input id="otp" autocomplete="one-time-code"></form>')
    expect(findOtpField(document.getElementById('f')!)?.id).toBe('otp')
  })

  test('returns null without one', () => {
    setBody('<form id="f"><input type="text"></form>')
    expect(findOtpField(document.getElementById('f')!)).toBeNull()
  })
})

describe('detectLoginForms', () => {
  test('pairs username and password within one form', () => {
    setBody(`
      <form>
        <input type="text" autocomplete="username" id="user">
        <input type="password" id="pw">
      </form>
    `)
    const forms = detectLoginForms(document)
    expect(forms).toHaveLength(1)
    expect(forms[0]?.usernameEl?.id).toBe('user')
    expect(forms[0]?.passwordEl.id).toBe('pw')
    expect(forms[0]?.otpEl).toBeNull()
  })

  test('skips a scope with more than one password field (signup / reset)', () => {
    setBody(`
      <form>
        <input type="password" id="pw1">
        <input type="password" id="pw2">
      </form>
    `)
    expect(detectLoginForms(document)).toHaveLength(0)
  })

  test('detects two independent login forms on the same page', () => {
    setBody(`
      <form id="a"><input type="password" id="pwa"></form>
      <form id="b"><input type="password" id="pwb"></form>
    `)
    const forms = detectLoginForms(document)
    expect(forms).toHaveLength(2)
    expect(forms.map((f) => f.passwordEl.id).sort()).toEqual(['pwa', 'pwb'])
  })

  test('nothing on a page with no password field', () => {
    setBody('<form><input type="text"></form>')
    expect(detectLoginForms(document)).toHaveLength(0)
  })
})
