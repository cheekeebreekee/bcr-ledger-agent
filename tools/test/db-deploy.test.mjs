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
// db.bicep: a standalone template that may only ever touch the database.
// ---------------------------------------------------------------------------

const read = (rel) => readFileSync(join(REPO, rel), 'utf8');
const DB_FILES = ['infrastructure/db.bicep', 'infrastructure/modules/postgres.bicep'];

/** Resource types a Bicep file declares (`resource x 'Type@version'`). */
function declaredTypes(source) {
  return [...source.matchAll(/^resource\s+\w+\s+'([^'@]+)@[^']+'/gm)].map((m) => m[1]);
}

describe('db.bicep', () => {
  test('declares PostgreSQL resources only, through its one module', () => {
    const types = DB_FILES.flatMap((f) => declaredTypes(read(f)));
    assert.ok(types.length >= 5, 'the module declares the server and its children');
    assert.deepEqual(
      types.filter((t) => !t.startsWith('Microsoft.DBforPostgreSQL/')),
      [],
    );
    assert.match(read('infrastructure/db.bicep'), /^module postgres 'modules\/postgres\.bicep'/m);
  });

  test('is not main.bicep: it never names a Function App, an app setting or a Key Vault', () => {
    for (const f of DB_FILES) {
      const code = read(f).replace(/^\s*\/\/.*$/gm, '');
      assert.doesNotMatch(code, /Microsoft\.Web|appsettings|Microsoft\.KeyVault/i, f);
    }
    assert.doesNotMatch(read('infrastructure/main.bicep'), /postgres\.bicep|DBforPostgreSQL/);
  });

  test('B1ms Burstable, PostgreSQL 16, 32 GiB, 7-day backups, the ledger database', () => {
    const m = read('infrastructure/modules/postgres.bicep');
    for (const needle of [
      "name: 'Standard_B1ms'",
      "tier: 'Burstable'",
      "version: '16'",
      'storageSizeGB: 32',
      'backupRetentionDays: 7',
      "mode: 'Disabled'",
      "charset: 'UTF8'",
    ]) {
      assert.ok(m.includes(needle), needle);
    }
    assert.match(read('infrastructure/db.bicep'), /databaseName: 'ledger'/);
  });

  test('Entra authentication only: no password, no administrator login anywhere', () => {
    const m = read('infrastructure/modules/postgres.bicep');
    assert.ok(m.includes("activeDirectoryAuth: 'Enabled'"));
    assert.ok(m.includes("passwordAuth: 'Disabled'"));
    for (const f of [...DB_FILES, 'infrastructure/db.dev.parameters.json']) {
      assert.doesNotMatch(read(f), /administratorLogin|administratorLoginPassword|@secure/, f);
    }
  });

  test('TLS required, and the one network rule: Azure services (0.0.0.0)', () => {
    const m = read('infrastructure/modules/postgres.bicep');
    assert.match(m, /name: 'require_secure_transport'[\s\S]*?value: 'on'/);
    assert.match(m, /name: 'ssl_min_protocol_version'[\s\S]*?value: 'TLSv1\.2'/);
    const rules = [...m.matchAll(/flexibleServers\/firewallRules@[^']+' = \{[\s\S]*?\n\}/g)];
    assert.equal(rules.length, 1);
    assert.match(rules[0][0], /name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'/);
    assert.match(rules[0][0], /startIpAddress: '0\.0\.0\.0'\s+endIpAddress: '0\.0\.0\.0'/);
  });

  test('commits no administrator id: the operator is passed at deploy time', () => {
    const params = JSON.parse(read('infrastructure/db.dev.parameters.json')).parameters;
    assert.deepEqual(Object.keys(params).sort(), [
      'environmentName',
      'geoRedundantBackup',
      'location',
    ]);
  });
});

// ---------------------------------------------------------------------------
// db-deploy.sh, in a scratch tree with a fake `az` (jq is the real one).
// ---------------------------------------------------------------------------

const DB_TYPES = [
  'Microsoft.DBforPostgreSQL/flexibleServers',
  'Microsoft.DBforPostgreSQL/flexibleServers/databases',
];

const FAKE_AZ = `#!/usr/bin/env bash
echo "az $*" >> "$FAKE_LOG"
case "$1 $2" in
  "bicep build") cat "$FAKE_TEMPLATE" ;;
  "ad signed-in-user")
    if [[ "$*" == *userPrincipalName* ]]; then echo "operator@example.invalid";
    else echo "00000000-0000-4000-8000-000000000001"; fi ;;
  "deployment group")
    case "$3" in
      what-if) cat "$FAKE_WHAT_IF" ;;
      create) echo '{"serverName":"psql-x","serverFqdn":"psql-x.postgres.database.azure.com","databaseName":"ledger"}' ;;
      *) echo "fake az: unexpected deployment call" >&2; exit 99 ;;
    esac ;;
  *) echo "fake az: unexpected call: $*" >&2; exit 99 ;;
esac
`;

const change = (changeType, provider, name) => ({
  changeType,
  resourceId: `/subscriptions/s/resourceGroups/rg-bcr-ledger-dev/providers/${provider}/${name}`,
});

function scratch({ types = DB_TYPES, changes = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'db-deploy-'));
  const files = {
    'infrastructure/db.bicep': '// the fake az compiles nothing',
    'infrastructure/db.dev.parameters.json': '{"parameters":{}}',
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
      changes: [change('Ignore', 'Microsoft.Web/sites', 'func-bcr-ingest-dev-x'), ...changes],
    }),
    'bin/az': FAKE_AZ,
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  copyFileSync(
    join(REPO, 'infrastructure/db-deploy.sh'),
    join(root, 'infrastructure/db-deploy.sh'),
  );
  chmodSync(join(root, 'bin/az'), 0o755);
  writeFileSync(join(root, 'calls.log'), '');
  return root;
}

