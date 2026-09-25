/**
 * Shared plumbing for the operator tools: arguments, output files, hashing,
 * CSV and terminal colour. No Graph and no tenant logic lives here.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** `tools/out/`, which git ignores. Outputs hold tenant data and never get committed. */
export const DEFAULT_OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'out');

const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColour ? `\u001b[${code}m${s}\u001b[0m` : String(s));
export const ok = paint('32');
export const bad = paint('31');
export const warn = paint('33');
export const dim = paint('2');
export const bold = paint('1');

/**
 * A refusal or a usage error. The tools throw it instead of calling
 * `process.exit`, so a test can drive a whole command and assert on the
 * refusal. `runMain` turns it into `✖ message` and the exit code.
 */
export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/**
 * `node:util` `parseArgs`, strict, with positionals. A typo in a flag is an
 * error, never silently ignored: `--aply` must not run as a dry run that the
 * operator believes was the real thing, or the other way round.
 */
export function parseCli(argv, options) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new CliError(`${err.message}\nRun with --help for usage.`);
  }
}

/** Whether the module at `importMetaUrl` is the script node was started with. */
export function isMain(importMetaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

/**
 * Run a tool's `main(argv)` and exit with its code. A `CliError` prints as a
 * one-line refusal; anything else prints its message only. Neither prints a
 * stack by default, and no path here ever prints the token: the Graph client
 * redacts it from every error it builds.
 */
export function runMain(main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code ?? 0;
    },
    (err) => {
      console.error(`\n✖ ${err?.message ?? err}\n`);
      if (process.env.TOOLS_DEBUG && err?.stack) console.error(err.stack);
      process.exitCode = err instanceof CliError ? err.exitCode : 1;
    },
  );
}

export function fail(message, code = 1) {
  console.error(`\n✖ ${message}\n`);
  process.exit(code);
}

/** `2026-09-25T10-11-12Z`: sortable and safe in a file name. */
export function stamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

/** Write all of `content` to a new file, fsync it and close it. `flag` is `wx`: never an existing file. */
function writeNewFile(path, content) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** So that a rename or a new file survives a crash. Best effort: not every platform allows it. */
function fsyncDir(dir) {
  let fd;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // A directory that cannot be opened or synced (Windows) keeps the file
    // durable only as far as the file's own fsync goes.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Write a file readable only by its owner. Evidence and plans carry client
 * names and ids; a world-readable file in a shared home directory is a leak.
 *
 * The write survives a crash: the content goes to a temporary file beside the
 * target, is fsynced, and is renamed over it. A crash leaves the old file or
 * the new one, never a truncated one, which a later reader would refuse
 * whole. With `exclusive`, the target must not exist yet: a check report,
 * a plan, an apply log or a rollback log never replaces another file (an
 * earlier log that rollback needs, or the plan).
 *
 * @param {string} path
 * @param {string} content
 * @param {{exclusive?: boolean}} [opts]
 */
export function writePrivateFile(path, content, { exclusive = false } = {}) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (exclusive) {
    try {
      writeNewFile(path, content);
    } catch (err) {
      if (err.code === 'EEXIST') {
        throw new CliError(`${path} exists; choose a new name. An output never replaces another file.`);
      }
      throw err;
    }
  } else {
    const tmp = `${path}.tmp-${process.pid}`;
    try {
      unlinkSync(tmp); // left by a run that died between write and rename
    } catch {
      // usually absent
    }
    writeNewFile(tmp, content);
    renameSync(tmp, path);
  }
  fsyncDir(dir);
  return { path, sha256: sha256(content) };
}

/**
 * Refuse an output path that already exists, before a long run rather than at
 * its end. The write itself is still exclusive; this only fails sooner.
 */
export function assertNewFile(path) {
  if (existsSync(path)) {
    throw new CliError(`${path} exists; choose a new name. An output never replaces another file.`);
  }
}

export function writeJsonFile(path, data, opts) {
  return writePrivateFile(path, `${JSON.stringify(data, null, 2)}\n`, opts);
}

export function readJsonFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new CliError(`cannot read ${path}: ${err.code ?? err.message}`);
  }
  try {
    return { data: JSON.parse(text), sha256: sha256(text) };
  } catch (err) {
    throw new CliError(`${path} is not JSON: ${err.message}`);
  }
}

export function outPath(dir, name) {
  return join(dir ?? DEFAULT_OUT_DIR, name);
}

/** `a,b , c` → `['a','b','c']`. Empty and whitespace-only entries are dropped. */
export function csvList(value) {
  if (value === undefined || value === null) return [];
  const parts = Array.isArray(value) ? value : [value];
  return parts
    .flatMap((v) => String(v).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * One CSV cell, RFC 4180 quoted.
 *
 * A cell that starts with `=`, `+`, `-`, `@`, tab or carriage return is
 * prefixed with `'`. File names in the register come from uploaders, and the
 * register is opened in Excel by people who did not write it; a name like
 * `=HYPERLINK(...)` must stay text.
 */
export function csvCell(value) {
  if (value === undefined || value === null) return '';
  let s = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, columns) {
  const lines = [columns.map((c) => csvCell(c.header ?? c.key)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(c.get ? c.get(row) : row[c.key])).join(','));
  }
  // A BOM, so Excel opens Polish file names as UTF-8 rather than as mojibake.
  return `﻿${lines.join('\r\n')}\r\n`;
}
