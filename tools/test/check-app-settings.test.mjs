import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';

import {
  REPO,
  SCHEMA_FILE,
  bicepParams,
  bicepSettings,
  evaluate,
  liveCheck,
  main,
  parseEnvMap,
  parseExpected,
  resolveParams,
  schemaDefaults,
  splitExpected,
  staticCheck,
} from '../check-app-settings.mjs';
import { CliError } from '../lib/cli.mjs';

// ---------------------------------------------------------------------------
// A small repo with the real layout: two apps, the shared schema, two Bicep
// files. Every case edits one file of it.
// ---------------------------------------------------------------------------

const SHARED_CONFIG = `import { z } from 'zod';

// Helpers, as config.ts builds them. It's fine for a comment to say "(" or '.
const optionalStr = (defaultValue = '') =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? defaultValue : v));

const numeric = (defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : defaultValue));

const wholeNumber = (defaultValue: number) => numeric(defaultValue).refine((n) => n >= 0);

const requiredList = (message: string) =>
  z.string({ required_error: message }).transform((v) => v.split(',').map((s) => s.trim()));

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const logLevel = z
  .enum(['info', 'debug'])
  .optional()
  .transform((v) => v ?? 'info');

export const botConfigSchema = z.object({
  appId: z.string().uuid('APP_ID must be a UUID'),
  /** The client secret; it's a Key Vault reference in Azure. */
  password: z.string().min(1, 'APP_PASSWORD is required'),
  gateMode: z
    .enum(['log', 'enforce'])
    .optional()
    .transform((v) => v ?? 'enforce'),
  logLevel,
});

export const ingestionConfigSchema = z.object({
  // A regex with braces and commas, and this comment has an unbalanced [ in it.
  siteId: z
    .string({ required_error: 'SITE_ID is required' })
    .regex(/^[a-z0-9.-]+,[0-9a-f-]{36},[0-9a-f-]{36}$/i, 'SITE_ID must be <host>,<guid>,<guid>'),
  callers: requiredList('CALLERS must list one id').refine((l) => l.every((id) => GUID.test(id))),
  rows: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : []))
    .refine((ids) => ids.every((id) => /^[1-9][0-9]*$/.test(id)), 'ids, comma-separated'),
  ttlMs: numeric(300000),
  perTick: wholeNumber(20),
  keyEnabled: optionalStr('false'),
  apiKey: optionalStr(),
  logLevel,
});
`;

const BOT_CONFIG = `import { type BotConfig, botConfigSchema, loadConfig } from '@bcr/shared';

const envMap = {
  appId: 'APP_ID',
  password: 'APP_PASSWORD',
  gateMode: 'GATE_MODE',
  logLevel: 'LOG_LEVEL',
} as const satisfies Record<keyof BotConfig, string>;

export function loadBotConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  return loadConfig(botConfigSchema, envMap, env);
}
`;

const INGESTION_CONFIG = `import { type IngestionConfig, ingestionConfigSchema, loadConfig } from '@bcr/shared';

const envMap = {
  siteId: 'SITE_ID',
  callers: 'CALLERS',
  rows: 'SWEEP_ROWS',
  ttlMs: 'TTL_MS',
  perTick: 'PER_TICK',
  keyEnabled: 'KEY_ENABLED',
  apiKey: 'API_KEY',
  logLevel: 'LOG_LEVEL',
} as const satisfies Record<keyof IngestionConfig, string>;

let cached: IngestionConfig | undefined;

export function loadIngestionConfig(env: NodeJS.ProcessEnv = process.env): IngestionConfig {
  if (!cached) cached = loadConfig(ingestionConfigSchema, envMap, env);
  return cached;
}
`;

const FUNCTION_APP_BICEP = `param storageAccountName string
param appInsightsConnectionString string
param appSettings object

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

var runtimeSettings = {
  FUNCTIONS_EXTENSION_VERSION: '~4'
  AzureWebJobsStorage: 'DefaultEndpointsProtocol=https;AccountName=\${storage.name};AccountKey=\${storage.listKeys().keys[0].value}'
  APPLICATIONINSIGHTS_CONNECTION_STRING: appInsightsConnectionString
  NODE_ENV: 'production' // read directly by the code
}
`;

const MAIN_BICEP = `param environmentName string
param botAppId string
param callerAppIds string = botAppId
param siteId string
param ttlMs string = '300000'
param enableKey bool = true
param gateMode string = 'enforce'
param logLevel string = environmentName == 'prod' ? 'info' : 'debug'

var botAppSettings = {
  APP_ID: botAppId
  APP_PASSWORD: '@Microsoft.KeyVault(SecretUri=\${keyVault.outputs.uri}secrets/bot-password/)'
  GATE_MODE: gateMode
  LOG_LEVEL: logLevel
}

var ingestionAppSettings = union(
  {
    SITE_ID: siteId
    CALLERS: callerAppIds
    SWEEP_ROWS: ''
    TTL_MS: ttlMs
    KEY_ENABLED: enableKey ? 'true' : 'false'
    LOG_LEVEL: logLevel
  },
  enableKey
    ? {
        API_KEY: '@Microsoft.KeyVault(SecretUri=\${keyVault.outputs.uri}secrets/api-key/)'
      }
    : {}
)
`;

