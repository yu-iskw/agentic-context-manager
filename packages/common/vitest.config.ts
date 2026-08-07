import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@typescript-template/common',
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['dist/**'],
  },
});
