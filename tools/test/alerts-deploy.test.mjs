import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { describe, test } from 'node:test';

import { REPO } from '../check-app-settings.mjs';

// ---------------------------------------------------------------------------
// alerts.bicep: a standalone template that may only ever touch the alerts.
// ---------------------------------------------------------------------------

const read = (rel) => readFileSync(join(REPO, rel), 'utf8');
const ALERT_FILES = ['infrastructure/alerts.bicep', 'infrastructure/modules/alerts.bicep'];
const MODULE = 'infrastructure/modules/alerts.bicep';
const ALLOWED = ['Microsoft.Insights/actionGroups', 'Microsoft.Insights/scheduledQueryRules'];

/** Resource types a Bicep file declares (`resource x 'Type@version'`), `existing` included. */
function declaredTypes(source) {
  return [...source.matchAll(/^resource\s+\w+\s+'([^'@]+)@[^']+'/gm)].map((m) => m[1]);
}

const withoutComments = (source) => source.replace(/^\s*\/\/.*$/gm, '');

/**
 * The module's single-quoted Bicep strings, in order, joined by newlines: the
 * rules' KQL (and descriptions, which hold no comparison). `${var}` is left
 * as written.
 */
function bicepStrings(source) {
  return [...withoutComments(source).matchAll(/'((?:[^'\\\n]|\\.)*)'/g)]
    .map((m) => m[1].replace(/\\'/g, "'"))
    .join('\n');
}

/**
 * Every literal a query compares a log field with (`msg == "x"`, `ev in ("a", "b")`,
 * `msg startswith "x"`): the field (`msg`, `ev`, `reason`, … or `tostring(m.x)`),
 * the literal, and whether only its start is compared (`startswith`).
 */
function comparedLiterals(kql) {
  const field = String.raw`\b(msg|ev|reason|stage|code|tostring\(m\.\w+\))`;
  const out = new Map();
  const add = (f, literal, prefix) =>
    out.set(`${f}|${literal}|${prefix}`, { field: f, literal, prefix });
  for (const m of kql.matchAll(new RegExp(`${field}\\s*(==|!=|startswith)\\s*"([^"]+)"`, 'g'))) {
    add(m[1], m[3], m[2] === 'startswith');
  }
  for (const m of kql.matchAll(new RegExp(`${field}\\s*!?in\\s*\\(([^)]*)\\)`, 'g'))) {
    for (const v of m[2].matchAll(/"([^"]+)"/g)) add(m[1], v[1], false);
  }
  return [...out.values()];
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether the source logs a compared literal in the field the query compares:
 * - `ev`: as an `event: '<x>'` value;
 * - `msg`: as a log call's message argument, never an `event:` value: the whole
 *   literal then ends the argument (`,` or `)`) or goes on (`' +`), and a
 *   `startswith` literal is the message's start;
 * - reason, stage, code and `tostring(m.x)`: anywhere, quoted (they come from
 *   variables and enums).
 */
function loggedAs(source, { field, literal, prefix }) {
  const lit = escapeRegExp(literal);
  if (field === 'ev') return new RegExp(String.raw`\bevent:\s*'${lit}'`).test(source);
  if (field === 'msg') {
    const end = prefix ? '' : String.raw`'(?=\s*[,)]|\s*\+)`;
    return new RegExp(String.raw`(?<!event:\s*)'${lit}${end}`).test(source);
  }
  return source.includes(prefix ? `'${literal}` : `'${literal}'`);
}

const describeLiteral = ({ field, literal, prefix }) =>
  `${field} ${prefix ? 'startswith' : '=='} "${literal}"`;

/** The JSON fields the queries read from a pino line (`m.x`, first segment), pino's own left out. */
function readFields(kql) {
  const pino = new Set(['msg', 'level', 'time', 'err']);
  return [...new Set([...kql.matchAll(/\bm\.(\w+)/g)].map((m) => m[1]))].filter(
    (f) => !pino.has(f),
  );
}

/** The apps' source, tests excluded: where a logged event name or code must occur. */
function appSource() {
  const texts = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
        texts.push(readFileSync(p, 'utf8'));
      }
    }
  };
  for (const pkg of ['shared', 'teams-bot', 'document-ingestion', 'ledger-db']) {
    walk(join(REPO, 'packages', pkg, 'src'));
  }
  return texts.join('\n');
}

