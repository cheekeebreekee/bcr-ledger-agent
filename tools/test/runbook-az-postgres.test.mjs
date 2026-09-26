import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, test } from 'node:test';

import { REPO } from '../check-app-settings.mjs';

// ---------------------------------------------------------------------------
// The `az postgres flexible-server` commands the docs tell an operator to run.
//
// The Document index release shipped with `firewall-rule … -n <server>
// --rule-name <rule>` and `ad-admin list`, none of which the CLI accepts: the
// operator's firewall rule was never created (no psql, no login, no
// migrations), never deleted, and the daily verify.sql check never ran. The
// argument names below are copied from `az postgres flexible-server <command>
// --help` (Azure CLI 2.87.0). A command or flag missing here fails the test:
// check its `--help`, then add it.
// ---------------------------------------------------------------------------

const GLOBAL = ['-o', '--output', '--query', '--subscription', '--only-show-errors', '--debug'];

/** Per command: the flags it accepts, and whether it must name the server with `-s`. */
const COMMANDS = {
  list: { flags: ['-g', '--resource-group', '--show-cluster'] },
  show: { flags: ['-g', '--resource-group', '-n', '--name', '--ids'] },
  delete: { flags: ['-g', '--resource-group', '-n', '--name', '--ids', '-y', '--yes'] },
  // -s is the server, -n the RULE; there is no --rule-name.
  'firewall-rule create': {
    server: true,
    flags: [
      '-g',
      '--resource-group',
      '-s',
      '--server-name',
      '-n',
      '--name',
      '--start-ip-address',
      '--end-ip-address',
    ],
  },
  'firewall-rule delete': {
    server: true,
    flags: [
      '-g',
      '--resource-group',
      '-s',
      '--server-name',
      '-n',
      '--name',
      '--ids',
      '-y',
      '--yes',
    ],
  },
  'firewall-rule list': {
    server: true,
    flags: ['-g', '--resource-group', '-s', '--server-name', '--ids'],
  },
  // Formerly `ad-admin`, which the CLI no longer recognises.
  'microsoft-entra-admin list': {
    server: true,
    flags: ['-g', '--resource-group', '-s', '--server-name', '--ids'],
  },
};

/** Committed text an operator reads or runs: docs, READMEs, CLAUDE.md, SQL, scripts. */
function operatorDocs() {
  const out = [];
  // `out` is tools/out/: ignored client data (evaluation reports), never scanned.
  const skip = new Set(['node_modules', 'dist', 'out', 'artifacts', 'coverage']);
  const walk = (abs) => {
    for (const name of readdirSync(abs)) {
      if (skip.has(name) || name.startsWith('.')) continue;
      const child = join(abs, name);
      if (statSync(child).isDirectory()) walk(child);
      else if (/\.(md|sql|sh)$/.test(name)) out.push(relative(REPO, child));
    }
  };
  walk(REPO);
  return out.sort();
}

/**
 * Every `az postgres flexible-server …` command in `text`, continuation lines
 * joined, cut at the end of the command (a pipe, `&&`, `;`, `)` or a comment).
 */
export function azPostgresCommands(text) {
  const joined = text.replace(/\\\n\s*/g, ' ');
  const commands = [];
  for (const m of joined.matchAll(/az postgres flexible-server ([^\n]*)/g)) {
    const rest = m[1].split(/\s(?:\||&&|;|#)|\)\s*$|`/)[0];
    const tokens = rest.trim().split(/\s+/).filter(Boolean);
    const words = [];
    while (tokens.length && !tokens[0].startsWith('-')) words.push(tokens.shift());
    const flags = tokens.filter((t) => /^--?[a-z]/i.test(t));
    commands.push({ command: words.join(' '), flags, source: m[0] });
  }
  return commands;
}

describe('the az postgres commands in the docs', () => {
  const found = operatorDocs().flatMap((file) =>
    azPostgresCommands(readFileSync(join(REPO, file), 'utf8')).map((c) => ({ ...c, file })),
  );

  test('are found, in the Document index release', () => {
    const runbook = found.filter((c) => c.file === 'docs/operations/human-steps.md');
    assert.ok(runbook.some((c) => c.command === 'firewall-rule create'));
    assert.ok(runbook.some((c) => c.command === 'firewall-rule delete'));
    assert.ok(runbook.some((c) => c.command === 'microsoft-entra-admin list'));
  });

  test('are commands the CLI has, with flags it accepts, and name the server with -s', () => {
    const offenders = [];
    for (const c of found) {
      const spec = COMMANDS[c.command];
      if (!spec) {
        offenders.push(`${c.file}: unknown command "${c.command}": ${c.source}`);
        continue;
      }
      for (const flag of c.flags) {
        if (!spec.flags.includes(flag) && !GLOBAL.includes(flag)) {
          offenders.push(`${c.file}: ${c.command} has no ${flag}: ${c.source}`);
        }
      }
      if (spec.server && !c.flags.some((f) => f === '-s' || f === '--server-name')) {
        offenders.push(`${c.file}: ${c.command} names no server (-s): ${c.source}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  test('the parser sees what the CLI would refuse', () => {
    const [bad] = azPostgresCommands(
      'az postgres flexible-server firewall-rule create -g $RG -n $DB_SERVER --rule-name $R \\\n' +
        '  --start-ip-address $IP --end-ip-address $IP -o none &&\n',
    );
    assert.deepEqual(bad, {
      command: 'firewall-rule create',
      flags: ['-g', '-n', '--rule-name', '--start-ip-address', '--end-ip-address', '-o'],
      source: bad.source,
    });
    const [adAdmin] = azPostgresCommands('az postgres flexible-server ad-admin list -g x -s y\n');
    assert.equal(adAdmin.command, 'ad-admin list');
    assert.equal(COMMANDS[adAdmin.command], undefined);
  });
});
