<script lang="ts">
  import { untrack } from 'svelte'
  import { rpc } from '../../ui/lib/rpc'
  import { describeError, formatRelativeTime } from '../../ui/lib/format'
  import { statusStore } from '../../ui/lib/status.svelte'
  import type { ExtensionConfig } from '../../background/config'
  import type { WizardDraft } from '../../ui/lib/draft'

  const {
    config,
    onReconfigure,
  }: { config: ExtensionConfig; onReconfigure: (prefill: WizardDraft) => void } = $props()

  // A deliberate one-time snapshot: local edits must survive an
  // unrelated status/config refresh while this page stays open.
  let lockAfterMinutes = $state(untrack(() => config.lockAfterMinutes))
  let refreshEveryMinutes = $state(untrack(() => config.refreshEveryMinutes))
  let mountsMode = $state(untrack(() => config.mounts.mode))
  let mountsPaths = $state(
    untrack(() => (config.mounts.mode === 'manual' ? config.mounts.paths.join(', ') : '')),
  )

  let saving = $state(false)
  let signingOut = $state(false)
  let error = $state<string | null>(null)
  let saved = $state(false)
  let now = $state(Date.now())

  setInterval(() => {
    now = Date.now()
  }, 15_000)

  const methodLabel: Record<string, string> = {
    token: 'Token',
    userpass: 'Username & password',
    ldap: 'LDAP',
    approle: 'AppRole',
    oidc: 'OIDC',
  }

  async function save() {
    error = null
    saved = false
    const paths = mountsPaths
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '')
    if (mountsMode === 'manual' && paths.length === 0) {
      error = 'List at least one mount path, or switch to automatic discovery.'
      return
    }

    saving = true
    try {
      await rpc.saveConfig({
        address: config.address,
        ...(config.namespace ? { namespace: config.namespace } : {}),
        auth: config.auth,
        mounts: mountsMode === 'auto' ? { mode: 'auto' } : { mode: 'manual', paths },
        lockAfterMinutes,
        refreshEveryMinutes,
      })
      saved = true
      await statusStore.refresh()
    } catch (err) {
      error = describeError(err)
    } finally {
      saving = false
    }
  }

  async function signOut() {
    signingOut = true
    error = null
    try {
      await rpc.logout()
      await statusStore.refresh()
    } catch (err) {
      error = describeError(err)
    } finally {
      signingOut = false
    }
  }

  function reconfigure() {
    const auth = config.auth
    onReconfigure({
      address: config.address,
      namespace: config.namespace,
      authMethod: auth.method,
      mount: 'mount' in auth ? auth.mount : '',
      username: 'username' in auth ? auth.username : '',
      roleId: 'roleId' in auth ? auth.roleId : '',
      role: 'role' in auth ? auth.role ?? '' : '',
    })
  }
</script>

<div class="settings">
  <section>
    <h2>Connection</h2>
    <dl>
      <dt>Server</dt>
      <dd>{config.address}</dd>
      {#if config.namespace}
        <dt>Namespace</dt>
        <dd>{config.namespace}</dd>
      {/if}
      <dt>Authentication</dt>
      <dd>{methodLabel[config.auth.method]}</dd>
    </dl>
    <div class="actions">
      <button type="button" onclick={reconfigure}>Reconfigure</button>
      {#if statusStore.status?.unlocked}
        <button type="button" onclick={signOut} disabled={signingOut}>
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      {/if}
    </div>
  </section>

  {#if statusStore.status?.unlocked}
    <section>
      <h2>Session</h2>
      <dl>
        {#if statusStore.status.expiresAt !== null}
          <dt>Token expires</dt>
          <dd>{formatRelativeTime(statusStore.status.expiresAt, now)}</dd>
        {/if}
        {#if statusStore.status.lockAt !== null}
          <dt>Locks</dt>
          <dd>{formatRelativeTime(statusStore.status.lockAt, now)}</dd>
        {/if}
      </dl>
    </section>
  {/if}

  <section>
    <h2>Preferences</h2>
    <label>
      Lock after inactivity (minutes)
      <input type="number" min="1" max="1440" bind:value={lockAfterMinutes} />
    </label>
    <label>
      Refresh credential index every (minutes)
      <input type="number" min="1" max="1440" bind:value={refreshEveryMinutes} />
    </label>
    <label class="radio">
      <input type="radio" bind:group={mountsMode} value="auto" />
      Discover kv mounts automatically
    </label>
    <label class="radio">
      <input type="radio" bind:group={mountsMode} value="manual" />
      Use only these mounts
    </label>
    {#if mountsMode === 'manual'}
      <label>
        Mount paths <span class="optional">(comma-separated)</span>
        <input type="text" bind:value={mountsPaths} placeholder="secret, team" />
      </label>
    {/if}
    <div class="actions">
      <button type="button" onclick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      {#if saved}<span class="hint">Saved.</span>{/if}
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </section>
</div>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    gap: 1.2rem;
    max-width: 28rem;
  }
  h2 {
    font-size: 1rem;
    margin: 0 0 0.5rem;
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.2rem 0.7rem;
    margin: 0;
    font-size: 0.9rem;
  }
  dt {
    opacity: 0.7;
  }
  dd {
    margin: 0;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.9rem;
    margin-bottom: 0.5rem;
  }
  label.radio {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
  }
  .optional {
    font-weight: normal;
    opacity: 0.65;
    font-size: 0.8rem;
  }
  input {
    padding: 0.4rem 0.5rem;
    font-size: 0.9rem;
  }
  input[type='number'] {
    width: 6rem;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
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
  }
  .error {
    color: #c0392b;
    font-size: 0.85rem;
    margin: 0;
  }
</style>
