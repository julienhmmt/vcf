import { defineConfig } from 'wxt'

// Permissions are the minimum from .claude/skills/mv3-extension:
// the Vault host is requested at setup time, identity only for OIDC.
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-svelte'],
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: 'VaultCredsFiller',
    description: 'Autofill credentials from HashiCorp Vault and OpenBao',
    permissions: ['storage', 'alarms', 'activeTab'],
    optional_permissions: ['identity'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'vaultcredsfiller@julienhmmt.github.io',
              // storage.session, optional_host_permissions, AbortSignal.any
              strict_min_version: '128.0',
              // We only ever talk to the Vault/OpenBao server the user
              // configures — nothing is collected or sent anywhere else.
              data_collection_permissions: { required: ['none'] },
            },
          },
        }
      : { minimum_chrome_version: '116' }),
  }),
})
