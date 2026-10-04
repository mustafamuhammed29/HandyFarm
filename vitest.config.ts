import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    environmentMatchGlobs: [
      // Component tests that need a DOM (React Testing Library) run in happy-dom.
      ['tests/ui-*.test.ts', 'happy-dom'],
      ['tests/ui-*.test.tsx', 'happy-dom'],
    ],
  },
});