const BOT_ID = '11111111-1111-1111-1111-111111111111';
const SITE_ID =
  'contoso.sharepoint.com,00000000-0000-0000-0000-000000000001,00000000-0000-0000-0000-000000000002';

const DEV_PARAMS = {
  parameters: {
    environmentName: { value: 'dev' },
    botAppId: { value: BOT_ID },
    siteId: { value: SITE_ID },
    logLevel: { value: 'debug' },
  },
};

function fakeRepo(overrides = {}) {
  const files = {
    [SCHEMA_FILE]: SHARED_CONFIG,
    'packages/shared/src/logger.ts':
      "export const level = process.env.LOG_LEVEL ?? 'info';\nexport const env = process.env.NODE_ENV;\n",
    'packages/teams-bot/src/config.ts': BOT_CONFIG,
    'packages/teams-bot/src/index.ts': "import './config';\n",
    'packages/document-ingestion/src/config.ts': INGESTION_CONFIG,
    'packages/document-ingestion/src/graph.ts':
      "export const dev = process.env['NODE_ENV'] !== 'production';\n",
    'packages/document-ingestion/src/graph.test.ts': 'process.env.ONLY_IN_TESTS = "1";\n',
    'infrastructure/modules/functionApp.bicep': FUNCTION_APP_BICEP,
    'infrastructure/main.bicep': MAIN_BICEP,
    'infrastructure/main.dev.parameters.json': JSON.stringify(DEV_PARAMS),
    ...overrides,
  };
  const root = mkdtempSync(join(tmpdir(), 'appsettings-'));
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) continue;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

const edit = (from, to) => {
  const out = MAIN_BICEP.replace(from, to);
  assert.notEqual(out, MAIN_BICEP, `fixture edit did not apply: ${from}`);
  return out;
};

const names = (list) => list.map((f) => `${f.app}:${f.setting}`).sort();

// ---------------------------------------------------------------------------
// Static check
// ---------------------------------------------------------------------------

describe('static check', () => {
  test('a clean repo: no errors, a warning for the one defaulted setting Bicep leaves out', () => {
    const { errors, warnings } = staticCheck(fakeRepo());
    assert.deepEqual(errors, []);
    assert.deepEqual(names(warnings), ['document-ingestion:PER_TICK']);
    assert.match(warnings[0].message, /code default/);
  });

  test('a required setting Bicep does not set is an error that says the app would not start', () => {
    const { errors } = staticCheck(
      fakeRepo({ 'infrastructure/main.bicep': edit('    SITE_ID: siteId\n', '') }),
    );
    assert.deepEqual(names(errors), ['document-ingestion:SITE_ID']);
    assert.match(errors[0].message, /no default.*would not start/);
  });

  test('a setting the schema defaults is only a warning', () => {
    const { errors, warnings } = staticCheck(
      fakeRepo({ 'infrastructure/main.bicep': edit('  GATE_MODE: gateMode\n', '') }),
    );
    assert.deepEqual(errors, []);
    assert.ok(names(warnings).includes('teams-bot:GATE_MODE'));
  });

  test('a setting per app: one set for the other app only does not count', () => {
    const { errors } = staticCheck(
      fakeRepo({
        'infrastructure/main.bicep': edit('  APP_ID: botAppId\n', '').replace(
          '    SITE_ID: siteId\n',
          '    SITE_ID: siteId\n    APP_ID: botAppId\n',
        ),
      }),
    );
    assert.deepEqual(names(errors), ['document-ingestion:APP_ID', 'teams-bot:APP_ID']);
    assert.match(errors.find((e) => e.app === 'teams-bot').message, /would not start/);
    assert.match(errors.find((e) => e.app === 'document-ingestion').message, /read by no code/);
  });

  test('a stale setting Bicep still sets (the SHAREPOINT_* case) is an error', () => {
    const { errors } = staticCheck(
      fakeRepo({
        'infrastructure/main.bicep': edit(
          '    TTL_MS: ttlMs\n',
          "    TTL_MS: ttlMs\n    SHAREPOINT_SITE_PATH: '/sites/Old'\n",
        ),
      }),
    );
    assert.deepEqual(names(errors), ['document-ingestion:SHAREPOINT_SITE_PATH']);
    assert.match(errors[0].message, /read by no code of this app: remove it/);
  });

  test('a secret set to anything but a Key Vault reference is an error', () => {
    const { errors } = staticCheck(
      fakeRepo({
        'infrastructure/main.bicep': edit(
          /APP_PASSWORD: '@Microsoft[^\n]*/,
          'APP_PASSWORD: botPassword',
        ),
      }),
    );
    assert.deepEqual(names(errors), ['teams-bot:APP_PASSWORD']);
    assert.match(errors[0].message, /Key Vault reference/);
  });

  test('WEBSITE_RUN_FROM_PACKAGE in Bicep is an error: the zip deploy owns it', () => {
    const { errors } = staticCheck(
      fakeRepo({
        'infrastructure/modules/functionApp.bicep': FUNCTION_APP_BICEP.replace(
          "  NODE_ENV: 'production'",
          "  WEBSITE_RUN_FROM_PACKAGE: '1'\n  NODE_ENV: 'production'",
        ),
      }),
    );
    assert.deepEqual(names(errors), [
      'document-ingestion:WEBSITE_RUN_FROM_PACKAGE',
      'teams-bot:WEBSITE_RUN_FROM_PACKAGE',
    ]);
    assert.match(errors[0].message, /zip deploy owns it/);
  });

  test('a direct process.env read counts as required; one in a test file does not count', () => {
    const { errors } = staticCheck(
      fakeRepo({
        'packages/teams-bot/src/extra.ts': 'export const x = process.env.BOT_EXTRA;\n',
      }),
    );
    assert.deepEqual(names(errors), ['teams-bot:BOT_EXTRA']);
    assert.match(errors[0].message, /packages\/teams-bot\/src\/extra\.ts \(process\.env\)/);
  });

  test('NODE_ENV, read only directly, is required: dropping it from Bicep fails both apps', () => {
    const { errors } = staticCheck(
      fakeRepo({
        'infrastructure/modules/functionApp.bicep': FUNCTION_APP_BICEP.replace(
          "  NODE_ENV: 'production' // read directly by the code\n",
          '',
        ),
      }),
    );
    assert.deepEqual(names(errors), ['document-ingestion:NODE_ENV', 'teams-bot:NODE_ENV']);
  });

  test('a missing Bicep variable or file fails the check instead of passing it', () => {
    assert.throws(
      () =>
        staticCheck(
          fakeRepo({ 'infrastructure/main.bicep': edit('var botAppSettings', 'var botSettings') }),
        ),
      (err) => err instanceof CliError && /no `var botAppSettings = \.\.\.`/.test(err.message),
    );
    assert.throws(
      () => staticCheck(fakeRepo({ 'packages/teams-bot/src/config.ts': null })),
      (err) => err instanceof CliError && /teams-bot\/src\/config\.ts: not found/.test(err.message),
    );
  });

  test('an envMap field the schema does not have fails the check', () => {
    assert.throws(
      () =>
        staticCheck(
          fakeRepo({
            'packages/teams-bot/src/config.ts': BOT_CONFIG.replace(
              "  logLevel: 'LOG_LEVEL',",
              "  logLevel: 'LOG_LEVEL',\n  ghost: 'GHOST',",
            ),
          }),
        ),
      /envMap field 'ghost' is not in botConfigSchema/,
    );
  });
});

