/**
 * The DB integration tests (`test:db`): the RLS matrix, verify.sql, the
 * pool-leak test and the repositories against a real PostgreSQL 16.
 *
 * `itest/globalSetup.js` uses LEDGER_TEST_DATABASE_URL when it is set (CI's
 * postgres:16 service container), and otherwise starts a throwaway
 * `postgres:16` container with Docker and removes it afterwards. The URL must
 * be a superuser's: the tests run the migrations and create their own logins.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/itest'],
  testMatch: ['**/*.itest.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/itest/tsconfig.json' }] },
  globalSetup: '<rootDir>/itest/globalSetup.js',
  globalTeardown: '<rootDir>/itest/globalTeardown.js',
  testTimeout: 60_000,
};
