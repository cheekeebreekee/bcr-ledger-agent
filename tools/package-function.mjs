#!/usr/bin/env node
/**
 * Builds the deployable zip for one Function App: `teams-bot` or
 * `document-ingestion`. Ported from bcr-onboarding-agent/tools/package-function.mjs.
 *
 * ## Why this is not a one-line `zip -r`
 *
 * The old `package` script was
 *
 *     zip -r ../../artifacts/<pkg>.zip dist host.json package.json node_modules
 *
 * run from the package directory. Two things made that dangerous:
 *
 *  - Yarn 4 hoists dependencies to the workspace root, so the package's own
 *    `node_modules` does not exist on a fresh clone. `zip` matched nothing,
 *    warned, exited 0, and produced an archive with no dependencies.
 *  - `zip` UPDATES an existing archive in place and keeps entries whose files
 *    are gone. `artifacts/*.zip` are committed, so a Phase-0 build zipped over
 *    them kept July's `node_modules/@bcr/shared` next to the new `dist`: the
 *    bot silently ignored BOT_GATE_MODE (so the planned 24 h log window never
 *    happened) and ingestion threw at cold start on the old config schema.
 *
 * ## What this does instead
 *
 *   1. checks the build happened, and that it is the Phase-0 build
 *   2. a clean staging directory, never an incremental one
 *   3. `dist/` and `host.json` copied in
 *   4. a synthesised `package.json`: the app's dependencies minus
 *      `@bcr/shared`, plus everything `@bcr/shared` itself needs
 *   5. `npm install --omit=dev` there, which makes the tree real
 *   6. `@bcr/shared` vendored from its freshly built `dist`
 *   7. verified: every dependency present, and the vendored shared carries the
 *      Phase-0 config — or this fails loudly instead of shipping
 *   8. the old archive deleted, then a new one zipped with host.json at the root
 *
 * Usage:  node tools/package-function.mjs <teams-bot|document-ingestion> [--keep-staging]
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = join(ROOT, 'packages/shared');
const ARTIFACTS = join(ROOT, 'artifacts');

/**
 * What each app's build must contain to be the Phase-0 build. The strings are
 * fields that exist only in the Phase-0 code: an old `@bcr/shared` or an old
 * `dist` fails here rather than in production.
 */
const APPS = {
  'teams-bot': {
    distMarkers: [['bot/gateMiddleware.js', 'bot.gate.rejected']],
  },
  'document-ingestion': {
    distMarkers: [
      ['functions/health.js', 'identity-only'],
      ['services/batchIngestor.js', 'document.quarantined'],
    ],
  },
};
const SHARED_MARKERS = [['config.js', 'botGateMode'], ['config.js', 'forbiddenTargetSitePaths']];

const args = process.argv.slice(2);
const KEEP = args.includes('--keep-staging');
const name = args.find((a) => !a.startsWith('--'));

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

if (!name || !(name in APPS)) {
  fail(`usage: node tools/package-function.mjs <${Object.keys(APPS).join('|')}> [--keep-staging]`);
}

const APP = join(ROOT, 'packages', name);
const STAGING = join(ARTIFACTS, `staging-${name}`);
const ZIP = join(ARTIFACTS, `${name}.zip`);

