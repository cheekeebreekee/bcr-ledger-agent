#!/usr/bin/env node
/**
 * Keeps the Function Apps' app settings in Bicep and in the code in step.
 *
 * A Bicep deploy REPLACES every app setting of a Function App with the
 * template's. When "dev" (production) got its Phase-0 routing settings by hand
 * and the template did not, one deploy would have deleted them and ingestion
 * would have refused to start (gate G1). What-if does not catch that: it reads
 * no app-setting values and reports no change whatever they hold. This check
 * does, in two modes.
 *
 * ## Static (the default; offline, what CI runs)
 *
 * For each Function App:
 *   - every setting its code reads is set by Bicep for that app. "Reads" is
 *     its config `envMap` (packages/<app>/src/config.ts) plus any direct
 *     `process.env.X` in its sources or @bcr/shared's. Missing is an error,
 *     unless the zod schema defaults it: then a warning, so leaving it to the
 *     code's default stays a visible choice;
 *   - every setting Bicep sets for it is read by its code or is a platform
 *     setting (FUNCTIONS_*, AzureWebJobsStorage, ...). A stale one is an error:
 *     it is how SHAREPOINT_*, CLIENT_NIP and the like lingered;
 *   - a secret-named setting (...PASSWORD, ...SECRET, ...API_KEY) is a Key
 *     Vault reference, never a value;
 *   - Bicep does not set WEBSITE_RUN_FROM_PACKAGE: the zip deploy owns it, and
 *     functionApp.bicep carries the running one over.
 * A file or Bicep variable it cannot find is an error, never a pass.
 *
 * ## Live (--live; read-only, needs `az login`)
 *
 * Compares what a deploy would write with the running apps in a resource
 * group: the setting names (a deploy would delete, or add), whether each is a
 * Key Vault reference (and to which secret), and the value of every setting
 * whose Bicep value comes only from the parameters file or a literal. Those
 * are not secrets: the parameters file is committed. No other value is read:
 * the storage connection string, the App Insights connection string, the
 * package URL and the Key Vault secrets are checked by name or as booleans in
 * the `az` query itself, so they never reach this process.
 *
 * Usage:
 *   node tools/check-app-settings.mjs
 *   node tools/check-app-settings.mjs --live -g rg-bcr-ledger-dev \
 *     -p infrastructure/main.dev.parameters.json
 *
 * Exit: 0 clean (warnings allowed), 1 a finding, 2 a usage error.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CliError, bad, bold, dim, isMain, ok, parseCli, runMain, warn } from './lib/cli.mjs';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Where the shared zod schemas live. */
export const SCHEMA_FILE = 'packages/shared/src/config.ts';

/**
 * The two Function Apps. `bicep` lists the variables that together are the
 * app's settings, in union order (a later one wins on a shared name).
 */
export const APPS = [
  {
    app: 'teams-bot',
    config: 'packages/teams-bot/src/config.ts',
    sources: ['packages/teams-bot/src', 'packages/shared/src'],
    bicep: [
      { file: 'infrastructure/modules/functionApp.bicep', variable: 'runtimeSettings' },
      { file: 'infrastructure/main.bicep', variable: 'botAppSettings' },
    ],
    functionAppPrefix: 'func-bcr-bot-',
  },
  {
    app: 'document-ingestion',
    config: 'packages/document-ingestion/src/config.ts',
    sources: ['packages/document-ingestion/src', 'packages/shared/src'],
    bicep: [
      { file: 'infrastructure/modules/functionApp.bicep', variable: 'runtimeSettings' },
      { file: 'infrastructure/main.bicep', variable: 'ingestionAppSettings' },
    ],
    functionAppPrefix: 'func-bcr-ingest-',
  },
];

/** The main template, for parameter defaults in live mode. */
export const MAIN_BICEP = 'infrastructure/main.bicep';

/**
 * Set by Bicep for the Functions host and the Node runtime, which read them
 * whether or not our code does. Never reported as stale.
 */
