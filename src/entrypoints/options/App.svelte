<script lang="ts">
  import { onMount } from 'svelte'
  import { rpc } from '../../ui/lib/rpc'
  import { statusStore } from '../../ui/lib/status.svelte'
  import { describeError } from '../../ui/lib/format'
  import Wizard from './Wizard.svelte'
  import Settings from './Settings.svelte'
  import type { ExtensionConfig } from '../../background/config'
  import type { WizardDraft } from '../../ui/lib/draft'

  let loading = $state(true)
  let loadError = $state<string | null>(null)
  let config = $state<ExtensionConfig | null>(null)
  let mode = $state<'wizard' | 'settings'>('wizard')
  let wizardPrefill = $state<WizardDraft | undefined>(undefined)

  onMount(load)

  async function load() {
    loading = true
    loadError = null
    try {
      const [loadedConfig] = await Promise.all([rpc.getConfig(), statusStore.refresh()])
      config = loadedConfig
      mode = config === null ? 'wizard' : 'settings'
    } catch (err) {
      loadError = describeError(err)
    } finally {
      loading = false
    }
  }

  async function onWizardDone() {
    await load()
  }

  function onReconfigure(prefill: WizardDraft) {
    wizardPrefill = prefill
    mode = 'wizard'
  }
</script>

<main>
  <h1>VaultCredsFiller</h1>

  {#if loading}
    <p class="hint">Loading…</p>
  {:else if loadError}
    <p class="error" role="alert">{loadError}</p>
  {:else if mode === 'wizard'}
    <Wizard prefill={wizardPrefill} onDone={onWizardDone} />
  {:else if config !== null}
    <Settings {config} {onReconfigure} />
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    color-scheme: light dark;
    font-family: system-ui, sans-serif;
  }
  main {
    max-width: 34rem;
    margin: 0 auto;
    padding: 2rem 1.25rem;
  }
  h1 {
    font-size: 1.2rem;
  }
  .hint {
    opacity: 0.8;
  }
  .error {
    color: #c0392b;
  }
</style>