describe('alerts.bicep', () => {
  test('declares action groups and log alert rules only, through its one module', () => {
    const types = ALERT_FILES.flatMap((f) => declaredTypes(read(f)));
    assert.ok(types.length >= 3, 'the module declares the action group and the rules');
    assert.deepEqual(
      types.filter((t) => !ALLOWED.includes(t)),
      [],
    );
    assert.match(read('infrastructure/alerts.bicep'), /^module alerts 'modules\/alerts\.bicep'/m);
    // `existing` would be emitted under languageVersion 2.0 and trip the script's check.
    for (const f of ALERT_FILES) assert.doesNotMatch(withoutComments(read(f)), /\bexisting\b/, f);
  });

  test('is not main.bicep: no Function App, app setting, Key Vault, component or workspace', () => {
    for (const f of ALERT_FILES) {
      const code = withoutComments(read(f));
      assert.doesNotMatch(code, /Microsoft\.Web|appsettings|Microsoft\.KeyVault/i, f);
      assert.doesNotMatch(
        code,
        /^resource\s+\w+\s+'Microsoft\.(Insights\/components|OperationalInsights)/m,
        f,
      );
    }
    assert.doesNotMatch(read('infrastructure/main.bicep'), /alerts\.bicep|scheduledQueryRules/);
  });

  test('names the resources ag-bcr-* and alert-bcr-*, which the script allows', () => {
    const m = withoutComments(read(MODULE));
    // The `name:` right under each `resource … = {` (or `= [ for … : {`).
    const names = [
      ...m.matchAll(
        /^resource\s+\w+\s+'[^']+'\s*=\s*(?:\[\s*for [^:]+:\s*)?\{\s*\n\s*name: ([^\n]+)/gm,
      ),
    ].map((x) => x[1].trim());
    assert.deepEqual(names, [
      "'ag-bcr-${nameSuffix}'",
      'heartbeatName',
      "'alert-bcr-${r.name}-${nameSuffix}'",
    ]);
    assert.match(m, /^var heartbeatName = 'alert-bcr-inbox-heartbeat-\$\{nameSuffix\}'$/m);
  });

  test('every rule runs every 15 minutes, stateful, on the component', () => {
    const m = withoutComments(read(MODULE));
    const freqs = [...m.matchAll(/evaluationFrequency: '([^']+)'/g)].map((x) => x[1]);
    assert.deepEqual([...new Set(freqs)], ['PT15M']);
    assert.doesNotMatch(m, /autoMitigate: false|muteActionsDuration/);
    assert.equal([...m.matchAll(/autoMitigate: true/g)].length, 2, 'the heartbeat and the loop');
    assert.match(
      read('infrastructure/alerts.bicep'),
      /resourceId\('Microsoft\.Insights\/components', 'appi-bcr-\$\{nameSuffix\}'\)/,
    );
    // The heartbeat: no row is the alert.
    assert.match(m, /timeAggregation: 'Count'\s+operator: 'LessThan'\s+threshold: 1/);
  });

  test('the emails carry codes and counts: one dimension, `signal`, and no raw line', () => {
    const m = withoutComments(read(MODULE));
    const dims = [...m.matchAll(/dimensions: \[\s*\{\s*name: '([^']+)'/g)].map((x) => x[1]);
    assert.deepEqual(dims, ['signal']);
    const kql = bicepStrings(read(MODULE));
    assert.doesNotMatch(kql, /\|\s*project\s+[^\n]*\b(message|customDimensions|m)\b/);
    assert.doesNotMatch(
      kql,
      /\bby\b[^\n]*\b(message|msg|listItemId|clientId|driveItemId|userAadObjectId)\b/,
    );
    // Every summarize is the per-signal count, but claude.capacity's 5-minute
    // bins (by signal and a time bin: still no field of a line).
    const summarizes = [
      '| summarize n = sum(w) by signal',
      '| summarize w = sum(itemCount) by signal, b = iff(signal == "claude.capacity", bin(timestamp, 5m), datetime(null))',
    ];
    for (const [s] of kql.matchAll(/\| summarize [^\n]*/g)) assert.ok(summarizes.includes(s), s);
  });

  test('every event name and code the queries compare is logged in the field they compare', () => {
    const kql = bicepStrings(read(MODULE));
    const literals = comparedLiterals(kql);
    const named = literals.map(describeLiteral);
    for (const l of [
      'msg == "inbox.tick"',
      'msg == "claude.paused"',
      'ev == "membership.check_off"',
      'msg == "directory.conflict"',
      'msg == "directory snapshot ready"',
      'msg == "claude.retry_later"',
      'reason == "rate_limited"',
      'msg == "review_notice.off"',
      'tostring(m.membershipCheck) == "off"',
    ]) {
      assert.ok(named.includes(l), `${l} in ${named.join(', ')}`);
    }
    const source = appSource();
    assert.deepEqual(
      literals.filter((l) => !loggedAs(source, l)).map(describeLiteral),
      [],
      'renamed, deleted or moved to another field in the code: update infrastructure/modules/alerts.bicep and the runbook',
    );
  });

  test('the field check fails a literal logged only in the other field', () => {
    const [ev] = comparedLiterals('| extend signal = case(ev == "directory.conflict", ev, "")');
    const [msg] = comparedLiterals('| where msg == "inbox.tick"');
    // The message kept, `event` dropped as redundant: the query compares `event`.
    assert.equal(loggedAs("this.log.warn({ kind }, 'directory.conflict');", ev), false);
    assert.equal(
      loggedAs("this.log.warn({ event: 'directory.conflict', kind }, 'directory.conflict');", ev),
      true,
    );
    // Only an `event` value, or the literal inside a longer message: not the message.
    assert.equal(loggedAs("log.info({ event: 'inbox.tick', ...summary }, 'tick');", msg), false);
    assert.equal(loggedAs("log.info({ n }, 'inbox.tick summary');", msg), false);
    assert.equal(
      loggedAs("log.info({ event: 'inbox.tick', ...summary }, 'inbox.tick');", msg),
      true,
    );
    // A startswith literal is the message's start.
    const [prefix] = comparedLiterals('| where msg startswith "client target unusable"');
    assert.equal(loggedAs("log.warn({ id }, 'client target unusable — holding');", prefix), true);
  });

  test('every JSON field the queries read is one the apps name', () => {
    const fields = readFields(bicepStrings(read(MODULE)));
    for (const f of ['skippedNotClientAccount', 'skippedMembership', 'membershipCheck']) {
      assert.ok(fields.includes(f), `${f} in ${fields.join(', ')}`);
    }
    const source = appSource();
    assert.deepEqual(
      fields.filter((f) => !new RegExp(String.raw`\b${f}\b`).test(source)),
      [],
      'a field the queries read is no longer in the code',
    );
  });

  test('the signals added in review: each is in its rule, and the bindings rule looks back 1 hour', () => {
    const m = withoutComments(read(MODULE));
    const rule = (name) => {
      const start = m.indexOf(`    name: '${name}'`);
      assert.ok(start >= 0, name);
      const next = m.indexOf('\n  {\n', start);
      return m.slice(start, next < 0 ? undefined : next);
    };
    assert.match(rule('bindings'), /"directory\.forbidden_target"/);
    assert.match(rule('bindings'), /windowSize: 'PT1H'/);
    assert.match(rule('filing'), /"app\.start_failed"/);
    assert.match(rule('anthropic'), /"claude\.capacity"/);
    assert.match(rule('review-notices'), /"review_notice\.webhook_unresolved"/);
  });

  test('the parameter file: the pinned keys, and recipients in bcr-group.pl only', () => {
    const params = JSON.parse(read('infrastructure/alerts.dev.parameters.json')).parameters;
    assert.deepEqual(Object.keys(params).sort(), [
      'alertEmails',
      'billedCallsPerHour',
      'disabledRules',
      'environmentName',
      'location',
    ]);
    const emails = params.alertEmails.value;
    assert.ok(emails.length >= 1);
    for (const e of emails) assert.match(e, /^[a-z0-9._-]+@bcr-group\.pl$/, e);
  });

  test('disabledRules names only rules that exist, and the template lists them all', () => {
    const m = withoutComments(read(MODULE));
    const countRules = [...m.matchAll(/^ {4}name: '([a-z-]+)'$/gm)].map((x) => x[1]);
    const rules = ['inbox-heartbeat', ...countRules];
    assert.equal(rules.length, 8, rules.join());
    const disabled = JSON.parse(read('infrastructure/alerts.dev.parameters.json')).parameters
      .disabledRules.value;
    assert.deepEqual(
      disabled.filter((r) => !rules.includes(r)),
      [],
    );
    const described = read('infrastructure/alerts.bicep').match(/by short name \(([^)]*)\)/)[1];
    assert.deepEqual(described.split(', ').sort(), [...rules].sort());
  });
});

