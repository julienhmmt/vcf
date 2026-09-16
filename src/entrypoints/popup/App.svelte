<script lang="ts">
  import { onMount } from 'svelte'
  import { browser } from 'wxt/browser'
  import { statusStore } from '../../ui/lib/status.svelte'
  import { rpc } from '../../ui/lib/rpc'
  import { formatRelativeTime } from '../../ui/lib/format'
  import Unlock from '../../ui/components/Unlock.svelte'
  import Picker from './Picker.svelte'

  let tabId = $state<number | null>(null)
  let now = $state(Date.now())
  let refreshing = $state(false)

  onMount(() => {
    void init()
    const interval = setInterval(() => {
      now = Date.now()
    }, 15_000)
    return () => clearInterval(interval)
  })

  async function init() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
    tabId = tab?.id ?? null
    await statusStore.refresh()
  }

  function openSetup() {
    void browser.runtime.openOptionsPage()
  }

  async function lock() {
    await rpc.lock()
    await statusStore.refresh()
  }

  async function refreshIndex() {
    refreshing = true
    try {
      await rpc.refreshIndex()
    } catch {
      // status below still reflects what actually happened
    } finally {
      refreshing = false
      await statusStore.refresh()
    }
  }
</script>

<main>
  <header>
    <h1>VaultCredsFiller</h1>
    {#if statusStore.status?.unlocked}
      <button type="button" class="link" onclick={lock}>Lock</button>
    {/if}
  </header>

  {#if statusStore.loading && statusStore.status === null}
    <p class="hint">Loading…</p>
  {:else if statusStore.error}
    <p class="error" role="alert">{statusStore.error}</p>
  {:else if statusStore.status === null || !statusStore.status.configured}
    <div class="empty">
      <p>VaultCredsFiller is not set up yet.</p>
      <button type="button" onclick={openSetup}>Open setup</button>
    </div>
  {:else if !statusStore.status.unlocked}
    <Unlock />
  {:else}
    {#if tabId !== null}
      <Picker {tabId} />
    {/if}
    <footer>
      <span class="index-status">
        {statusStore.status.index.count} credential{statusStore.status.index.count === 1 ? '' : 's'}
        {#if statusStore.status.index.builtAt !== null}
          · updated {formatRelativeTime(statusStore.status.index.builtAt, now)}
        {/if}
        {#if statusStore.status.index.problems > 0}
          · {statusStore.status.index.problems} inaccessible
        {/if}
      </span>
      <button type="button" class="link" onclick={refreshIndex} disabled={refreshing}>
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
    </footer>
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    color-scheme: light dark;
    font-family: system-ui, sans-serif;
  }
  main {
    width: 320px;
    padding: 0.75rem 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    font-size: 0.9rem;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h1 {
    font-size: 1rem;
    margin: 0;
  }
  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: 0.75rem;
    opacity: 0.8;
  }
  .index-status {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  button {
    padding: 0.45rem 0.7rem;
    cursor: pointer;
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
    font-size: 0.8rem;
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
