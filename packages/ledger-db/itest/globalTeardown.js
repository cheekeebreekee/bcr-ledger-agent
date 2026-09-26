/** Removes the container globalSetup.js started, if it started one. */
const { execFileSync } = require('node:child_process');

module.exports = async function globalTeardown() {
  const id = process.env.LEDGER_TEST_CONTAINER;
  if (!id) return;
  execFileSync('docker', ['rm', '--force', id], { stdio: 'ignore' });
};