export const PLATFORM_SETTINGS = new Set([
  'FUNCTIONS_EXTENSION_VERSION',
  'FUNCTIONS_WORKER_RUNTIME',
  'WEBSITE_NODE_DEFAULT_VERSION',
  'AzureWebJobsStorage',
  'APPLICATIONINSIGHTS_CONNECTION_STRING',
  'NODE_ENV',
]);

/** Owned by the zip deploy (a SAS URL on Linux Consumption), never by Bicep. */
export const ZIP_DEPLOY_SETTING = 'WEBSITE_RUN_FROM_PACKAGE';

/** A name that says it holds a secret. Its Bicep value must be a Key Vault reference. */
const SECRET_NAME = /(PASSWORD|SECRET|API_KEY)$/;

/**
 * Settings whose value live mode never asks `az` for, whatever their Bicep
 * expression: a storage key, an App Insights key, a SAS URL.
 */
const NEVER_READ = new Set([
  'AzureWebJobsStorage',
  'APPLICATIONINSIGHTS_CONNECTION_STRING',
  ZIP_DEPLOY_SETTING,
]);

const KV_PREFIX = '@Microsoft.KeyVault(';

// ---------------------------------------------------------------------------
// A small scanner: brackets, strings and comments in Bicep and TypeScript
// ---------------------------------------------------------------------------

const CLOSER = { '{': '}', '(': ')', '[': ']' };

/**
 * Index just after the token at `i`: a comment, a string, a regex literal, a
 * whole bracketed group, or else one character. `lang` is 'bicep' ('...' with
 * ${}, and '''...''') or 'ts' ('...', "...", `...${}`, regex literals).
 */
function skipToken(s, i, lang) {
  const c = s[i];
  if (c === '/' && s[i + 1] === '/') {
    const nl = s.indexOf('\n', i);
    return nl < 0 ? s.length : nl;
  }
  if (c === '/' && s[i + 1] === '*') {
    const end = s.indexOf('*/', i + 2);
    if (end < 0) throw new Error('unterminated comment');
    return end + 2;
  }
  if (c === "'" || (lang === 'ts' && (c === '"' || c === '`'))) return skipString(s, i, lang);
  if (lang === 'ts' && c === '/' && startsRegex(s, i)) return skipRegex(s, i);
  if (CLOSER[c]) return skipBalanced(s, i + 1, CLOSER[c], lang);
  return i + 1;
}

/** Index just after the `closer` that balances a bracket opened before `i`. */
function skipBalanced(s, i, closer, lang) {
  while (i < s.length) {
    const c = s[i];
    if (c === closer) return i + 1;
    if (c === '}' || c === ')' || c === ']') throw new Error(`unbalanced '${c}' at ${i}`);
    i = skipToken(s, i, lang);
  }
  throw new Error(`no closing '${closer}'`);
}

/** Index of the first `stop` character at bracket depth 0 from `i`, or the end. */
function scanTo(s, i, stop, lang) {
  while (i < s.length && !stop.includes(s[i])) i = skipToken(s, i, lang);
  return i;
}

/** Index just after the string that starts at `i`. */
function skipString(s, i, lang) {
  const quote = s[i];
  if (lang === 'bicep' && s.startsWith("'''", i)) {
    const end = s.indexOf("'''", i + 3);
    if (end < 0) throw new Error('unterminated multi-line string');
    return end + 3;
  }
  const interpolates = lang === 'bicep' || quote === '`';
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (interpolates && c === '$' && s[i + 1] === '{') {
      i = skipBalanced(s, i + 2, '}', lang);
      continue;
    }
    if (c === '\n' && quote !== '`' && lang === 'ts') throw new Error('unterminated string');
    i++;
  }
  throw new Error('unterminated string');
}

const BEFORE_REGEX_WORDS = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'void',
  'delete',
  'throw',
  'new',
  'yield',
  'await',
]);

