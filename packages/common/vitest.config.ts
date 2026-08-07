import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@agentic-context-manager/common',
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['dist/**'],
  },
});
