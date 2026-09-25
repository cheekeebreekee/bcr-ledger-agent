/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/?(*.)+(spec|test).ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    // HTTP registration and cold-start wiring: tested through the services
    // they wire, not by booting the Function host.
    '!src/functions/**',
    '!src/index.ts',
    '!src/runtime.ts',
  ],
  coverageThreshold: {
    global: { branches: 75, functions: 80, lines: 85, statements: 85 },
  },
};
