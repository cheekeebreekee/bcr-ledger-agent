import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { describe, test } from 'node:test';

import { REPO } from '../check-app-settings.mjs';

// ---------------------------------------------------------------------------
// The real deploy.sh and app-settings-gate.sh, in a scratch tree, with a fake
// `az`, a fake `corepack` and a stub check-app-settings.mjs. Every call is
// logged, so a test can say what ran and in what order.
// ---------------------------------------------------------------------------

const FAKE_AZ = `#!/usr/bin/env bash
echo "az $*" >> "$FAKE_LOG"
case "$1 $2" in
  "group exists")
    if [[ "\${FAKE_GROUP_EXISTS:-}" == fail ]]; then
      echo "ERROR: Please run 'az login' to setup account." >&2; exit 1
    fi
    echo "\${FAKE_GROUP_EXISTS:-}" ;;
  "functionapp list")
    if [[ "\${FAKE_APPS:-}" == fail ]]; then
      echo "ERROR: (AuthorizationFailed) The client does not have authorization." >&2; exit 1
    fi
    for app in \${FAKE_APPS:-}; do echo "$app"; done ;;
  "group create" | "functionapp deployment") ;;
  "deployment group")
    echo '{"properties":{"outputs":{"botFunctionName":{"value":"func-bot"},"ingestionFunctionName":{"value":"func-ingest"}}}}' ;;
  *) echo "fake az: unexpected call: $*" >&2; exit 99 ;;
esac
`;

const FAKE_COREPACK = `#!/usr/bin/env bash
echo "corepack $*" >> "$FAKE_LOG"
`;

const STUB_CHECK = `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_LOG, \`check \${process.argv.slice(2).join(' ')}\\n\`);
process.exitCode = Number(process.env.FAKE_CHECK_EXIT ?? 0);
`;

const params = (env) => JSON.stringify({ parameters: { environmentName: { value: env } } });

function scratchTree() {
  const root = mkdtempSync(join(tmpdir(), 'deploy-gate-'));
  const files = {
    'tools/check-app-settings.mjs': STUB_CHECK,
    'infrastructure/main.qa.parameters.json': params('qa'),
    'infrastructure/main.dev.parameters.json': params('dev'),
    'infrastructure/main.stage.parameters.json': params('Dev'),
    'artifacts/teams-bot.zip': 'zip',
    'artifacts/document-ingestion.zip': 'zip',
    'bin/az': FAKE_AZ,
    'bin/corepack': FAKE_COREPACK,
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  for (const script of ['infrastructure/deploy.sh', 'infrastructure/app-settings-gate.sh']) {
    copyFileSync(join(REPO, script), join(root, script));
  }
  chmodSync(join(root, 'bin/az'), 0o755);
  chmodSync(join(root, 'bin/corepack'), 0o755);
  writeFileSync(join(root, 'calls.log'), '');
  return root;
}

function runScript(root, script, args, env = {}) {
  const r = spawnSync('bash', [join(root, script), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: [join(root, 'bin'), dirname(process.execPath), process.env.PATH].join(delimiter),
      HOME: process.env.HOME,
      FAKE_LOG: join(root, 'calls.log'),
      ...env,
    },
  });
  const calls = readFileSync(join(root, 'calls.log'), 'utf8').split('\n').filter(Boolean);
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, calls };
}

const gate = (env) =>
  runScript(scratchTree(), 'infrastructure/app-settings-gate.sh', ['rg-x', 'p.json'], env);

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe('app-settings-gate.sh', () => {
  test('a resource group that does not exist yet is a new environment: nothing to compare', () => {
    const r = gate({ FAKE_GROUP_EXISTS: 'false' });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.calls, ['az group exists -n rg-x']);
    assert.match(r.stdout, /does not exist yet: a new environment/);
  });

  test("az failing to say whether it exists stops the deploy, with az's own error shown", () => {
    const r = gate({ FAKE_GROUP_EXISTS: 'fail' });
    assert.notEqual(r.code, 0);
    assert.deepEqual(r.calls, ['az group exists -n rg-x']);
    assert.match(r.stderr, /Please run 'az login'/);
    assert.match(r.stderr, /Refusing: could not tell whether resource group rg-x exists/);
  });

  test('an answer other than true or false stops the deploy', () => {
    const r = gate({ FAKE_GROUP_EXISTS: '' });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /answered '', not true or false/);
  });

  test('an existing group whose apps cannot be listed stops the deploy: never "no apps yet"', () => {
    const r = gate({ FAKE_GROUP_EXISTS: 'true', FAKE_APPS: 'fail' });
    assert.notEqual(r.code, 0);
    assert.deepEqual(r.calls, [
      'az group exists -n rg-x',
      'az functionapp list -g rg-x --query [].name -o tsv',
    ]);
    assert.match(r.stderr, /AuthorizationFailed/, 'az stderr is not hidden');
    assert.match(r.stderr, /Refusing: could not list the Function Apps in rg-x/);
  });

  test('an existing group with no Function Apps: nothing to compare', () => {
    const r = gate({ FAKE_GROUP_EXISTS: 'true', FAKE_APPS: '' });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.calls.some((c) => c.startsWith('check')));
    assert.match(r.stdout, /No Function Apps in rg-x yet/);
  });

  test("running apps: the live check runs, and its failure is the gate's", () => {
    const apps = { FAKE_GROUP_EXISTS: 'true', FAKE_APPS: 'func-bcr-bot-x func-bcr-ingest-x' };
    const clean = gate(apps);
    assert.equal(clean.code, 0, clean.stderr);
    assert.equal(clean.calls.at(-1), 'check --live -g rg-x -p p.json');
    const drift = gate({ ...apps, FAKE_CHECK_EXIT: '1' });
    assert.equal(drift.code, 1);
  });

  test('EXPECTED_SETTING_CHANGES reaches the check as one --expect; empty adds nothing', () => {
    const apps = { FAKE_GROUP_EXISTS: 'true', FAKE_APPS: 'func-bcr-bot-x func-bcr-ingest-x' };
    const named = gate({ ...apps, EXPECTED_SETTING_CHANGES: 'LOG_LEVEL,INBOX_SWEEP_MODE' });
    assert.equal(named.code, 0, named.stderr);
    assert.equal(
      named.calls.at(-1),
      'check --live -g rg-x -p p.json --expect LOG_LEVEL,INBOX_SWEEP_MODE',
    );
    const empty = gate({ ...apps, EXPECTED_SETTING_CHANGES: '' });
    assert.equal(empty.calls.at(-1), 'check --live -g rg-x -p p.json');
  });
});