/** Whether a `/` at `i` starts a regex literal rather than a division. */
function startsRegex(s, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(s[j])) j--;
  if (j < 0 || '(,=:[!&|?{};'.includes(s[j])) return true;
  if (s[j] === '>' && s[j - 1] === '=') return true; // `=> /re/`
  const word = /[A-Za-z_$][\w$]*$/.exec(s.slice(Math.max(0, j - 10), j + 1));
  return word !== null && BEFORE_REGEX_WORDS.has(word[0]);
}

function skipRegex(s, i) {
  let inClass = false;
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '\n') throw new Error('unterminated regex');
    if (inClass) {
      if (c === ']') inClass = false;
    } else if (c === '[') inClass = true;
    else if (c === '/') {
      i++;
      while (/[a-z]/i.test(s[i] ?? '')) i++;
      return i;
    }
    i++;
  }
  throw new Error('unterminated regex');
}

/** `text` without a trailing `// comment` (a `//` inside a string stays). */
function stripLineComment(text) {
  let i = 0;
  while (i < text.length) {
    if (text[i] === "'") {
      i = skipString(text, i, 'bicep');
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '/') return text.slice(0, i).trimEnd();
    i++;
  }
  return text.trimEnd();
}

// ---------------------------------------------------------------------------
// The code side: envMap, schema defaults, direct process.env reads
// ---------------------------------------------------------------------------

/** `[{ field, env }]` from the `const envMap = { ... }` of a config.ts. */
export function parseEnvMap(source, where = 'config.ts') {
  const m = /const\s+envMap\s*=\s*\{/.exec(source);
  if (!m) throw new CliError(`${where}: no \`const envMap = {\``);
  const start = m.index + m[0].length;
  const body = source.slice(start, skipBalanced(source, start, '}', 'ts') - 1);
  const entries = [...body.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:\s*'([^']+)'\s*,?\s*$/gm)].map(
    (e) => ({ field: e[1], env: e[2] }),
  );
  if (entries.length === 0) throw new CliError(`${where}: envMap has no entries`);
  return entries;
}

/** The zod schema a config.ts loads: the first argument of `loadConfig(`. */
export function schemaNameOf(source, where = 'config.ts') {
  const m = /loadConfig\(\s*([A-Za-z_$][\w$]*)\s*,/.exec(source);
  if (!m) throw new CliError(`${where}: no loadConfig(<schema>, ...) call`);
  return m[1];
}

/** Top-level `const NAME = ...;` definitions of a TypeScript file, by name. */
function topLevelConsts(source) {
  const defs = new Map();
  for (const m of source.matchAll(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*/gm)) {
    const start = m.index + m[0].length;
    defs.set(m[1], source.slice(start, scanTo(source, start, ';', 'ts')));
  }
  return defs;
}

/**
 * `Map(field -> hasDefault)` for `export const <schemaName> = z.object({...})`.
 *
 * A field has a default when its schema, with every helper it calls from the
 * same file expanded (`numeric`, `csvList`, `optionalStr`, `logLevel`, ...),
 * contains `.optional()` or `.default(`: that is how every optional field in
 * config.ts is built. A test checks this against the built schema itself
 * (`shape[field].safeParse(undefined)`) whenever @bcr/shared is built.
 */
export function schemaDefaults(source, schemaName, where = SCHEMA_FILE) {
  const m = new RegExp(`const\\s+${schemaName}\\s*=\\s*z\\.object\\(\\s*\\{`).exec(source);
  if (!m) throw new CliError(`${where}: no \`const ${schemaName} = z.object({\``);
  const start = m.index + m[0].length;
  const end = skipBalanced(source, start, '}', 'ts') - 1;
  const body = source.slice(start, end);
  const consts = topLevelConsts(source);

  // Split the object body into top-level `field: expression` entries.
  const fields = new Map();
  let i = 0;
  while (i < body.length) {
    const rest = body.slice(i);
    const ws = /^(\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|,)/.exec(rest);
    if (ws) {
      i += ws[0].length;
      continue;
    }
    // `field: expression`, or the shorthand `field,` (the expression is a const).
    const key = /^([A-Za-z_$][\w$]*)\s*(:\s*)?/.exec(rest);
    if (!key || (!key[2] && !/^\s*(,|$)/.test(rest.slice(key[0].length)))) {
      throw new CliError(`${where}: cannot read ${schemaName} near "${rest.slice(0, 40)}"`);
    }
    const exprStart = i + key[0].length;
    const exprEnd = scanTo(body, exprStart, ',', 'ts');
    const expression = key[2] ? body.slice(exprStart, exprEnd) : key[1];
    fields.set(key[1], hasDefault(expression, consts));
    i = exprEnd;
  }
  return fields;
}

function hasDefault(expression, consts) {
  // Comments may name a helper the field does not call.
  let text = expression.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const seen = new Set();
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, def] of consts) {
      if (seen.has(name) || !new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(text)) continue;
      seen.add(name);
      text += `\n${def}`;
      changed = true;
    }
  }
  return /\.optional\(\)|\.default\(/.test(text);
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts'))
      yield path;
  }
}