describe('parsing', () => {
  test('schema defaults: helpers are followed, shorthand fields, regex literals and comments are read', () => {
    const bot = schemaDefaults(SHARED_CONFIG, 'botConfigSchema');
    assert.deepEqual(Object.fromEntries(bot), {
      appId: false,
      password: false,
      gateMode: true,
      logLevel: true,
    });
    const ingestion = schemaDefaults(SHARED_CONFIG, 'ingestionConfigSchema');
    assert.deepEqual(Object.fromEntries(ingestion), {
      siteId: false,
      callers: false,
      rows: true,
      ttlMs: true,
      perTick: true,
      keyEnabled: true,
      apiKey: true,
      logLevel: true,
    });
  });

  test('Bicep settings: strings holding // and braces, trailing comments, conditional objects', () => {
    const source = `var s = union(
  {
    URL: 'https://\${host.outputs.name}/api{v1}' // not part of the value
    'QUOTED_NAME': 'a'
  },
  flag
    ? {
        ONLY_WHEN: 'x'
      }
    : {
        ONLY_UNLESS: 'y'
      }
)
var after = { NOT_THIS: 'z' }
`;
    assert.deepEqual(bicepSettings(source, 's'), [
      { name: 'URL', expr: "'https://${host.outputs.name}/api{v1}'" },
      { name: 'QUOTED_NAME', expr: "'a'" },
      { name: 'ONLY_WHEN', expr: "'x'", when: 'flag' },
      { name: 'ONLY_UNLESS', expr: "'y'", when: '!flag' },
    ]);
  });

  test('Bicep settings: a line holding more than one setting is refused, never half-read', () => {
    const refused = (body) => () => bicepSettings(`var s = {\n${body}\n}\n`, 's', 'x.bicep');
    const cases = [
      // Read as one setting, B would vanish from every check and A's value
      // would stop being compared.
      ["  A: 'x', B: 'y'", /line of A holds a comma outside any string or bracket/],
      ["  A: 'x',", /line of A holds a comma/],
      ["  A: 'x' B: 'y'", /line of A holds a second `NAME:`/],
      ["  A: 'x' 'B': 'y'", /line of A holds a second `NAME:`/],
      ['  A: flag ? one : two B: three', /line of A holds a second `NAME:`/],
      ["  A: concat(\n    'x'\n  )", /line of A holds a value that does not end on its line/],
      ["  A: 'x' }", /line of A holds the '\}' of the enclosing object/],
    ];
    const missed = [];
    for (const [body, why] of cases) {
      try {
        refused(body)();
        missed.push(`${body}: accepted`);
      } catch (err) {
        if (!(err instanceof CliError) || !why.test(err.message)) {
          missed.push(`${body}: ${err.message}`);
        } else if (!/x\.bicep: `var s`: .*Write one setting per line\./.test(err.message)) {
          missed.push(`${body}: message lacks the file, the variable or the fix: ${err.message}`);
        }
      }
    }
    assert.deepEqual(missed, []);
  });

  test('Bicep settings: an object with a setting on its opening line is refused', () => {
    const missed = [];
    for (const source of [
      "var s = { A: 'x', B: 'y' }\n",
      "var s = { A: 'x' }\n",
      "var s = union(\n  {\n    A: 'x'\n  },\n  flag ? { B: 'y' } : {}\n)\n",
      "var s = {\n  A: 'x'\n  C: flag ? { D: 'z' } : {}\n}\n",
    ]) {
      try {
        bicepSettings(source, 's');
        missed.push(`accepted: ${source}`);
      } catch (err) {
        const why = /an object opens with a setting on its line/;
        if (!(err instanceof CliError) || !why.test(err.message)) {
          missed.push(`${source}: ${err.message}`);
        }
      }
    }
    assert.deepEqual(missed, []);
  });

  test('Bicep settings: ternaries, ??, .?, :: and colons inside strings are one setting', () => {
    const source = `var s = union(
  {
    A: flag ? botAppId : otherAppId
    B: environmentName == 'prod' ? 'info' : 'debug' // a comment, with: a colon
    C: first ?? second
    D: thing.?name ?? 'x'
    E: parent::child.properties.name
    F: 'a: b, c'
    G: flag ? (other ? 'x' : 'y') : 'z'
    H: '\${host}:443'
  },
  flag
    ? {}
    : {
        I: '{ J: 1 }'
      }
)
`;
    assert.deepEqual(
      bicepSettings(source, 's').map((s) => s.name),
      ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'],
    );
  });

  test('envMap: a line with two entries, or any line it cannot read, is refused', () => {
    const map = (body) => `const envMap = {\n${body}\n} as const;\n`;
    assert.deepEqual(
      parseEnvMap(map("  // a comment\n  a: 'A', // trailing\n  /* block */\n  b: 'B',\n")),
      [
        { field: 'a', env: 'A' },
        { field: 'b', env: 'B' },
      ],
    );
    for (const body of ["  a: 'A', b: 'B',", '  a: `A`,', "  a: 'A',\n  ...rest,"]) {
      assert.throws(
        () => parseEnvMap(map(body), 'x/config.ts'),
        (err) =>
          err instanceof CliError && /x\/config\.ts: cannot read the envMap line/.test(err.message),
        body,
      );
    }
  });

  test('evaluate: parameters, literals, interpolation, a boolean ternary; the rest is runtime', () => {
    const params = resolveParams(bicepParams(MAIN_BICEP), {
      environmentName: 'dev',
      botAppId: BOT_ID,
      siteId: SITE_ID,
    });
    assert.equal(params.get('callerAppIds'), BOT_ID, 'a default that is another parameter');
    assert.equal(params.get('ttlMs'), '300000');
    assert.equal(params.get('enableKey'), true);
    assert.equal(params.get('logLevel'), undefined, 'a ternary default is not guessed');

    assert.deepEqual(evaluate('callerAppIds', params), { kind: 'value', value: BOT_ID });
    assert.deepEqual(evaluate("'api://${botAppId}/.default'", params), {
      kind: 'value',
      value: `api://${BOT_ID}/.default`,
    });
    assert.deepEqual(evaluate("enableKey ? 'true' : 'false'", params), {
      kind: 'value',
      value: 'true',
    });
    assert.deepEqual(evaluate("'it\\'s'", params), { kind: 'value', value: "it's" });
    assert.deepEqual(
      evaluate("'@Microsoft.KeyVault(SecretUri=${keyVault.outputs.uri}secrets/api-key/)'", params),
      { kind: 'keyVault', secret: 'api-key' },
    );
    for (const runtime of [
      "'https://${ingestion.outputs.defaultHostname}'",
      'appInsightsConnectionString',
      'logLevel',
      'string(enableKey)',
      'enableKey',
    ]) {
      assert.deepEqual(evaluate(runtime, params), { kind: 'runtime' }, runtime);
    }
  });
});

