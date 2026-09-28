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
// infrastructure/identity/grant-bot-search-caller.sh, in a scratch tree with a
// fake `az`, a fake Microsoft Graph behind a fake `curl`, and a `sleep` that
// returns at once (jq, bash and the rest are the real ones). Every id is
// synthetic.
// ---------------------------------------------------------------------------

const SCRIPT = 'infrastructure/identity/grant-bot-search-caller.sh';
const NEW_ROLE_ID = '9a529651-5484-406f-85fb-7a5a062d6a63';
const TENANT = '11111111-1111-4111-8111-111111111111';
const INGESTION_APP_ID = '22222222-2222-4222-8222-222222222222';
const API_OBJ = '33333333-3333-4333-8333-333333333333';
const API_SP = '44444444-4444-4444-8444-444444444444';
const MI_ID = '55555555-5555-4555-8555-555555555555';
const MI_APPID = '66666666-6666-4666-8666-666666666666';
const BOT_APP_SP = '77777777-7777-4777-8777-777777777777';
const INGEST_ROLE_ID = '88888888-8888-4888-8888-888888888888';
const BOT = 'func-bcr-bot-dev-abc';
const RG = 'rg-bcr-ledger-dev';
const SITE_ID = `/subscriptions/00000000-0000-4000-8000-000000000000/resourceGroups/${RG}/providers/Microsoft.Web/sites/${BOT}`;

const INGEST_ROLE = {
  allowedMemberTypes: ['Application'],
  description: 'Send documents for filing.',
  displayName: 'Documents.Ingest',
  id: INGEST_ROLE_ID,
  isEnabled: true,
  origin: 'Application',
  value: 'Documents.Ingest',
};

/** Graph as the fake curl serves it; each test changes what it needs. */
function graphState() {
  return {
    application: {
      id: API_OBJ,
      appId: INGESTION_APP_ID,
      displayName: 'BCR Ledger Ingestion API',
      appRoles: [INGEST_ROLE],
    },
    servicePrincipals: [
      {
        id: API_SP,
        appId: INGESTION_APP_ID,
        displayName: 'BCR Ledger Ingestion API',
        servicePrincipalType: 'Application',
        appRoles: [INGEST_ROLE],
      },
      {
        id: MI_ID,
        appId: MI_APPID,
        displayName: BOT,
        servicePrincipalType: 'ManagedIdentity',
        // Lower case, as Entra lists it: the comparison ignores case.
        alternativeNames: ['isExplicit=False', SITE_ID.toLowerCase()],
      },
      {
        id: BOT_APP_SP,
        appId: '99999999-9999-4999-8999-999999999999',
        displayName: 'BCR Ledger Bot',
        servicePrincipalType: 'Application',
      },
    ],
    assignments: [
      {
        id: 'assignment-ingest',
        principalId: BOT_APP_SP,
        principalDisplayName: 'BCR Ledger Bot',
        principalType: 'ServicePrincipal',
        resourceId: API_SP,
        resourceDisplayName: 'BCR Ledger Ingestion API',
        appRoleId: INGEST_ROLE_ID,
      },
    ],
    // true: a role added to the registration never reaches the service principal.
    spLagsRoles: false,
  };
}

/**
 * The fake curl: parses the flags graph() passes, serves the request from the
 * state file, writes the body to -o and prints the status for -w. It logs the
 * method, the URL and the whole argv, so a test can check the token never
 * appears on a command line.
 */