function run(root, args, env = {}, input = '') {
  const r = spawnSync('bash', [join(root, 'infrastructure/db-deploy.sh'), ...args], {
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH}`,
      FAKE_LOG: join(root, 'calls.log'),
      FAKE_TEMPLATE: join(root, 'template.json'),
      FAKE_WHAT_IF: join(root, 'what-if.json'),
      DB_DEPLOY_CONFIRM: '',
      ...env,
    },
  });
  const calls = readFileSync(join(root, 'calls.log'), 'utf8').split('\n').filter(Boolean);
  return { ...r, calls };
}

const creates = (calls) => calls.filter((c) => c.startsWith('az deployment group create'));

describe('db-deploy.sh', () => {
  const dbCreate = [
    change('Create', 'Microsoft.DBforPostgreSQL/flexibleServers', 'psql-bcr-dev-x'),
    change(
      'Create',
      'Microsoft.DBforPostgreSQL/flexibleServers',
      'psql-bcr-dev-x/databases/ledger',
    ),
  ];

  test('without --apply: the what-if only, incremental, as the signed-in operator', () => {
    const r = run(scratch({ changes: dbCreate }), ['dev']);
    assert.equal(r.status, 0, r.stderr);
    const whatIf = r.calls.find((c) => c.startsWith('az deployment group what-if'));
    assert.ok(whatIf, 'what-if ran');
    assert.match(whatIf, /--resource-group rg-bcr-ledger-dev /);
    assert.match(whatIf, /--mode Incremental/);
    assert.match(whatIf, /entraAdminObjectId=00000000-0000-4000-8000-000000000001/);
    assert.match(whatIf, /entraAdminPrincipalName=operator@example\.invalid/);
    assert.match(whatIf, /db\.bicep/);
    assert.doesNotMatch(r.calls.join('\n'), /main\.bicep|functionapp|appsettings/);
    assert.deepEqual(creates(r.calls), []);
    assert.match(r.stdout, /Nothing deployed/);
  });

  test('with --apply: deploys after the resource group name is typed', () => {
    const r = run(scratch({ changes: dbCreate }), ['dev', '--apply'], {}, 'rg-bcr-ledger-dev\n');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(creates(r.calls).length, 1);
    assert.match(creates(r.calls)[0], /--mode Incremental/);
    assert.match(r.stdout, /psql-x\.postgres\.database\.azure\.com/);
  });

  test('with --apply: a wrong confirmation deploys nothing', () => {
    const r = run(scratch({ changes: dbCreate }), ['dev', '--apply'], {}, 'rg-bcr-ledger-prod\n');
    assert.notEqual(r.status, 0);
    assert.deepEqual(creates(r.calls), []);
  });

  test('refuses a template that declares anything outside PostgreSQL, before the what-if', () => {
    const r = run(scratch({ types: [...DB_TYPES, 'Microsoft.Web/sites/config'] }), ['dev']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Microsoft\.Web\/sites\/config/);
    assert.equal(
      r.calls.some((c) => c.includes('what-if')),
      false,
    );
  });

  test('refuses a what-if that would delete, or change anything else, and deploys nothing', () => {
    for (const bad of [
      change('Delete', 'Microsoft.DBforPostgreSQL/flexibleServers', 'psql-old'),
      change('Modify', 'Microsoft.Web/sites', 'func-bcr-ingest-dev-x'),
      change('Create', 'Microsoft.Network/virtualNetworks', 'vnet'),
    ]) {
      const r = run(scratch({ changes: [...dbCreate, bad] }), ['dev', '--apply'], {
        DB_DEPLOY_CONFIRM: 'rg-bcr-ledger-dev',
      });
      assert.notEqual(r.status, 0, bad.changeType);
      assert.match(r.stderr, /not the index database/);
      assert.deepEqual(creates(r.calls), []);
    }
  });

  test('refuses an unknown environment, an unknown argument and a missing parameter file', () => {
    assert.notEqual(run(scratch(), ['staging']).status, 0);
    assert.notEqual(run(scratch(), ['dev', '--force']).status, 0);
    const r = run(scratch(), ['prod']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no parameter file/);
    assert.deepEqual(r.calls, []);
  });

  test('refuses an administrator that is not a GUID and a UPN', () => {
    const r = run(scratch({ changes: dbCreate }), ['dev'], {
      DB_ENTRA_ADMIN_OBJECT_ID: 'not-a-guid',
      DB_ENTRA_ADMIN_UPN: 'operator@example.invalid',
    });
    assert.notEqual(r.status, 0);
    assert.equal(
      r.calls.some((c) => c.includes('what-if')),
      false,
    );
  });
});