// ---------------------------------------------------------------------------
// The real repo
// ---------------------------------------------------------------------------

describe('this repo', () => {
  test('Bicep sets every setting the code needs, and nothing stale', () => {
    const { errors, warnings } = staticCheck(REPO);
    assert.deepEqual(errors, []);
    // Only settings the schema defaults may be left out.
    for (const w of warnings) assert.match(w.message, /code default/);
  });

  test('the schema parse matches what config.ts requires', () => {
    const source = readFileSync(join(REPO, SCHEMA_FILE), 'utf8');
    const required = (schema) =>
      [...schemaDefaults(source, schema)]
        .filter(([, d]) => !d)
        .map(([f]) => f)
        .sort();
    assert.deepEqual(required('botConfigSchema'), [
      'ingestionBaseUrl',
      'ingestionScope',
      'microsoftAppId',
      'microsoftAppPassword',
      'microsoftAppTenantId',
      'microsoftAppType',
    ]);
    assert.deepEqual(
      required('ingestionConfigSchema'),
      [
        'azureTenantId',
        'botCallerAppIds',
        'clientDirectoryListId',
        'clientDirectorySiteId',
        'expectedAudience',
        'forbiddenTargetSitePaths',
        'ingestionAppId',
        'quarantineSitePath',
        'quarantineSiteHostname',
      ].sort(),
    );
  });

  test('the schema parse agrees with the built schema itself', (t) => {
    const dist = join(REPO, 'packages/shared/dist/config.js');
    if (!existsSync(dist)) {
      t.skip('@bcr/shared is not built (CI builds it before test:tools)');
      return;
    }
    const built = createRequire(import.meta.url)(dist);
    const source = readFileSync(join(REPO, SCHEMA_FILE), 'utf8');
    const mismatches = [];
    for (const schema of ['botConfigSchema', 'ingestionConfigSchema']) {
      for (const [field, parsed] of schemaDefaults(source, schema)) {
        const actual = built[schema].shape[field].safeParse(undefined).success;
        if (actual !== parsed)
          mismatches.push(`${schema}.${field}: parsed ${parsed}, built ${actual}`);
      }
    }
    assert.deepEqual(mismatches, []);
  });

  test('with the dev parameters, the settings evaluate as they run', () => {
    const params = resolveParams(
      bicepParams(readFileSync(join(REPO, 'infrastructure/main.bicep'), 'utf8')),
      Object.fromEntries(
        Object.entries(
          JSON.parse(readFileSync(join(REPO, 'infrastructure/main.dev.parameters.json'), 'utf8'))
            .parameters,
        ).map(([k, v]) => [k, v.value]),
      ),
    );
    const settings = Object.fromEntries(
      bicepSettings(
        readFileSync(join(REPO, 'infrastructure/main.bicep'), 'utf8'),
        'ingestionAppSettings',
      ).map((s) => [s.name, evaluate(s.expr, params)]),
    );
    // Spelt as it runs: ARM's string(true) would be 'True'.
    assert.match(settings.ANTHROPIC_ENABLED.value, /^(true|false)$/);
    assert.deepEqual(settings.ANTHROPIC_API_KEY, { kind: 'keyVault', secret: 'anthropic-api-key' });
    assert.equal(settings.EXPECTED_AUDIENCE.value, `api://${params.get('ingestionAppId')}`);
    // Every other ingestion setting follows from the parameters file alone,
    // so --live compares every one of them.
    const runtime = Object.entries(settings)
      .filter(([, v]) => v.kind === 'runtime')
      .map(([k]) => k);
    assert.deepEqual(runtime, []);
  });

  // The classification release: a deploy must never put the old model back or
  // re-add the retired threshold, and must write a threshold the code accepts.
  test('the template and both parameter files carry the classification release', (t) => {
    const template = readFileSync(join(REPO, 'infrastructure/main.bicep'), 'utf8');
    const dist = join(REPO, 'packages/shared/dist/config.js');
    const schema = existsSync(dist)
      ? createRequire(import.meta.url)(dist).ingestionConfigSchema.shape
          .classificationAcceptThreshold
      : undefined;
    if (!schema) t.diagnostic('@bcr/shared is not built: the threshold range is checked by hand');
    const offenders = [];
    for (const env of ['dev', 'prod', undefined]) {
      const file = env
        ? JSON.parse(
            readFileSync(join(REPO, `infrastructure/main.${env}.parameters.json`), 'utf8'),
          ).parameters
        : {};
      const params = resolveParams(
        bicepParams(template),
        Object.fromEntries(Object.entries(file).map(([k, v]) => [k, v.value])),
      );
      const settings = Object.fromEntries(
        bicepSettings(template, 'ingestionAppSettings').map((s) => [
          s.name,
          evaluate(s.expr, params),
        ]),
      );
      const where = env ?? 'template defaults';
      if (settings.ANTHROPIC_MODEL?.value !== 'claude-opus-5') {
        offenders.push(`${where}: ANTHROPIC_MODEL ${JSON.stringify(settings.ANTHROPIC_MODEL)}`);
      }
      if ('ANTHROPIC_CONFIDENCE_THRESHOLD' in settings) {
        offenders.push(`${where}: sets the retired ANTHROPIC_CONFIDENCE_THRESHOLD`);
      }
      const threshold = settings.CLASSIFICATION_ACCEPT_THRESHOLD?.value;
      const accepted = schema
        ? schema.safeParse(threshold).success && threshold !== ''
        : Number(threshold) >= 0.7 && Number(threshold) <= 0.95;
      if (!accepted) offenders.push(`${where}: CLASSIFICATION_ACCEPT_THRESHOLD ${threshold}`);
    }
    assert.deepEqual(offenders, []);
  });
});