const FAKE_CURL = `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
let out, method = 'GET', data, url;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-o') out = argv[++i];
  else if (a === '-X') method = argv[++i];
  else if (a === '--data') data = argv[++i];
  else if (a === '-w' || a === '-H') i++;
  else if (!a.startsWith('-')) url = a;
}
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ method, url, argv, data }) + '\\n');
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'));
const save = () => fs.writeFileSync(process.env.FAKE_STATE, JSON.stringify(state));
const path = decodeURIComponent(new URL(url).pathname).replace('/v1.0', '');
const sp = (pred) => state.servicePrincipals.find(pred);
let status = 200, body = {};
let m;
if (method === 'GET' && (m = path.match(/^\\/applications\\(appId='([^']+)'\\)$/))) {
  if (state.application.appId === m[1]) body = state.application;
  else [status, body] = [404, { error: { code: 'Request_ResourceNotFound' } }];
} else if (method === 'GET' && path === '/applications/' + state.application.id) {
  body = state.application;
} else if (method === 'PATCH' && path === '/applications/' + state.application.id) {
  const patch = JSON.parse(data);
  state.application.appRoles = patch.appRoles.map((r) => ({ ...r, origin: 'Application' }));
  if (!state.spLagsRoles) {
    sp((s) => s.appId === state.application.appId).appRoles = state.application.appRoles;
  }
  save();
  status = 204;
  body = null;
} else if (method === 'GET' && (m = path.match(/^\\/servicePrincipals\\(appId='([^']+)'\\)$/))) {
  body = sp((s) => s.appId === m[1]);
  if (!body) [status, body] = [404, { error: { code: 'Request_ResourceNotFound' } }];
} else if (method === 'GET' && (m = path.match(/^\\/servicePrincipals\\/([^/]+)\\/appRoleAssignedTo$/))) {
  body = { value: state.assignments.filter((a) => a.resourceId === m[1]) };
} else if (method === 'GET' && (m = path.match(/^\\/servicePrincipals\\/([^/]+)\\/appRoleAssignments$/))) {
  body = { value: state.assignments.filter((a) => a.principalId === m[1]) };
} else if (method === 'POST' && (m = path.match(/^\\/servicePrincipals\\/([^/]+)\\/appRoleAssignedTo$/))) {
  const a = JSON.parse(data);
  const resource = sp((s) => s.id === a.resourceId);
  if (!(resource.appRoles || []).some((r) => r.id === a.appRoleId)) {
    [status, body] = [400, { error: { code: 'Request_BadRequest' } }];
  } else {
    body = {
      id: 'assignment-new',
      ...a,
      principalDisplayName: sp((s) => s.id === a.principalId).displayName,
      principalType: 'ServicePrincipal',
      resourceDisplayName: resource.displayName,
    };
    state.assignments.push(body);
    save();
    status = 201;
  }
} else if (method === 'GET' && (m = path.match(/^\\/servicePrincipals\\/([^/(]+)$/))) {
  body = sp((s) => s.id === m[1]);
  if (!body) [status, body] = [404, { error: { code: 'Request_ResourceNotFound' } }];
} else {
  [status, body] = [400, { error: { code: 'fake_graph_unexpected' } }];
}
fs.writeFileSync(out, body === null ? '' : JSON.stringify(body));
process.stdout.write(String(status));
`;

const FAKE_AZ = `#!/usr/bin/env bash
echo "az $*" >> "$FAKE_AZ_LOG"
case "$1 $2" in
  "account show") echo "$FAKE_TENANT" ;;
  "functionapp show") if [[ -n "$FAKE_SITE_ID" ]]; then echo "$FAKE_SITE_ID"; else exit 3; fi ;;
  "functionapp identity") echo "$FAKE_MI_ID" ;;
  *) echo "fake az: unexpected call: $*" >&2; exit 99 ;;
esac
`;

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** A token-shaped string: only its payload is read, never verified. */
function token({
  tid = TENANT,
  scp = 'Directory.Read.All AppRoleAssignment.ReadWrite.All Application.ReadWrite.All',
} = {}) {
  return `${b64url({ alg: 'none' })}.${b64url({ tid, scp, upn: 'operator@example.invalid' })}.sig`;
}

function scratch(mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'grant-search-'));
  const state = graphState();
  mutate(state);
  const files = {
    'infrastructure/main.dev.parameters.json': JSON.stringify({
      parameters: { ingestionAppId: { value: INGESTION_APP_ID } },
    }),
    'bin/az': FAKE_AZ,
    'bin/curl': FAKE_CURL,
    'bin/sleep': '#!/bin/sh\nexit 0\n',
    'state.json': JSON.stringify(state),
    'graph.log': '',
    'az.log': '',
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  for (const bin of ['az', 'curl', 'sleep']) chmodSync(join(root, 'bin', bin), 0o755);
  mkdirSync(join(root, 'infrastructure/identity'), { recursive: true });
  copyFileSync(join(REPO, SCRIPT), join(root, SCRIPT));
  return root;
}

