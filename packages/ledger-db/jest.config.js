/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/?(*.)+(spec|test).ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
    // The migrate CLI's process entry point: argv, env and streams.
    '!src/cli/**',
  ],
  // The isolation boundary of the document index lives here: held higher than
  // the other packages. The RLS matrix itself is `test:db` (itest/).
  coverageThreshold: {
    global: { branches: 85, functions: 85, lines: 90, statements: 90 },
  },
};
