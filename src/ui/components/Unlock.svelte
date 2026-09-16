<script lang="ts">
  import { onMount } from 'svelte'
  import { rpc } from '../lib/rpc'
  import { describeError } from '../lib/format'
  import { statusStore } from '../lib/status.svelte'
  import type { AuthMethod } from '../../vault/auth'
  import type { ExtensionConfig } from '../../background/config'

  let config = $state<ExtensionConfig | null>(null)
  let secret = $state('')
  let submitting = $state(false)
  let error = $state<string | null>(null)
  let oidcInFlight = $state(false)

  onMount(async () => {
    try {
      config = await rpc.getConfig()
    } catch (err) {
      error = describeError(err)
    }
  })

  function methodOf(): AuthMethod | null {
    return config?.auth.method ?? null
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    const method = methodOf()
    if (method === null) return

    submitting = true
    error = null
    try {
      if (method === 'token') {
        await rpc.login({ method: 'token', token: secret })
      } else if (method === 'userpass' || method === 'ldap') {
        await rpc.login({ method, password: secret })
      } else if (method === 'approle') {
        await rpc.login({ method: 'approle', secretId: secret })
      }
      secret = ''
      await statusStore.refresh()
    } catch (err) {
      error = describeError(err)
    } finally {
      submitting = false
    }
  }

  async function signInWithOidc() {
    oidcInFlight = true
    error = null
    try {
      await rpc.login({ method: 'oidc' })
      await statusStore.refresh()
    } catch (err) {
      error = describeError(err)
    } finally {
      oidcInFlight = false
    }
  }
</script>

{#if config == null && error !== null}
  <p class="error" role="alert">{error}</p>
{:else if config == null}
  <p class="hint">Loading setup…</p>
{:else if methodOf() === 'oidc'}
  <div class="unlock">
    <p class="hint">Sign in through your identity provider.</p>
    <button type="button" onclick={signInWithOidc} disabled={oidcInFlight}>
      {oidcInFlight ? 'Waiting for sign-in…' : 'Sign in'}
    </button>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>
{:else}
  <form class="unlock" onsubmit={submit}>
    {#if config.auth.method === 'userpass' || config.auth.method === 'ldap'}
      <p class="hint">Signing in as <strong>{config.auth.username}</strong></p>
      <label>
        Password
        <!-- svelte-ignore a11y_autofocus -->
        <input type="password" bind:value={secret} autocomplete="current-password" required autofocus />
      </label>
    {:else if config.auth.method === 'approle'}
      <p class="hint">Role: <strong>{config.auth.roleId}</strong></p>
      <label>
        Secret ID
        <!-- svelte-ignore a11y_autofocus -->
        <input type="password" bind:value={secret} required autofocus />
      </label>
    {:else}
      <label>
        Vault token
        <!-- svelte-ignore a11y_autofocus -->
        <input type="password" bind:value={secret} autocomplete="off" required autofocus />
      </label>
    {/if}
    <button type="submit" disabled={submitting || secret === ''}>
      {submitting ? 'Signing in…' : 'Unlock'}
    </button>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </form>
{/if}

<style>
  .unlock {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.85rem;
  }
  input {
    padding: 0.4rem 0.5rem;
    font-size: 0.9rem;
  }
  button {
    padding: 0.45rem 0.7rem;
    cursor: pointer;
  }
  button:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .hint {
    font-size: 0.85rem;
    opacity: 0.8;
    margin: 0;
  }
  .error {
    color: #c0392b;
    font-size: 0.85rem;
    margin: 0;
  }
</style>