// ---------------------------------------------------------------------------
// alerts-deploy.sh, in a scratch tree with a fake `az` (jq is the real one).
// ---------------------------------------------------------------------------

const FAKE_AZ = `#!/usr/bin/env bash
echo "az $*" >> "$FAKE_LOG"
case "$1 $2" in
  "bicep build") cat "$FAKE_TEMPLATE" ;;
  "deployment group")
    case "$3" in
      what-if) cat "$FAKE_WHAT_IF" ;;
      create) echo '{"actionGroupName":"ag-bcr-dev-x","ruleNames":["alert-bcr-filing-dev-x"]}' ;;
      *) echo "fake az: unexpected deployment call" >&2; exit 99 ;;
    esac ;;
  *) echo "fake az: unexpected call: $*" >&2; exit 99 ;;
esac
`;

const change = (changeType, provider, name, rg = 'rg-bcr-ledger-dev') => ({
  changeType,
  resourceId: `/subscriptions/s/resourceGroups/${rg}/providers/${provider}/${name}`,
});

function scratch({ types = ALLOWED, changes = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'alerts-deploy-'));
  const files = {
    'infrastructure/alerts.bicep': '// the fake az compiles nothing',
    'infrastructure/alerts.dev.parameters.json': '{"parameters":{}}',
    'template.json': JSON.stringify({
      resources: [
        {
          type: 'Microsoft.Resources/deployments',
          apiVersion: '2022-09-01',
          properties: { template: { resources: types.map((type) => ({ type, apiVersion: 'x' })) } },
        },
      ],
    }),
    'what-if.json': JSON.stringify({
      changes: [
        change('Ignore', 'Microsoft.Web/sites', 'func-bcr-ingest-dev-x'),
        change('Ignore', 'Microsoft.Insights/components', 'appi-bcr-dev-x'),
        change('Ignore', 'microsoft.insights/actiongroups', 'Application Insights Smart Detection'),
        ...changes,
      ],
    }),
    'bin/az': FAKE_AZ,
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  copyFileSync(
    join(REPO, 'infrastructure/alerts-deploy.sh'),
    join(root, 'infrastructure/alerts-deploy.sh'),
  );
  chmodSync(join(root, 'bin/az'), 0o755);
  writeFileSync(join(root, 'calls.log'), '');
  return root;
}