// ---------------------------------------------------------------------------
// Live comparison, against a fake `az`
// ---------------------------------------------------------------------------

const KV = (secret) =>
  `@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/${secret}/)`;
const STORAGE =
  'DefaultEndpointsProtocol=https;AccountName=st;AccountKey=c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0==';
const APPI = 'InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://x';
const PACKAGE = 'https://st.blob.core.windows.net/pkgs/app.zip?sv=2024&sig=c2Fz';

const runningBot = () => ({
  FUNCTIONS_EXTENSION_VERSION: '~4',
  AzureWebJobsStorage: STORAGE,
  APPLICATIONINSIGHTS_CONNECTION_STRING: APPI,
  NODE_ENV: 'production',
  WEBSITE_RUN_FROM_PACKAGE: PACKAGE,
  APP_ID: BOT_ID,
  APP_PASSWORD: KV('bot-password'),
  GATE_MODE: 'enforce',
  LOG_LEVEL: 'debug',
});

const runningIngestion = () => ({
  FUNCTIONS_EXTENSION_VERSION: '~4',
  AzureWebJobsStorage: STORAGE,
  APPLICATIONINSIGHTS_CONNECTION_STRING: APPI,
  NODE_ENV: 'production',
  WEBSITE_RUN_FROM_PACKAGE: PACKAGE,
  SITE_ID,
  CALLERS: BOT_ID,
  SWEEP_ROWS: '',
  TTL_MS: '300000',
  KEY_ENABLED: 'true',
  LOG_LEVEL: 'debug',
  API_KEY: KV('api-key'),
});

