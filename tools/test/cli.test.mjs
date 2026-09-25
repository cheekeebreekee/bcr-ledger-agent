import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  CliError,
  csvCell,
  csvList,
  parseCli,
  readJsonFile,
  sha256,
  stamp,
  toCsv,
  writeJsonFile,
} from '../lib/cli.mjs';

describe('cli helpers', () => {
  test('parseCli is strict: an unknown or misspelt flag is an error', () => {
    const opts = { apply: { type: 'boolean' } };
    const { values, positionals } = parseCli(['x', '--apply'], opts);
    assert.equal(values.apply, true);
    assert.deepEqual(positionals, ['x']);
    assert.throws(() => parseCli(['--aply'], opts), CliError);
  });

  test('csvList splits, trims and drops empties', () => {
    assert.deepEqual(csvList(' a, b ,,c '), ['a', 'b', 'c']);
    assert.deepEqual(csvList(['a,b', 'c']), ['a', 'b', 'c']);
    assert.deepEqual(csvList(undefined), []);
  });

  test('csvCell quotes and defuses formulas', () => {
    assert.equal(csvCell('plain'), 'plain');
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('=1+1'), "'=1+1");
    assert.equal(csvCell('-5'), "'-5");
    assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
    assert.equal(csvCell(-5), "'-5");
    assert.equal(csvCell(true), 'true');
    assert.equal(csvCell(null), '');
    assert.equal(csvCell({ a: 1 }), '"{""a"":1}"');
  });

  test('toCsv writes a BOM, a header and CRLF rows', () => {
    const csv = toCsv([{ a: 'x', b: 'żółć' }], [{ key: 'a' }, { header: 'B', get: (r) => r.b }]);
    assert.equal(csv, '﻿a,B\r\nx,żółć\r\n');
  });

  test('stamp is file-name safe and sortable', () => {
    assert.equal(stamp(new Date('2026-09-25T10:11:12.345Z')), '2026-09-25T10-11-12Z');
  });

  test('writeJsonFile writes owner-only and returns the sha256 of what it wrote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-test-'));
    const file = join(dir, 'nested', 'x.json');
    const { sha256: digest } = writeJsonFile(file, { a: 1 });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(digest, sha256(readFileSync(file)));
    assert.deepEqual(readJsonFile(file).data, { a: 1 });
    assert.throws(() => readJsonFile(join(dir, 'missing.json')), CliError);
  });

  test('a rewrite replaces the file whole, and an exclusive write never replaces one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-test-'));
    const file = join(dir, 'log.json');
    writeJsonFile(file, { n: 1 }, { exclusive: true });
    assert.throws(() => writeJsonFile(file, { n: 2 }, { exclusive: true }), /exists; choose a new name/);
    assert.deepEqual(readJsonFile(file).data, { n: 1 });
    // A temporary file left by a run that died before its rename is replaced.
    writeFileSync(`${file}.tmp-${process.pid}`, 'half a log');
    writeJsonFile(file, { n: 3 });
    assert.deepEqual(readJsonFile(file).data, { n: 3 });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ['log.json']);
  });
});
