<script lang="ts">
  import { onMount } from 'svelte'
  import { rpc } from '../../ui/lib/rpc'
  import { RpcError } from '../../ui/lib/messaging'
  import { describeError, qualityLabel } from '../../ui/lib/format'
  import type { Candidate } from '../../background/service'

  const { tabId }: { tabId: number } = $props()

  let loading = $state(true)
  let error = $state<string | null>(null)
  let candidates = $state<readonly Candidate[]>([])
  let fillingKey = $state<string | null>(null)
  let filledKey = $state<string | null>(null)
  let pendingDowngrade = $state<Candidate | null>(null)

  function keyOf(candidate: Pick<Candidate, 'mount' | 'path'>): string {
    return `${candidate.mount}:${candidate.path}`
  }

  onMount(load)

  async function load() {
    loading = true
    error = null
    try {
      const result = await rpc.matchesForTab(tabId)
      candidates = result.candidates
    } catch (err) {
      error = describeError(err)
    } finally {
      loading = false
    }
  }

  async function fill(candidate: Candidate, allowDowngrade = false) {
    const key = keyOf(candidate)
    fillingKey = key
    error = null
    try {
      await rpc.fill({ tabId, mount: candidate.mount, path: candidate.path, allowDowngrade })
      pendingDowngrade = null
      filledKey = key
      setTimeout(() => {
        if (filledKey === key) filledKey = null
      }, 1500)
    } catch (err) {
      if (err instanceof RpcError && err.kind === 'downgrade') {
        pendingDowngrade = candidate
      } else {
        error = describeError(err)
      }
    } finally {
      fillingKey = null
    }
  }
</script>

<div class="picker">
  {#if loading}
    <p class="hint">Looking for credentials…</p>
  {:else if error}
    <p class="error" role="alert">{error}</p>
  {:else if candidates.length === 0}
    <p class="hint">No credential matches this page.</p>
  {:else}
    <ul>
      {#each candidates as candidate (keyOf(candidate))}
        {@const key = keyOf(candidate)}
        <li>
          <div class="row">
            <div class="info">
              <span class="title">{candidate.title}</span>
              <span class="quality">{qualityLabel(candidate.quality)}</span>
            </div>
            <button
              type="button"
              onclick={() => fill(candidate)}
              disabled={fillingKey === key}
            >
              {#if filledKey === key}
                Filled ✓
              {:else if fillingKey === key}
                Filling…
              {:else}
                Fill
              {/if}
            </button>
          </div>
          {#if pendingDowngrade && keyOf(pendingDowngrade) === key}
            <div class="downgrade" role="alert">
              <p>This page is not using https. Fill anyway?</p>
              <div class="downgrade-actions">
                <button type="button" onclick={() => fill(candidate, true)}>Fill anyway</button>
                <button type="button" onclick={() => (pendingDowngrade = null)}>Cancel</button>
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  li {
    border: 1px solid light-dark(#ddd, #444);
    border-radius: 6px;
    padding: 0.5rem 0.6rem;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .info {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .quality {
    font-size: 0.75rem;
    opacity: 0.7;
  }
  button {
    padding: 0.3rem 0.6rem;
    cursor: pointer;
    flex-shrink: 0;
  }
  button:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .downgrade {
    margin-top: 0.4rem;
    padding: 0.4rem 0.5rem;
    border-radius: 4px;
    background: light-dark(#fdf3e7, #4a3a1a);
    font-size: 0.8rem;
  }
  .downgrade p {
    margin: 0 0 0.35rem;
  }
  .downgrade-actions {
    display: flex;
    gap: 0.4rem;
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