/**
 * Answers the three queries the check makes, from `apps` ({ appName: settings }),
 * and records every call. A value is returned only for a name the query lists.
 */
function fakeAz(apps) {
  const calls = [];
  const valueReads = [];
  const az = (args) => {
    calls.push(args);
    if (args[0] === 'functionapp' && args[1] === 'list') return Object.keys(apps);
    const settings = apps[args[args.indexOf('-n') + 1]];
    const query = args[args.indexOf('--query') + 1];
    if (query.startsWith('[].{name:name, kv: starts_with(value, ')) {
      return Object.entries(settings).map(([name, v]) => ({
        name,
        kv: v.startsWith('@Microsoft.KeyVault('),
      }));
    }
    let m = /^\[\?name=='([^']+)'\] \| \[0\]\.ends_with\(value, '([^']+)'\)$/.exec(query);
    if (m) return settings[m[1]] === undefined ? null : settings[m[1]].endsWith(m[2]);
    m = /^\[\?contains\(\[(.*)\], name\)\]\.\{name:name, value:value\}$/.exec(query);
    if (m) {
      const listed = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
      valueReads.push(...listed);
      return listed.filter((n) => n in settings).map((n) => ({ name: n, value: settings[n] }));
    }
    throw new Error(`unexpected az call: ${args.join(' ')}`);
  };
  return { az, calls, valueReads };
}

function live(repo, apps, params = 'infrastructure/main.dev.parameters.json') {
  const fake = fakeAz(apps);
  const result = liveCheck({ repo, resourceGroup: 'rg-test', parametersFile: params, az: fake.az });
  return { ...result, ...fake };
}

const BOT = 'func-bcr-bot-dev-abc';
const INGEST = 'func-bcr-ingest-dev-abc';