// ---------------------------------------------------------------------------
// deploy.sh
// ---------------------------------------------------------------------------

describe('deploy.sh', () => {
  const deploy = (args, env) => runScript(scratchTree(), 'infrastructure/deploy.sh', args, env);
  const running = { FAKE_GROUP_EXISTS: 'true', FAKE_APPS: 'func-bcr-bot-x func-bcr-ingest-x' };

  test('dev is refused in every spelling, before any build or az call', () => {
    for (const args of [['dev'], ['DEV'], ['qa', 'rg-bcr-ledger-DEV'], ['stage']]) {
      const r = deploy(args, running);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.stderr, /Refusing: dev is production/, args.join(' '));
      assert.deepEqual(r.calls, [], args.join(' '));
    }
  });

  test('the gate runs after packaging and before anything is written to Azure', () => {
    const r = deploy(['qa'], running);
    assert.equal(r.code, 0, r.stderr);
    const order = r.calls.map((c) => c.split(' ').slice(0, 3).join(' '));
    assert.deepEqual(order, [
      'corepack yarn install',
      'corepack yarn workspace',
      'corepack yarn workspace',
      'az group exists',
      'az functionapp list',
      'check --live -g',
      'az group create',
      'az deployment group',
      'az functionapp deployment',
      'az functionapp deployment',
    ]);
    assert.match(
      r.calls[5],
      /^check --live -g rg-bcr-ledger-qa -p \S*\/infrastructure\/main\.qa\.parameters\.json$/,
    );
  });

  test('a failed gate (drift, or az failing) writes nothing to Azure', () => {
    for (const env of [
      { ...running, FAKE_CHECK_EXIT: '1' },
      { FAKE_GROUP_EXISTS: 'fail' },
      { FAKE_GROUP_EXISTS: 'true', FAKE_APPS: 'fail' },
    ]) {
      const r = deploy(['qa'], env);
      assert.notEqual(r.code, 0, JSON.stringify(env));
      const written = r.calls.filter((c) =>
        /^az (group create|deployment|functionapp deployment)/.test(c),
      );
      assert.deepEqual(written, [], JSON.stringify(env));
    }
  });

  test('deploy.sh hands EXPECTED_SETTING_CHANGES to the gate', () => {
    const r = deploy(['qa'], { ...running, EXPECTED_SETTING_CHANGES: 'LOG_LEVEL' });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.calls[5], /^check --live .* --expect LOG_LEVEL$/);
  });

  test('a new environment deploys without a comparison', () => {
    const r = deploy(['qa'], { FAKE_GROUP_EXISTS: 'false' });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.calls.some((c) => c.startsWith('check')));
    assert.ok(r.calls.some((c) => c.startsWith('az deployment group create')));
  });
});

// ---------------------------------------------------------------------------
// deploy.yml (read as text: the tools take no YAML dependency)
// ---------------------------------------------------------------------------

describe('deploy.yml', () => {
  const workflow = readFileSync(join(REPO, '.github/workflows/deploy.yml'), 'utf8');
  const steps = workflow
    .split(/\n(?=      - (?:name|uses): )/)
    .slice(1)
    .map((s) => ({ name: /^      - (?:name|uses): (.*)$/m.exec(s)[1], text: s }));
  const index = (re) => steps.findIndex((s) => re.test(s.name));

  test('dev is refused first; the gate runs before the Bicep deploy', () => {
    assert.match(steps[0].name, /Refuse dev/);
    assert.match(steps[0].text, /if: env\.ENV_NAME == 'dev'/);
    const gateStep = index(/^App settings/);
    assert.ok(gateStep > 0 && gateStep < index(/^Deploy Bicep/));
    assert.match(steps[gateStep].text, /bash infrastructure\/app-settings-gate\.sh /);
  });

  test('no az error is hidden', () => {
    assert.doesNotMatch(workflow, /2>\s*\/dev\/null/);
  });

  test('expected_setting_changes reaches the gate through the environment, never the script', () => {
    assert.match(workflow, /^ {6}expected_setting_changes:\n {8}type: string\n/m);
    const gateStep = steps[index(/^App settings/)].text;
    assert.match(
      gateStep,
      /env:\n(?: {10}#.*\n)* {10}EXPECTED_SETTING_CHANGES: \$\{\{ inputs\.expected_setting_changes \}\}\n/,
    );
    // An input interpolated into a run: script is a shell injection.
    const inScripts = steps.filter((s) => /run: [|>]?[\s\S]*\$\{\{\s*inputs\./.test(s.text));
    assert.deepEqual(
      inScripts.map((s) => s.name),
      [],
    );
  });
});
