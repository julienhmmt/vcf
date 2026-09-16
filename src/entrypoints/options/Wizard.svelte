<script lang="ts">
  import { onMount } from 'svelte'
  import { browser } from 'wxt/browser'
  import { rpc } from '../../ui/lib/rpc'
  import { describeError } from '../../ui/lib/format'
  import { statusStore } from '../../ui/lib/status.svelte'
  import { clearDraft, loadDraft, saveDraft } from '../../ui/lib/draft'
  import { hostPattern } from '../../background/config'
  import Unlock from '../../ui/components/Unlock.svelte'
  import type { WizardDraft } from '../../ui/lib/draft'

  const { prefill, onDone }: { prefill?: WizardDraft; onDone: () => void } = $props()

  type Step = 'server' | 'signin' | 'done'
  let step = $state<Step>('server')
  let submitting = $state(false)
  let error = $state<string | null>(null)

  let address = $state('')
  let namespace = $state('')
  let authMethod = $state<WizardDraft['authMethod']>('userpass')
  let mount = $state('')
  let username = $state('')
  let roleId = $state('')
  let role = $state('')

  let draftTimer: ReturnType<typeof setTimeout> | undefined

  onMount(async () => {
    const draft = prefill ?? (await loadDraft())
    address = draft.address ?? ''
    namespace = draft.namespace ?? ''
    authMethod = draft.authMethod ?? 'userpass'
    mount = draft.mount ?? ''
    username = draft.username ?? ''
    roleId = draft.roleId ?? ''
    role = draft.role ?? ''
  })

  // Non-secret only: no password/secret id field feeds into this draft.
  $effect(() => {
    if (step !== 'server') return
    const snapshot: WizardDraft = { address, namespace, authMethod, mount, username, roleId, role }
    clearTimeout(draftTimer)
    draftTimer = setTimeout(() => void saveDraft(snapshot), 400)
  })

  $effect(() => {
    if (step === 'signin' && statusStore.status?.unlocked) step = 'done'
  })

  function buildAuth() {
    const trimmedMount = mount.trim()
    const withMount = trimmedMount === '' ? {} : { mount: trimmedMount }
    switch (authMethod) {
      case 'userpass':
      case 'ldap':
        return { method: authMethod, username: username.trim(), ...withMount }
      case 'approle':
        return { method: 'approle', roleId: roleId.trim(), ...withMount }
      case 'oidc':
        return { method: 'oidc', ...withMount, ...(role.trim() === '' ? {} : { role: role.trim() }) }
      default:
        return { method: 'token' }
    }
  }

  function validate(): string | null {
    if (address.trim() === '') return 'Enter the Vault address.'
    if ((authMethod === 'userpass' || authMethod === 'ldap') && username.trim() === '') {
      return 'Enter a username.'
    }
    if (authMethod === 'approle' && roleId.trim() === '') return 'Enter a role ID.'
    return null
  }

  async function next() {
    error = null
    const problem = validate()
    if (problem !== null) {
      error = problem
      return
    }

    submitting = true
    try {
      // Called as directly as possible from the click for user-activation.
      const granted = await browser.permissions.request({ origins: [hostPattern(address.trim())] })
      if (!granted) {
        error = 'Access to the Vault server is required to continue.'
        return
      }
      await rpc.saveConfig({
        address: address.trim(),
        ...(namespace.trim() === '' ? {} : { namespace: namespace.trim() }),
        auth: buildAuth(),
      })
      await clearDraft()
      step = 'signin'
    } catch (err) {
      error = describeError(err)
    } finally {
      submitting = false
    }
  }

  function back() {
    error = null
    step = 'server'
  }
</script>

<div class="wizard">
  {#if step === 'server'}
    <h2>Connect to Vault or OpenBao</h2>
    <label>
      Address
      <input type="url" bind:value={address} placeholder="https://vault.example.net:8200" required />
    </label>
    <label>
      Namespace <span class="optional">(optional, Vault Enterprise only)</span>
      <input type="text" bind:value={namespace} placeholder="team-a" />
    </label>

    <label>
      Authentication method
      <select bind:value={authMethod}>
        <option value="userpass">Username &amp; password</option>
        <option value="ldap">LDAP</option>
        <option value="approle">AppRole</option>
        <option value="oidc">OIDC</option>
        <option value="token">Token</option>
      </select>
    </label>

    {#if authMethod === 'userpass' || authMethod === 'ldap'}
      <label>
        Username
        <input type="text" bind:value={username} required autocomplete="username" />
      </label>
      <label>
        Mount path <span class="optional">(optional, default "{authMethod}")</span>
        <input type="text" bind:value={mount} placeholder={authMethod} />
      </label>
    {:else if authMethod === 'approle'}
      <label>
        Role ID
        <input type="text" bind:value={roleId} required />
      </label>
      <label>
        Mount path <span class="optional">(optional, default "approle")</span>
        <input type="text" bind:value={mount} placeholder="approle" />
      </label>
    {:else if authMethod === 'oidc'}
      <label>
        Role <span class="optional">(optional)</span>
        <input type="text" bind:value={role} />
      </label>
      <label>
        Mount path <span class="optional">(optional, default "oidc")</span>
        <input type="text" bind:value={mount} placeholder="oidc" />
      </label>
    {/if}

    <button type="button" onclick={next} disabled={submitting}>
      {submitting ? 'Checking…' : 'Next'}
    </button>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  {:else if step === 'signin'}
    <h2>Sign in</h2>
    <Unlock />
    <button type="button" class="link" onclick={back}>Back</button>
  {:else}
    <h2>You're all set</h2>
    <p>VaultCredsFiller is connected and signed in.</p>
    <button type="button" onclick={onDone}>Continue</button>
  {/if}
</div>

<style>
  .wizard {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    max-width: 26rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.9rem;
  }
  .optional {
    font-weight: normal;
    opacity: 0.65;
    font-size: 0.8rem;
  }
  input,
  select {
    padding: 0.45rem 0.55rem;
    font-size: 0.9rem;
  }
  button {
    padding: 0.5rem 0.8rem;
    cursor: pointer;
    align-self: flex-start;
  }
  button:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    color: light-dark(#1a5fb4, #62a0ea);
  }
  .error {
    color: #c0392b;
    font-size: 0.85rem;
    margin: 0;
  }
</style>