function run(command, commandArgs, cwd) {
  execFileSync(command, commandArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

function assertContains(file, needle, label) {
  if (!existsSync(file)) fail(`${label}: ${file} is missing. Run: corepack yarn build`);
  if (!readFileSync(file, 'utf8').includes(needle)) {
    fail(`${label}: ${file} does not contain "${needle}" — this is not the Phase-0 build. Run: corepack yarn build`);
  }
}

const appPkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'));
const sharedPkg = JSON.parse(readFileSync(join(SHARED, 'package.json'), 'utf8'));

// --- 1. the build happened, and it is the Phase-0 build ---------------------
if (!existsSync(join(APP, 'dist/index.js'))) {
  fail(`packages/${name}/dist/index.js is missing. Run: corepack yarn build`);
}
for (const [file, needle] of APPS[name].distMarkers) {
  assertContains(join(APP, 'dist', file), needle, `@bcr/${name}`);
}
for (const [file, needle] of SHARED_MARKERS) {
  assertContains(join(SHARED, 'dist', file), needle, '@bcr/shared');
}

console.log(`Packaging @bcr/${name}`);

// --- 2. clean staging ---------------------------------------------------------
rmSync(STAGING, { recursive: true, force: true });
mkdirSync(STAGING, { recursive: true });
cpSync(join(APP, 'dist'), join(STAGING, 'dist'), { recursive: true });
cpSync(join(APP, 'host.json'), join(STAGING, 'host.json'));

// --- 3. a manifest npm can resolve ------------------------------------------
// `workspace:*` means nothing outside the monorepo, so @bcr/shared comes out and
// is vendored below. Its own dependencies stay in.
const dependencies = { ...appPkg.dependencies };
delete dependencies['@bcr/shared'];
for (const [dep, range] of Object.entries(sharedPkg.dependencies ?? {})) {
  dependencies[dep] ??= range;
}
writeFileSync(
  join(STAGING, 'package.json'),
  `${JSON.stringify(
    {
      name: appPkg.name,
      version: appPkg.version,
      private: true,
      main: 'dist/index.js',
      dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))),
    },
    null,
    2,
  )}\n`,
);

// --- 4. install for real ------------------------------------------------------
console.log(`  installing ${Object.keys(dependencies).length} production dependencies`);
try {
  run('npm', ['install', '--omit=dev', '--no-package-lock', '--no-audit', '--no-fund', '--loglevel=error'], STAGING);
} catch (err) {
  fail(`npm install failed in the staging directory:\n${err.stderr?.toString() ?? err.message}`);
}

// --- 5. vendor @bcr/shared from its fresh build -------------------------------
const vendored = join(STAGING, 'node_modules/@bcr/shared');
mkdirSync(vendored, { recursive: true });
cpSync(join(SHARED, 'dist'), join(vendored, 'dist'), { recursive: true });
writeFileSync(
  join(vendored, 'package.json'),
  `${JSON.stringify(
    {
      name: sharedPkg.name,
      version: sharedPkg.version,
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
      dependencies: sharedPkg.dependencies ?? {},
    },
    null,
    2,
  )}\n`,
);

// --- 6. verify before zipping ---------------------------------------------------
const missing = [...Object.keys(dependencies), '@bcr/shared'].filter(
  (dep) => !existsSync(join(STAGING, 'node_modules', dep)),
);
if (missing.length > 0) fail(`These dependencies are not in the package: ${missing.join(', ')}`);
for (const [file, needle] of SHARED_MARKERS) {
  assertContains(join(vendored, 'dist', file), needle, 'vendored @bcr/shared');
}

// --- 7. a NEW archive — never an update of the committed one -------------------
rmSync(ZIP, { force: true });
mkdirSync(ARTIFACTS, { recursive: true });
try {
  run('zip', ['-r', '-q', '-X', ZIP, '.'], STAGING);
} catch (err) {
  fail(`zip failed: ${err.stderr?.toString() ?? err.message}`);
}

// Read the vendored config back out of the archive itself: the check that
// would have caught the July copy.
for (const [file, needle] of SHARED_MARKERS) {
  const inZip = execFileSync('unzip', ['-p', ZIP, `node_modules/@bcr/shared/dist/${file}`], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!inZip.includes(needle)) fail(`the archive's @bcr/shared/dist/${file} lacks "${needle}"`);
}

const bytes = statSync(ZIP).size;
const listing = execFileSync('unzip', ['-l', ZIP], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
const entries = /(\d+)\s+files?\s*$/.exec(listing.trim())?.[1] ?? '?';
console.log(`  ${(bytes / 1024 / 1024).toFixed(1)} MB, ${entries} entries`);
console.log(`  ${ZIP}`);
if (bytes < 2 * 1024 * 1024) {
  fail(`the archive is only ${(bytes / 1024).toFixed(0)} KB — too small to contain the dependencies.`);
}

if (!KEEP) rmSync(STAGING, { recursive: true, force: true });
console.log('✓ Package ready (Phase-0 @bcr/shared verified inside the archive).');
