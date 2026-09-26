import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';

export default [
  {
    files: ['packages/**/src/**/*.ts', 'packages/**/itest/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        // Not the package tsconfigs: they exclude *.test.ts (kept out of dist), so
        // tests would fail to parse. tsconfig.eslint.json covers src/, tests and
        // the DB integration tests (packages/ledger-db/itest).
        project: ['./tsconfig.eslint.json'],
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  prettier,
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'],
  },
];
