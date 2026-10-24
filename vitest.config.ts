import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sharedSrc = fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'shared',
          root: './packages/shared',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        resolve: { alias: { '@pod/shared': sharedSrc } },
        test: {
          name: 'api',
          root: './apps/api',
          include: ['src/**/*.test.ts'],
        },
      },
    ],
  },
});
