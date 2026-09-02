import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Tests always run in mock mode, independent of the developer's .env —
    // they must never hit real provider APIs (mailboxes or Anthropic).
    env: {
      MAILBOX_MOCK: 'true',
      ANTHROPIC_API_KEY: '',
      WORKSPACE_MODE: 'personal',
      // Dedicated test DB — test fixtures never pollute the dev database.
      DATABASE_URL: 'postgresql://reply:reply@localhost:5433/reply_dashboard_test',
    },
  },
});
