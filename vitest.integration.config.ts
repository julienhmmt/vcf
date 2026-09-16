import { defineConfig } from 'vitest/config'

// Runs against the servers from dev/docker-compose.yml:
//   docker compose -f dev/docker-compose.yml up -d --wait
//   npm run test:integration
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 15_000,
  },
})
