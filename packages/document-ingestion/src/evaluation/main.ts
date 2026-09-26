/**
 * Entry point of `yarn workspace @bcr/document-ingestion eval` and `eval:truth`:
 * wiring only (the file system and the process), see ./cli.ts. Never loaded by
 * the Function App.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { runCli } from './cli';

void runCli(process.argv.slice(2), {
  env: process.env,
  readFile: (path) => readFile(path),
  writeFile: (path, data) => writeFile(path, data, { mode: 0o600 }),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}).then((code) => {
  process.exitCode = code;
});