function run(root, args, env = {}, input = '') {
  const r = spawnSync('bash', [join(root, 'infrastructure/alerts-deploy.sh'), ...args], {
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH}`,
      FAKE_LOG: join(root, 'calls.log'),
      FAKE_TEMPLATE: join(root, 'template.json'),
      FAKE_WHAT_IF: join(root, 'what-if.json'),
      ALERTS_DEPLOY_CONFIRM: '',
      ALERTS_RESOURCE_GROUP: '',
      ...env,
    },
  });
  const calls = readFileSync(join(root, 'calls.log'), 'utf8').split('\n').filter(Boolean);
  return { ...r, calls };
}

const creates = (calls) => calls.filter((c) => c.startsWith('az deployment group create'));

describe('alerts-deploy.sh', () => {
  const alertsCreate = [
    change('Create', 'Microsoft.Insights/actionGroups', 'ag-bcr-dev-x'),
    change('Create', 'Microsoft.Insights/scheduledQueryRules', 'alert-bcr-filing-dev-x'),
    change('Modify', 'Microsoft.Insights/scheduledQueryRules', 'alert-bcr-inbox-heartbeat-dev-x'),
  ];

  test('without --apply: the what-if only, incremental, alerts.bicep and its parameters', () => {
    const r = run(scratch({ changes: alertsCreate }), ['dev']);
    assert.equal(r.status, 0, r.stderr);
    const whatIf = r.calls.find((c) => c.startsWith('az deployment group what-if'));
    assert.ok(whatIf, 'what-if ran');
    assert.match(whatIf, /--resource-group rg-bcr-ledger-dev /);
    assert.match(whatIf, /--mode Incremental/);
    assert.match(whatIf, /alerts\.bicep/);
    assert.match(whatIf, /@\S*alerts\.dev\.parameters\.json/);
    assert.doesNotMatch(r.calls.join('\n'), /main\.bicep|db\.bicep|functionapp|appsettings/);
    assert.deepEqual(creates(r.calls), []);
    assert.match(r.stdout, /Create\tMicrosoft\.Insights\/actionGroups\/ag-bcr-dev-x/);
    assert.match(r.stdout, /Nothing deployed/);
  });

  test('with --apply: deploys after the resource group name is typed', () => {
    const r = run(
      scratch({ changes: alertsCreate }),
      ['dev', '--apply'],
      {},
      'rg-bcr-ledger-dev\n',
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(creates(r.calls).length, 1);
    assert.match(creates(r.calls)[0], /--mode Incremental/);
    assert.match(creates(r.calls)[0], /--name bcr-ledger-alerts-dev-\d{8}T\d{6}Z/);
    assert.match(r.stdout, /ag-bcr-dev-x/);
  });

  test('with --apply: a wrong confirmation deploys nothing', () => {
    const r = run(
      scratch({ changes: alertsCreate }),
      ['dev', '--apply'],
      {},
      'rg-bcr-ledger-prod\n',
    );
    assert.notEqual(r.status, 0);
    assert.deepEqual(creates(r.calls), []);
  });

  test('ALERTS_RESOURCE_GROUP names the group, and the confirmation must match it', () => {
    const root = scratch({
      changes: [change('Create', 'Microsoft.Insights/actionGroups', 'ag-bcr-qa-x', 'rg-other')],
    });
    const r = run(root, ['dev', '--apply'], {
      ALERTS_RESOURCE_GROUP: 'rg-other',
      ALERTS_DEPLOY_CONFIRM: 'rg-other',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(creates(r.calls)[0], /--resource-group rg-other /);
  });

  test('refuses a template that declares anything else, before the what-if', () => {
    for (const foreign of [
      'Microsoft.Insights/components',
      'Microsoft.OperationalInsights/workspaces',
      'Microsoft.Web/sites/config',
      'Microsoft.Insights/metricAlerts',
    ]) {
      const r = run(scratch({ types: [...ALLOWED, foreign] }), ['dev']);
      assert.notEqual(r.status, 0, foreign);
      assert.ok(r.stderr.includes(foreign), foreign);
      assert.equal(
        r.calls.some((c) => c.includes('what-if')),
        false,
        foreign,
      );
    }
  });

  test('refuses a what-if that would delete, or touch anything but ag-bcr-*/alert-bcr-*', () => {
    for (const bad of [
      change('Delete', 'Microsoft.Insights/scheduledQueryRules', 'alert-bcr-old-dev-x'),
      // The prefix trap: the component main.bicep owns is also Microsoft.Insights.
      change('Modify', 'Microsoft.Insights/components', 'appi-bcr-dev-x'),
      change('Modify', 'microsoft.insights/actiongroups', 'Application Insights Smart Detection'),
      change('Create', 'Microsoft.Insights/scheduledQueryRules', 'someone-elses-rule'),
      change('Modify', 'Microsoft.Web/sites', 'func-bcr-ingest-dev-x'),
      change('Create', 'Microsoft.Web/sites/config', 'func-bcr-ingest-dev-x/appsettings'),
      change('Unsupported', 'Microsoft.OperationalInsights/workspaces', 'log-bcr-dev-x'),
    ]) {
      const r = run(scratch({ changes: [...alertsCreate, bad] }), ['dev', '--apply'], {
        ALERTS_DEPLOY_CONFIRM: 'rg-bcr-ledger-dev',
      });
      assert.notEqual(r.status, 0, `${bad.changeType} ${bad.resourceId}`);
      assert.match(r.stderr, /not the ledger's alerts/);
      assert.deepEqual(creates(r.calls), []);
    }
  });

  test('matches the allowed types case-insensitively, as Azure spells them either way', () => {
    const r = run(
      scratch({
        changes: [
          change('Modify', 'microsoft.insights/scheduledqueryrules', 'alert-bcr-filing-dev-x'),
        ],
      }),
      ['dev'],
    );
    assert.equal(r.status, 0, r.stderr);
  });

  test('refuses an unknown environment, an unknown argument and a missing parameter file', () => {
    assert.notEqual(run(scratch(), ['staging']).status, 0);
    assert.notEqual(run(scratch(), ['dev', '--force']).status, 0);
    const r = run(scratch(), ['prod']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no parameter file/);
    assert.deepEqual(r.calls, []);
  });
});