describe('live comparison', () => {
  test('matching apps: no drift, and no secret or deployment-only value is ever read', () => {
    const r = live(fakeRepo(), { [BOT]: runningBot(), [INGEST]: runningIngestion() });
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.valueReads.sort(), [
      'APP_ID',
      'CALLERS',
      'FUNCTIONS_EXTENSION_VERSION',
      'FUNCTIONS_EXTENSION_VERSION',
      'GATE_MODE',
      'KEY_ENABLED',
      'LOG_LEVEL',
      'LOG_LEVEL',
      'NODE_ENV',
      'NODE_ENV',
      'SITE_ID',
      'SWEEP_ROWS',
      'TTL_MS',
    ]);
    const bot = r.report.find((x) => x.app === 'teams-bot');
    assert.ok(
      bot.notes.some((n) => /WEBSITE_RUN_FROM_PACKAGE: running, not compared; .* list\(\)/.test(n)),
    );
    assert.ok(
      bot.notes.some((n) =>
        /not compared.*APPLICATIONINSIGHTS_CONNECTION_STRING, AzureWebJobsStorage/.test(n),
      ),
    );
  });

  test('a running setting Bicep lacks is drift: a deploy would delete it', () => {
    const ingestion = { ...runningIngestion(), INBOX_MAX_FILES_PER_TICK: '50' };
    const r = live(fakeRepo(), { [BOT]: runningBot(), [INGEST]: ingestion });
    assert.deepEqual(names(r.findings), ['document-ingestion:INBOX_MAX_FILES_PER_TICK']);
    assert.match(r.findings[0].message, /a deploy would delete it/);
  });

  test('a Bicep setting that is not running is drift: a deploy would add it', () => {
    const bot = runningBot();
    delete bot.GATE_MODE;
    const r = live(fakeRepo(), { [BOT]: bot, [INGEST]: runningIngestion() });
    assert.deepEqual(names(r.findings), ['teams-bot:GATE_MODE']);
    assert.match(r.findings[0].message, /a deploy would add it/);
  });

  test('a value changed by hand is drift, shown with both values', () => {
    const r = live(fakeRepo(), {
      [BOT]: { ...runningBot(), GATE_MODE: 'log' },
      [INGEST]: runningIngestion(),
    });
    assert.deepEqual(names(r.findings), ['teams-bot:GATE_MODE']);
    assert.match(r.findings[0].message, /running "log", Bicep "enforce"/);
  });

  test('a running value that looks like a secret is never printed', () => {
    const r = live(fakeRepo(), {
      [BOT]: { ...runningBot(), GATE_MODE: STORAGE },
      [INGEST]: runningIngestion(),
    });
    assert.match(r.findings[0].message, /running \(not shown: looks like a secret\)/);
    assert.doesNotMatch(JSON.stringify(r.findings), /AccountKey/);
  });

  test('Key Vault references: a plain running value, or another secret, is drift', () => {
    const r = live(fakeRepo(), {
      [BOT]: { ...runningBot(), APP_PASSWORD: 'plain-text' },
      [INGEST]: { ...runningIngestion(), API_KEY: KV('other-key') },
    });
    assert.deepEqual(names(r.findings), ['document-ingestion:API_KEY', 'teams-bot:APP_PASSWORD']);
    assert.match(r.findings.find((f) => f.setting === 'APP_PASSWORD').message, /not one/);
    assert.match(
      r.findings.find((f) => f.setting === 'API_KEY').message,
      /not to secret 'api-key\/'/,
    );
    assert.ok(!r.valueReads.includes('APP_PASSWORD'), 'the secret itself is never read');
  });

  test('a setting Bicep sets only when a parameter is true follows the parameters file', () => {
    const repo = fakeRepo({
      'infrastructure/main.dev.parameters.json': JSON.stringify({
        parameters: { ...DEV_PARAMS.parameters, enableKey: { value: false } },
      }),
    });
    const r = live(repo, {
      [BOT]: runningBot(),
      [INGEST]: { ...runningIngestion(), KEY_ENABLED: 'false' },
    });
    assert.deepEqual(names(r.findings), ['document-ingestion:API_KEY']);
    assert.match(r.findings[0].message, /a deploy would delete it/);
  });

  test('no package URL yet is a note, not drift', () => {
    const bot = runningBot();
    delete bot.WEBSITE_RUN_FROM_PACKAGE;
    const r = live(fakeRepo(), { [BOT]: bot, [INGEST]: runningIngestion() });
    assert.deepEqual(r.findings, []);
    const notes = r.report.find((x) => x.app === 'teams-bot').notes;
    assert.ok(notes.some((n) => /not set; the next zip deploy sets it/.test(n)));
  });

  test('not exactly one Function App per prefix is a finding, not a guess', () => {
    const r = live(fakeRepo(), {
      [BOT]: runningBot(),
      'func-bcr-bot-dev-other': runningBot(),
      [INGEST]: runningIngestion(),
    });
    assert.deepEqual(names(r.findings), ['teams-bot:-']);
    assert.match(r.findings[0].message, /2 Function Apps named func-bcr-bot-\*/);
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

describe('cli', () => {
  const run = async (argv, opts = {}) => {
    const out = [];
    const code = await main(argv, { log: (s) => out.push(String(s)), ...opts });
    return { code, out: out.join('\n') };
  };

  test('static: 0 with warnings, 1 with an error', async () => {
    const clean = await run([], { repo: fakeRepo() });
    assert.equal(clean.code, 0);
    assert.match(clean.out, /PER_TICK/);
    const broken = await run([], {
      repo: fakeRepo({ 'infrastructure/main.bicep': edit('    SITE_ID: siteId\n', '') }),
    });
    assert.equal(broken.code, 1);
    assert.match(broken.out, /SITE_ID/);
  });

  test('live: 1 on drift', async () => {
    const repo = fakeRepo();
    const fake = fakeAz({ [BOT]: { ...runningBot(), EXTRA: 'x' }, [INGEST]: runningIngestion() });
    const r = await run(
      ['--live', '-g', 'rg-test', '-p', join(repo, 'infrastructure/main.dev.parameters.json')],
      {
        repo,
        az: fake.az,
      },
    );
    assert.equal(r.code, 1);
    assert.match(r.out, /EXTRA.*would delete it/);
  });

  // A deploy meant to change LOG_LEVEL (on both apps) and GATE_MODE, next to
  // a hand-set EXTRA nobody meant to delete.
  const driftingApps = () => ({
    [BOT]: { ...runningBot(), GATE_MODE: 'log', LOG_LEVEL: 'info', EXTRA: 'x' },
    [INGEST]: { ...runningIngestion(), LOG_LEVEL: 'info' },
  });
  const runLive = async (expect, apps = driftingApps()) => {
    const repo = fakeRepo();
    const fake = fakeAz(apps);
    const params = join(repo, 'infrastructure/main.dev.parameters.json');
    return run(['--live', '-g', 'rg-test', '-p', params, ...expect], { repo, az: fake.az });
  };

  test('live --expect: the named changes print as notes, any other difference still fails', async () => {
    const r = await runLive(['--expect', 'GATE_MODE,LOG_LEVEL']);
    assert.equal(r.code, 1);
    assert.match(
      r.out,
      /drift\s+teams-bot\s+EXTRA\s+running, not in Bicep: a deploy would delete it/,
    );
    // Both values stay visible for the review; one name covers both apps.
    assert.match(
      r.out,
      /note\s+teams-bot\s+GATE_MODE\s+expected \(--expect\): .*running "log", Bicep "enforce"/,
    );
    assert.match(r.out, /note\s+teams-bot\s+LOG_LEVEL\s+expected/);
    assert.match(r.out, /note\s+document-ingestion\s+LOG_LEVEL\s+expected/);
    assert.doesNotMatch(r.out, /drift\s+\S+\s+(GATE_MODE|LOG_LEVEL)/);
    assert.match(r.out, /✖ 0 error\(s\), 1 drift finding\(s\), 3 expected change\(s\) to review/);
  });

  test('live --expect: repeatable, spaces trimmed; clean once every difference is expected', async () => {
    const r = await runLive(['--expect', 'GATE_MODE, LOG_LEVEL', '--expect', 'EXTRA']);
    assert.equal(r.code, 0);
    assert.match(r.out, /note\s+teams-bot\s+EXTRA\s+expected \(--expect\): .*would delete it/);
    assert.match(r.out, /✔ no errors, no unexpected drift, 4 expected change\(s\) to review/);
  });

  test('live --expect: a name with no difference is a warning, not a pass for anything else', async () => {
    const clean = { [BOT]: runningBot(), [INGEST]: runningIngestion() };
    const r = await runLive(['--expect', 'TTL_MS'], clean);
    assert.equal(r.code, 0);
    assert.match(r.out, /warn\s+\(--expect\)\s+TTL_MS\s+expected a change, found none/);
    assert.match(r.out, /✔ no errors, no unexpected drift, 2 warning\(s\)/);
  });

  test('parseExpected and splitExpected', () => {
    assert.deepEqual([...parseExpected(['A, B', 'C', 'A'])], ['A', 'B', 'C']);
    assert.deepEqual([...parseExpected()], []);
    for (const bad of ['', ' ', 'A,,B', 'A,', 'A B', '-', 'A=1', '1A']) {
      assert.throws(
        () => parseExpected([bad]),
        (err) => err instanceof CliError && err.exitCode === 2,
        JSON.stringify(bad),
      );
    }
    const f = (app, setting) => ({ app, setting, message: 'm' });
    assert.deepEqual(
      splitExpected(
        [f('bot', 'A'), f('ingest', 'A'), f('bot', 'B'), f('bot', '-')],
        new Set(['A', 'Z']),
      ),
      {
        drift: [f('bot', 'B'), f('bot', '-')],
        expected: [f('bot', 'A'), f('ingest', 'A')],
        unmatched: ['Z'],
      },
    );
  });

  test('a refused --expect value is quoted: a newline in it cannot start a line of output', () => {
    // A workflow input reaches --expect; a line starting with :: is a runner command.
    assert.throws(
      () => parseExpected(['LOG_LEVEL\n::error::injected']),
      (err) =>
        err instanceof CliError &&
        err.message.includes('"LOG_LEVEL\\n::error::injected"') &&
        !/\n::/.test(err.message),
    );
  });

  test('usage errors are refused with exit 2', async () => {
    for (const argv of [
      ['--live'],
      ['--live', '-g', 'rg'],
      ['-g', 'rg'],
      ['extra'],
      ['--aply'],
      ['--expect', 'GATE_MODE'],
      ['--live', '-g', 'rg', '-p', 'p.json', '--expect', ''],
      ['--live', '-g', 'rg', '-p', 'p.json', '--expect', 'A,,B'],
    ]) {
      await assert.rejects(
        run(argv, { repo: fakeRepo() }),
        (err) => err instanceof CliError,
        argv.join(' '),
      );
    }
    await assert.rejects(run(['--live'], { repo: fakeRepo() }), (err) => err.exitCode === 2);
    await assert.rejects(
      run(['--expect', 'GATE_MODE'], { repo: fakeRepo() }),
      (err) => err.exitCode === 2 && /need --live/.test(err.message),
    );
  });
});