/** Env var names read as `process.env.X` / `process.env['X']` in the non-test sources under `dirs`. */
export function directEnvReads(repo, dirs) {
  const reads = new Map();
  for (const dir of dirs) {
    const abs = join(repo, dir);
    if (!existsSync(abs)) throw new CliError(`${dir}: not found`);
    for (const file of sourceFiles(abs)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(
        /process\.env(?:\.([A-Za-z_]\w*)|\[\s*['"]([^'"]+)['"]\s*\])/g,
      )) {
        const name = m[1] ?? m[2];
        if (!reads.has(name)) reads.set(name, file.slice(repo.length + 1));
      }
    }
  }
  return reads;
}

// ---------------------------------------------------------------------------
// The Bicep side
// ---------------------------------------------------------------------------

/**
 * The settings in `var <variable> = ...`: `[{ name, expr, when }]`, where
 * `expr` is the Bicep expression of its value and `when` the parameter a
 * `<param> ? { ... } : {}` object depends on ('!param' for the else object).
 * Keys are read one per line, as this repo writes app settings.
 */
export function bicepSettings(source, variable, where = 'main.bicep') {
  const m = new RegExp(`^var\\s+${variable}\\s*=\\s*`, 'm').exec(source);
  if (!m) throw new CliError(`${where}: no \`var ${variable} = ...\``);
  // The value: to the end of its first line, taking in any bracket opened there.
  const start = m.index + m[0].length;
  const text = source.slice(start, scanTo(source, start, '\n', 'bicep'));

  // Spans of conditional objects: `cond ? { ... }` and its `: { ... }`.
  const spans = [];
  for (const c of text.matchAll(/(!?)([A-Za-z_]\w*)\s*\?\s*\{/g)) {
    const open = c.index + c[0].length;
    const close = skipBalanced(text, open, '}', 'bicep');
    const cond = `${c[1]}${c[2]}`;
    spans.push({ from: open, to: close, when: cond });
    const other = /^\s*:\s*\{/.exec(text.slice(close));
    if (other) {
      const open2 = close + other[0].length;
      const negated = cond.startsWith('!') ? cond.slice(1) : `!${cond}`;
      spans.push({ from: open2, to: skipBalanced(text, open2, '}', 'bicep'), when: negated });
    }
  }

  const settings = [];
  const line = /^[ \t]*(?:'([^']+)'|([A-Za-z_]\w*))[ \t]*:[ \t]*(\S.*)$/gm;
  for (const s of text.matchAll(line)) {
    const span = spans.find((x) => s.index >= x.from && s.index < x.to);
    settings.push({
      name: s[1] ?? s[2],
      expr: stripLineComment(s[3]),
      ...(span ? { when: span.when } : {}),
    });
  }
  if (settings.length === 0) throw new CliError(`${where}: \`var ${variable}\` sets no settings`);
  return settings;
}

// ---------------------------------------------------------------------------
// Static check
// ---------------------------------------------------------------------------

const read = (repo, rel) => {
  const abs = join(repo, rel);
  if (!existsSync(abs)) throw new CliError(`${rel}: not found`);
  return readFileSync(abs, 'utf8');
};

/** Everything the check knows about one app: what the code reads, what Bicep sets. */
export function describeApp(repo, spec) {
  const configSource = read(repo, spec.config);
  const schemaName = schemaNameOf(configSource, spec.config);
  const defaults = schemaDefaults(read(repo, SCHEMA_FILE), schemaName);

  const reads = new Map(); // env -> { hasDefault, from }
  for (const { field, env } of parseEnvMap(configSource, spec.config)) {
    if (!defaults.has(field)) {
      throw new CliError(`${spec.config}: envMap field '${field}' is not in ${schemaName}`);
    }
    reads.set(env, { hasDefault: defaults.get(field), from: `${spec.config} (${field})` });
  }
  // A direct read has no schema, so no known default: it counts as required.
  for (const [env, file] of directEnvReads(repo, spec.sources)) {
    if (!reads.has(env)) reads.set(env, { hasDefault: false, from: `${file} (process.env)` });
  }

  const settings = new Map(); // name -> { expr, when, from }
  for (const { file, variable } of spec.bicep) {
    for (const s of bicepSettings(read(repo, file), variable, file)) {
      settings.set(s.name, { ...s, from: `${file}#${variable}` });
    }
  }
  return { ...spec, schemaName, reads, settings };
}

/** `{ errors: [...], warnings: [...] }`, each `{ app, setting, message }`. */
export function staticCheck(repo = REPO, apps = APPS) {
  const errors = [];
  const warnings = [];
  const described = apps.map((spec) => describeApp(repo, spec));
  for (const d of described) {
    for (const [env, r] of d.reads) {
      if (d.settings.has(env)) continue;
      if (r.hasDefault) {
        warnings.push({
          app: d.app,
          setting: env,
          message: 'not set by Bicep: the code default applies',
        });
      } else {
        errors.push({
          app: d.app,
          setting: env,
          message: `read by ${r.from} with no default, not set by Bicep: the app would not start`,
        });
      }
    }
    for (const [name, s] of d.settings) {
      if (name === ZIP_DEPLOY_SETTING) {
        errors.push({
          app: d.app,
          setting: name,
          message: `set in ${s.from}: the zip deploy owns it (functionApp.bicep carries it over)`,
        });
        continue;
      }
      if (!d.reads.has(name) && !PLATFORM_SETTINGS.has(name)) {
        errors.push({
          app: d.app,
          setting: name,
          message: `set in ${s.from}, read by no code of this app: remove it`,
        });
      }
      if (SECRET_NAME.test(name) && !s.expr.startsWith(`'${KV_PREFIX}`)) {
        errors.push({
          app: d.app,
          setting: name,
          message: `a secret, set in ${s.from} to something other than a Key Vault reference`,
        });
      }
    }
  }
  return { errors, warnings, apps: described };
}

// ---------------------------------------------------------------------------
// Live comparison
// ---------------------------------------------------------------------------

/** Parameter default expressions of a Bicep file: `Map(name -> expr | undefined)`. */
export function bicepParams(source) {
  const params = new Map();
  for (const m of source.matchAll(/^param\s+([A-Za-z_]\w*)\s+\w+(?:[ \t]*=[ \t]*(.+))?$/gm)) {
    params.set(m[1], m[2] === undefined ? undefined : stripLineComment(m[2]));
  }
  return params;
}

/**
 * Resolves template parameters to values: the parameters file first, then a
 * literal default, or a default that is another parameter. Anything else
 * (`tenant().tenantId`, a ternary) stays unknown.
 */
export function resolveParams(templateParams, fileParams) {
  const values = new Map();
  const resolving = new Set();
  const resolveOne = (name) => {
    if (values.has(name)) return values.get(name);
    let value;
    if (Object.hasOwn(fileParams, name)) value = fileParams[name];
    else if (!resolving.has(name) && templateParams.get(name) !== undefined) {
      resolving.add(name);
      value = literal(templateParams.get(name), (id) =>
        templateParams.has(id) ? resolveOne(id) : undefined,
      );
      resolving.delete(name);
    }
    values.set(name, value);
    return value;
  };
  for (const name of templateParams.keys()) resolveOne(name);
  return values;
}

/** A Bicep literal or a bare identifier, else undefined. */
function literal(expr, lookup) {
  const e = expr.trim();
  if (e === 'true') return true;
  if (e === 'false') return false;
  if (/^-?\d+$/.test(e)) return Number(e);
  if (/^[A-Za-z_]\w*$/.test(e)) return lookup(e);
  if (e.startsWith("'") && !e.startsWith("'''")) {
    const s = bicepString(e, lookup);
    return s;
  }
  return undefined;
}

/**
 * The value of a Bicep string literal whose interpolations are all bare
 * parameters with string values; undefined for anything else.
 */
function bicepString(e, lookup) {
  let end;
  try {
    end = skipString(e, 0, 'bicep');
  } catch {
    return undefined;
  }
  if (end !== e.length) return undefined;
  let out = '';
  for (let i = 1; i < e.length - 1; i++) {
    const c = e[i];
    if (c === '\\') {
      const n = e[++i];
      out += { n: '\n', r: '\r', t: '\t' }[n] ?? n;
    } else if (c === '$' && e[i + 1] === '{') {
      const close = skipBalanced(e, i + 2, '}', 'bicep');
      const inner = e.slice(i + 2, close - 1).trim();
      const v = /^[A-Za-z_]\w*$/.test(inner) ? lookup(inner) : undefined;
      if (typeof v !== 'string') return undefined;
      out += v;
      i = close - 1;
    } else out += c;
  }
  return out;
}

/**
 * What a deploy would write for one setting: `{ kind: 'value', value }` when
 * it follows from parameters and literals alone, `{ kind: 'keyVault', secret }`
 * for a Key Vault reference, else `{ kind: 'runtime' }` (a key, a connection
 * string, a hostname only the deployment knows).
 */
export function evaluate(expr, params) {
  const lookup = (id) => params.get(id);
  const e = expr.trim();
  if (e.startsWith(`'${KV_PREFIX}`)) {
    const m = /secrets\/([^/'$]+)\/?\)'$/.exec(e);
    return m ? { kind: 'keyVault', secret: m[1] } : { kind: 'runtime' };
  }
  const ternary = /^([A-Za-z_]\w*)\s*\?\s*('(?:[^'\\]|\\.)*')\s*:\s*('(?:[^'\\]|\\.)*')$/.exec(e);
  if (ternary) {
    const cond = lookup(ternary[1]);
    if (typeof cond !== 'boolean') return { kind: 'runtime' };
    const v = bicepString(cond ? ternary[2] : ternary[3], lookup);
    return v === undefined ? { kind: 'runtime' } : { kind: 'value', value: v };
  }
  const v = literal(e, lookup);
  return typeof v === 'string' ? { kind: 'value', value: v } : { kind: 'runtime' };
}

/** Runs `az`, returns parsed JSON. Injected in tests. */
export function runAz(args) {
  const out = execFileSync('az', [...args, '-o', 'json', '--only-show-errors'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(out);
}

const jmesString = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * A compared value, for a drift line. Both sides should be plain values from
 * the parameters file, but a running one that looks like a key, a SAS URL or
 * a connection string (pasted into the wrong setting) is not printed.
 */
function shown(value) {
  if (value === undefined) return '(unset)';
  const s = String(value);
  if (/AccountKey=|[?&]sig=|InstrumentationKey=|^[A-Za-z0-9+/]{40,}={0,2}$/.test(s)) {
    return '(not shown: looks like a secret)';
  }
  return JSON.stringify(s.length > 120 ? `${s.slice(0, 117)}...` : s);
}

/**
 * Compares what a deploy would write with one running app. `az` only ever
 * returns names, booleans, and the values of `readable` settings.
 */
export function compareApp({ app, functionApp, resourceGroup, intended, az }) {
  const findings = [];
  const notes = [];
  const base = [
    'functionapp',
    'config',
    'appsettings',
    'list',
    '-g',
    resourceGroup,
    '-n',
    functionApp,
  ];

  const running = new Map(
    az([...base, '--query', `[].{name:name, kv: starts_with(value, '${KV_PREFIX}')}`]).map((r) => [
      r.name,
      r.kv === true,
    ]),
  );

  for (const name of running.keys()) {
    if (name === ZIP_DEPLOY_SETTING || intended.has(name)) continue;
    findings.push({
      app,
      setting: name,
      message: 'running, not in Bicep: a deploy would delete it',
    });
  }
  if (running.has(ZIP_DEPLOY_SETTING)) {
    notes.push(`${ZIP_DEPLOY_SETTING}: running; a deploy writes it back unchanged`);
  } else {
    notes.push(`${ZIP_DEPLOY_SETTING}: not set; the next zip deploy sets it`);
  }

  const readable = [];
  const runtime = [];
  for (const [name, target] of intended) {
    if (!running.has(name)) {
      findings.push({
        app,
        setting: name,
        message: 'in Bicep, not running: a deploy would add it',
      });
      continue;
    }
    const isKv = running.get(name);
    if (target.kind === 'keyVault') {
      if (!isKv) {
        findings.push({
          app,
          setting: name,
          message: `Bicep sets a Key Vault reference (${target.secret}); the running value is not one`,
        });
        continue;
      }
      const sameSecret = az([
        ...base,
        '--query',
        `[?name==${jmesString(name)}] | [0].ends_with(value, ${jmesString(`secrets/${target.secret}/)`)})`,
      ]);
      if (sameSecret !== true) {
        findings.push({
          app,
          setting: name,
          message: `the running Key Vault reference is not to secret '${target.secret}/' (latest version)`,
        });
      }
    } else if (isKv) {
      findings.push({
        app,
        setting: name,
        message: 'running as a Key Vault reference; Bicep sets something else',
      });
    } else if (target.kind === 'value' && !NEVER_READ.has(name) && !SECRET_NAME.test(name)) {
      readable.push(name);
    } else {
      runtime.push(name);
    }
  }

  if (readable.length) {
    const list = readable.map(jmesString).join(', ');
    const values = new Map(
      az([...base, '--query', `[?contains([${list}], name)].{name:name, value:value}`]).map((r) => [
        r.name,
        r.value,
      ]),
    );
    for (const name of readable) {
      const want = intended.get(name).value;
      const got = values.get(name);
      if (got !== want) {
        findings.push({
          app,
          setting: name,
          message: `a deploy would change it: running ${shown(got)}, Bicep ${shown(want)}`,
        });
      }
    }
  }
  if (runtime.length) {
    notes.push(`not compared (only the deployment knows the value): ${runtime.sort().join(', ')}`);
  }
  return { findings, notes, compared: readable.length };
}

/** Live comparison of every app. `{ findings, report: [{ app, functionApp, notes, compared }] }`. */
export function liveCheck({ repo = REPO, apps, resourceGroup, parametersFile, az = runAz }) {
  const described = apps ?? APPS.map((spec) => describeApp(repo, spec));
  const fileParams = Object.fromEntries(
    Object.entries(
      JSON.parse(readFileSync(resolve(repo, parametersFile), 'utf8')).parameters ?? {},
    ).map(([k, v]) => [k, v?.value]),
  );
  const params = resolveParams(bicepParams(read(repo, MAIN_BICEP)), fileParams);
  const names = az(['functionapp', 'list', '-g', resourceGroup, '--query', '[].name']);

  const findings = [];
  const report = [];
  for (const d of described) {
    const matches = names.filter((n) => n.startsWith(d.functionAppPrefix));
    if (matches.length !== 1) {
      findings.push({
        app: d.app,
        setting: '-',
        message: `${matches.length} Function Apps named ${d.functionAppPrefix}* in ${resourceGroup}; expected exactly 1`,
      });
      continue;
    }
    const intended = new Map();
    for (const [name, s] of d.settings) {
      if (s.when) {
        const negate = s.when.startsWith('!');
        const cond = params.get(negate ? s.when.slice(1) : s.when);
        if (typeof cond === 'boolean' && cond === negate) continue;
      }
      intended.set(name, evaluate(s.expr, params));
    }
    const r = compareApp({ app: d.app, functionApp: matches[0], resourceGroup, intended, az });
    findings.push(...r.findings);
    report.push({ app: d.app, functionApp: matches[0], notes: r.notes, compared: r.compared });
  }
  return { findings, report };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage:
  node tools/check-app-settings.mjs
      Static: the settings the code reads vs the settings Bicep sets. Offline.
  node tools/check-app-settings.mjs --live -g <resource-group> -p <parameters.json>
      Also compares what a deploy would write with the running apps (read-only, az login).`;

const line = (level, f) => `  ${level}  ${f.app.padEnd(18)} ${f.setting.padEnd(38)} ${f.message}`;

export async function main(argv, { repo = REPO, az = runAz, log = console.log } = {}) {
  const { values, positionals } = parseCli(argv, {
    live: { type: 'boolean' },
    'resource-group': { type: 'string', short: 'g' },
    parameters: { type: 'string', short: 'p' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help) {
    log(USAGE);
    return 0;
  }
  if (positionals.length)
    throw new CliError(`unexpected argument '${positionals[0]}'\n${USAGE}`, 2);
  if (!values.live && (values['resource-group'] || values.parameters)) {
    throw new CliError(`-g and -p need --live\n${USAGE}`, 2);
  }
  if (values.live && !(values['resource-group'] && values.parameters)) {
    throw new CliError(`--live needs -g <resource-group> and -p <parameters.json>\n${USAGE}`, 2);
  }

  const { errors, warnings, apps } = staticCheck(repo);
  log(bold('App settings: the code vs Bicep'));
  for (const d of apps) {
    log(dim(`  ${d.app}: ${d.reads.size} read by the code, ${d.settings.size} set by Bicep`));
  }
  for (const w of warnings) log(line(warn('warn '), w));
  for (const e of errors) log(line(bad('error'), e));

  let findings = [];
  if (values.live) {
    log(bold(`\nApp settings: a deploy vs what runs in ${values['resource-group']}`));
    const live = liveCheck({
      repo,
      apps,
      resourceGroup: values['resource-group'],
      parametersFile: resolve(process.cwd(), values.parameters),
      az,
    });
    for (const r of live.report) {
      log(dim(`  ${r.app} (${r.functionApp}): ${r.compared} values compared`));
      for (const n of r.notes) log(dim(`    ${n}`));
    }
    findings = live.findings;
    for (const f of findings) log(line(bad('drift'), f));
  }

  const failed = errors.length + findings.length;
  log(
    failed
      ? bad(`\n✖ ${errors.length} error(s), ${findings.length} drift finding(s)`)
      : ok(
          `\n✔ no errors${values.live ? ', no drift' : ''}${warnings.length ? `, ${warnings.length} warning(s)` : ''}`,
        ),
  );
  return failed ? 1 : 0;
}

if (isMain(import.meta.url)) runMain(main);
