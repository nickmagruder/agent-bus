import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  // Type-aware rules for mistakes agents (and people) make that the strict
  // preset doesn't catch: unhandled promises, promises passed where a plain
  // callback is expected, and awaiting non-promises.
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },
  prettier,
  { languageOptions: { globals: globals.node } },
);