function run(root, args, env = {}) {
  const graphToken = env.GRAPH_TOKEN ?? token();
  const r = spawnSync('bash', [join(root, SCRIPT), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: [join(root, 'bin'), dirname(process.execPath), process.env.PATH].join(delimiter),
      FAKE_LOG: join(root, 'graph.log'),
      FAKE_AZ_LOG: join(root, 'az.log'),
      FAKE_STATE: join(root, 'state.json'),
      FAKE_TENANT: TENANT,
      FAKE_SITE_ID: SITE_ID,
      FAKE_MI_ID: MI_ID,
      ...env,
      GRAPH_TOKEN: graphToken,
    },
  });
  const graph = readFileSync(join(root, 'graph.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const az = readFileSync(join(root, 'az.log'), 'utf8').split('\n').filter(Boolean);
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  return { ...r, graph, az, state, graphToken };
}

const BASE = ['-g', RG, '-n', BOT];
const writes = (r) => r.graph.filter((c) => c.method !== 'GET');

describe('grant-bot-search-caller.sh', () => {
  test('parses under bash -n', () => {
    const r = spawnSync('bash', ['-n', join(REPO, SCRIPT)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });

  test('dry run, role not defined yet: prints both requests, writes nothing', () => {
    const r = run(scratch(), BASE);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(writes(r), []);
    assert.match(r.stdout, /dry run: nothing is written/);
    assert.match(
      r.stdout,
      new RegExp(`PATCH https://graph\\.microsoft\\.com/v1\\.0/applications/${API_OBJ}`),
    );
    assert.match(r.stdout, new RegExp(`"appRoleId":"${NEW_ROLE_ID}"`));
    assert.match(r.stdout, new RegExp(`"principalId":"${MI_ID}","resourceId":"${API_SP}"`));
    assert.match(r.stdout, new RegExp(`SEARCH_CALLER_APP_IDS=${MI_APPID}`));
    // The Ingestion API's app id came from the parameter file.
    assert.match(r.stdout, /ingestionAppId in main\.dev\.parameters\.json/);
  });

  test('--apply: adds the role with every existing role kept, then assigns it to the identity', () => {
    const r = run(scratch(), [...BASE, '--apply']);
    assert.equal(r.status, 0, r.stderr);
    const [patch, post, ...rest] = writes(r);
    assert.deepEqual(rest, []);
    assert.equal(patch.method, 'PATCH');
    const roles = JSON.parse(patch.data).appRoles;
    assert.deepEqual(
      roles.map((x) => [x.value, x.id, x.allowedMemberTypes, x.isEnabled]),
      [
        ['Documents.Ingest', INGEST_ROLE_ID, ['Application'], true],
        ['Documents.Search', NEW_ROLE_ID, ['Application'], true],
      ],
    );
    assert.equal(
      roles.some((x) => 'origin' in x),
      false,
      'origin is read-only and never sent',
    );
    assert.deepEqual(roles[0].description, INGEST_ROLE.description);
    assert.equal(post.method, 'POST');
    assert.match(post.url, new RegExp(`/servicePrincipals/${API_SP}/appRoleAssignedTo$`));
    assert.deepEqual(JSON.parse(post.data), {
      principalId: MI_ID,
      resourceId: API_SP,
      appRoleId: NEW_ROLE_ID,
    });
    assert.match(r.stdout, /✔ Documents\.Search assigned/);
    assert.match(r.stdout, new RegExp(`SEARCH_CALLER_APP_IDS=${MI_APPID}`));
    // The token went to curl from a file, never on a command line.
    assert.equal(
      r.graph.some((c) => c.argv.some((a) => a.includes(r.graphToken))),
      false,
    );
    assert.equal(r.stdout.includes(r.graphToken) || r.stderr.includes(r.graphToken), false);

    // Run again on the result: nothing to do, nothing sent.
    const root = scratch((s) => Object.assign(s, r.state));
    const again = run(root, [...BASE, '--apply']);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(writes(again), []);
    assert.match(again.stdout, /already assigned .*: nothing to do/);
  });

  test('a role made by hand keeps its own id; only the assignment is sent', () => {
    const handMade = {
      ...INGEST_ROLE,
      id: 'abababab-abab-4bab-8bab-abababababab',
      displayName: 'Documents.Search',
      value: 'Documents.Search',
    };
    const r = run(
      scratch((s) => {
        s.application.appRoles.push(handMade);
        s.servicePrincipals[0].appRoles = s.application.appRoles;
      }),
      [...BASE, '--apply'],
    );
    assert.equal(r.status, 0, r.stderr);
    const [post, ...rest] = writes(r);
    assert.deepEqual(rest, []);
    assert.equal(post.method, 'POST');
    assert.equal(JSON.parse(post.data).appRoleId, handMade.id);
  });

  test('an app that is not the bot is refused before anything is read', () => {
    const r = run(scratch(), ['-g', RG, '-n', 'func-bcr-ingest-dev-abc', '--apply']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not the bot Function App/);
    assert.deepEqual(r.graph, []);
    assert.deepEqual(r.az, []);
  });

  test("a principal that is not a managed identity, or not this app's system-assigned one, is refused", () => {
    for (const [what, mutate] of [
      ['an application', (s) => (s.servicePrincipals[1].servicePrincipalType = 'Application')],
      [
        'a user-assigned identity',
        (s) =>
          (s.servicePrincipals[1].alternativeNames = [
            'isExplicit=True',
            SITE_ID.replace(
              'Microsoft.Web/sites',
              'Microsoft.ManagedIdentity/userAssignedIdentities',
            ),
          ]),
      ],
      [
        "another app's identity",
        (s) =>
          (s.servicePrincipals[1].alternativeNames = [
            'isExplicit=False',
            SITE_ID.replace(BOT, 'func-bcr-ingest-dev-abc'),
          ]),
      ],
    ]) {
      const r = run(scratch(mutate), [...BASE, '--apply']);
      assert.notEqual(r.status, 0, what);
      assert.match(r.stderr, /refusing/, what);
      assert.deepEqual(writes(r), [], what);
    }
  });

  test('a Documents.Search role that users could hold, or that is disabled, is refused', () => {
    for (const change of [
      { allowedMemberTypes: ['User', 'Application'] },
      { allowedMemberTypes: ['User'] },
      { isEnabled: false },
    ]) {
      const role = {
        ...INGEST_ROLE,
        id: 'abababab-abab-4bab-8bab-abababababab',
        value: 'Documents.Search',
        ...change,
      };
      const r = run(
        scratch((s) => {
          s.application.appRoles.push(role);
          s.servicePrincipals[0].appRoles = s.application.appRoles;
        }),
        [...BASE, '--apply'],
      );
      assert.notEqual(r.status, 0, JSON.stringify(change));
      assert.deepEqual(writes(r), [], JSON.stringify(change));
    }
  });

  test('another principal holding Documents.Search stops the run, dry run included', () => {
    const mutate = (s) => {
      const role = { ...INGEST_ROLE, id: NEW_ROLE_ID, value: 'Documents.Search' };
      s.application.appRoles.push(role);
      s.servicePrincipals[0].appRoles = s.application.appRoles;
      s.assignments.push({
        id: 'assignment-stranger',
        principalId: BOT_APP_SP,
        principalDisplayName: 'BCR Ledger Bot',
        principalType: 'ServicePrincipal',
        resourceId: API_SP,
        resourceDisplayName: 'BCR Ledger Ingestion API',
        appRoleId: NEW_ROLE_ID,
      });
    };
    for (const args of [BASE, [...BASE, '--apply']]) {
      const r = run(scratch(mutate), args);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /assignment-stranger/);
      assert.match(r.stderr, /another principal holds Documents\.Search/);
      assert.deepEqual(writes(r), []);
    }
  });

  test('--apply without the scopes it needs writes nothing', () => {
    const noAssign = run(scratch(), [...BASE, '--apply'], {
      GRAPH_TOKEN: token({ scp: 'Directory.Read.All Application.ReadWrite.All' }),
    });
    assert.notEqual(noAssign.status, 0);
    assert.match(noAssign.stderr, /AppRoleAssignment\.ReadWrite\.All/);
    assert.deepEqual(writes(noAssign), []);

    const noAppWrite = run(scratch(), [...BASE, '--apply'], {
      GRAPH_TOKEN: token({ scp: 'Directory.Read.All AppRoleAssignment.ReadWrite.All' }),
    });
    assert.notEqual(noAppWrite.status, 0);
    assert.match(noAppWrite.stderr, /Application\.ReadWrite\.All/);
    assert.deepEqual(writes(noAppWrite), []);

    // The Azure CLI's own Graph token: Directory.AccessAsUser.All covers the registration.
    const cli = run(scratch(), [...BASE, '--apply'], {
      GRAPH_TOKEN: token({ scp: 'AppRoleAssignment.ReadWrite.All Directory.AccessAsUser.All' }),
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(
      writes(cli).map((c) => c.method),
      ['PATCH', 'POST'],
    );
  });

  test('a token for another tenant is refused', () => {
    const r = run(scratch(), BASE, {
      GRAPH_TOKEN: token({ tid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /GRAPH_TOKEN is for tenant/);
    assert.deepEqual(r.graph, []);
  });

  test('a role that does not reach the service principal stops before the assignment', () => {
    const r = run(
      scratch((s) => (s.spLagsRoles = true)),
      [...BASE, '--apply'],
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not yet on its service principal/);
    assert.deepEqual(
      writes(r).map((c) => c.method),
      ['PATCH'],
    );
  });

  test('--ingestion-app-id overrides the parameter file; a non-GUID is refused', () => {
    const bad = run(scratch(), [...BASE, '--ingestion-app-id', 'not-a-guid']);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /not a GUID/);
    assert.deepEqual(bad.graph, []);

    const other = run(scratch(), [
      ...BASE,
      '--ingestion-app-id',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ]);
    assert.notEqual(other.status, 0);
    assert.match(other.stderr, /HTTP 404 Request_ResourceNotFound/);
    assert.deepEqual(writes(other), []);
  });
});
