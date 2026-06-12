/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/?(*.)+(spec|test).ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/functions/**', '!src/index.ts'],
  coverageThreshold: {
    global: { branches: 75, functions: 80, lines: 85, statements: 85 },
  },
};
