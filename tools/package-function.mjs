#!/usr/bin/env node
/**
 * Builds the deployable zip for one Function App: `teams-bot` or
 * `document-ingestion`. Run it through the package script:
 *
 *     corepack yarn workspace @bcr/<teams-bot|document-ingestion> package
 *
 * which first deletes `artifacts/<pkg>.zip`, then `dist/` and the tsbuildinfo
 * of the app and of the workspace packages it ships (`@bcr/shared`, and
 * `@bcr/ledger-db` for ingestion; `tsc -b` skips emitting when a tsbuildinfo
 * survives), rebuilds them with `tsc -b`, and only then runs this script.
 * Run the two package scripts one after the other, never in parallel: each
 * cleans `packages/shared/dist`.
 *
 * ## Why this is not a one-line `zip -r`
 *
 * The old `package` script was
 *
 *     zip -r ../../artifacts/<pkg>.zip dist host.json package.json node_modules
 *
 * run from the package directory. That went wrong three ways:
 *
 *  - Yarn 4 hoists dependencies to the workspace root, so the package's own
 *    `node_modules` does not exist on a fresh clone. `zip` matched nothing,
 *    warned, exited 0, and produced an archive with no dependencies.
 *  - `zip` UPDATES an existing archive in place and keeps entries whose files
 *    are gone. `artifacts/*.zip` used to be committed, so a Phase-0 build
 *    zipped over them kept July's `node_modules/@bcr/shared` next to the new
 *    `dist`. A `git checkout`, `git restore` or `git stash` also silently put
 *    the July builds back at the deploy path. The zips are now git-ignored
 *    build output that only this script writes.
 *  - `tsc -b` never deletes the output of a deleted source, so the removed
 *    `/api/user-target` handler (`dist/functions/userTarget.js`) kept shipping.
 *
 * A first replacement installed the dependencies with `npm install` from the
 * package.json ranges: not the versions in yarn.lock that the tests ran
 * against, and with every dependency's install scripts running on a machine
 * logged in to production.
 *
 * ## What this does
 *
 *   1. deletes `artifacts/<pkg>.zip` before anything else, and again on any
 *      failure, so a failed run leaves no archive at the path the deploy
 *      commands use
 *   2. checks the build: the app's `dist/`, and that of every workspace package
 *      it depends on (`@bcr/shared`, and `@bcr/ledger-db` for ingestion), hold
 *      exactly one `.js` per non-test `src/**\/*.ts` (an orphan or a missing
 *      file fails), `src/` holds nothing but `.ts`, and the Phase-0 markers
 *      are present
 *   3. stages `dist/**\/*.js` and `host.json` only: no source maps,
 *      declarations or tsbuildinfo
 *   4. installs the production dependencies from yarn.lock: a throwaway copy of
 *      the root manifest, yarn.lock, .yarnrc.yml and the workspace manifests,
 *      `yarn workspaces focus --production`, install scripts disabled,
 *      immutable lockfile, checksums enforced
 *   5. vendors those workspace packages from their fresh `dist` (`.js` only)
 *   6. verifies before zipping: every top-level dependency is the version
 *      yarn.lock pins AND the version installed in the root node_modules (what
 *      the tests ran against); every installed package is a yarn.lock
 *      resolution; no symlinks; every `require()` in the shipped code resolves
 *      inside the package, not in the monorepo around it
 *   7. zips, then re-reads the archive: Phase-0 markers in the vendored
 *      `@bcr/shared`, exactly the expected `.js` files, a root `host.json`
 *
 * Usage:  node tools/package-function.mjs <teams-bot|document-ingestion> [--keep-staging]
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What each app's build must contain to be the Phase-0 build. The strings are
 * fields that exist only in the Phase-0 code: an old `@bcr/shared` or an old
 * `dist` fails here rather than in production.
 */
export const APPS = {
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
/**
 * The `@bcr/*` workspace packages an app ships, vendored from their `dist`:
 * `@bcr/shared` always, plus every `workspace:` dependency in the app's
 * package.json (`@bcr/ledger-db` for ingestion), each with its own
 * `workspace:` dependencies, in a stable order. A workspace package is
 * `packages/<name without @bcr/>`.
 */
export function workspaceDependencies(appManifest, readManifest = () => ({})) {
  const found = new Set(['@bcr/shared']);
  const visit = (manifest) => {
    for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
      if (!dep.startsWith('@bcr/') || !String(range).startsWith('workspace:')) continue;
      if (found.has(dep)) continue;
      found.add(dep);
      visit(readManifest(dep));
    }
  };
  visit(appManifest);
  return [...found].sort();
}

/** `packages/<dir>` of a workspace package name. */
export function workspaceDir(name) {
  return name.replace(/^@bcr\//, '');
}

/**
 * What the vendored `@bcr/shared` must contain, for both apps: the Phase-0
 * config, `searchMode` (the client search release), without which a bot
 * or an ingestion built against an older `@bcr/shared` would ignore
 * `SEARCH_MODE`, and `clientAccountVerdict` (the client account rule of
 * 28 Sep 2026), without which an ingestion would be built against a
 * `@bcr/shared` that knows no refusal and no `{NIP}@` account.
 */
export const SHARED_MARKERS = [
  ['config.js', 'botGateMode'],
  ['config.js', 'forbiddenTargetSitePaths'],
  ['config.js', 'searchMode'],
  ['clientAccount.js', 'clientAccountVerdict'],
];

/** Below this the archive cannot hold the dependencies. */
const MIN_ZIP_BYTES = 2 * 1024 * 1024;

export class PackageError extends Error {}

function fail(message) {
  throw new PackageError(message);
}

// --- pure helpers (exported for tools/test/package-function.test.mjs) -------

/** Every file under `dir`, as '/'-separated paths relative to it, sorted. */
export function listFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(abs, entry.name), childRel);
      else out.push(childRel);
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out.sort();
}

/**
 * The `.js` files `tsc` emits for a package: one per `src/**\/*.ts`, minus the
 * declarations and the `*.test.ts` files its tsconfig excludes.
 */
export function expectedJs(srcDir) {
  return listFiles(srcDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.endsWith('.test.ts'))
    .map((f) => f.replace(/\.ts$/, '.js'))
    .sort();
}

/**
 * Compares a `dist/` with its `src/`.
 *  - orphans: a `.js` with no source (the output of a deleted file, which
 *    `tsc -b` never removes)
 *  - missing: a source with no `.js` (an incomplete build)
 *  - unshipped: a `src/` file that is not TypeScript (e.g. an imported JSON
 *    that tsc would copy): only `.js` is shipped, so it would silently be left
 *    out of the archive
 */
export function compareDistToSrc(distDir, srcDir) {
  const expected = expectedJs(srcDir);
  const expectedSet = new Set(expected);
  const actual = listFiles(distDir).filter((f) => f.endsWith('.js'));
  const actualSet = new Set(actual);
  return {
    expected,
    orphans: actual.filter((f) => !expectedSet.has(f)),
    missing: expected.filter((f) => !actualSet.has(f)),
    unshipped: listFiles(srcDir).filter((f) => !f.endsWith('.ts')),
  };
}

/** What of a `dist/` goes into the archive: compiled JavaScript, nothing else. */
export function isShippedDistFile(path) {
  return path.endsWith('.js');
}

/**
 * Reads yarn.lock (v8, Yarn 4). Returns `versions`: descriptor
 * (`jose@npm:^5.8.0`) → locked version, and `resolved`: the `name@version` of
 * every package the lockfile resolves outside the workspace, patched ones
 * included.
 */
export function parseYarnLock(text) {
  const versions = new Map();
  const resolved = new Set();
  for (const block of text.split(/\r?\n\s*\r?\n/)) {
    const head = block.split(/\r?\n/).find((line) => /^[^\s#].*:$/.test(line));
    if (!head || head.startsWith('__metadata')) continue;
    const version = /^ {2}version: "?([^"\s]+)"?\s*$/m.exec(block)?.[1];
    const resolution = /^ {2}resolution: "([^"]+)"\s*$/m.exec(block)?.[1];
    if (!version || !resolution) continue;
    for (const descriptor of head.slice(0, -1).split(/,\s*/)) {
      versions.set(descriptor.replace(/^"|"$/g, ''), version);
    }
    if (resolution.includes('@workspace:')) continue;
    const name = /^(@[^/@]+\/[^@]+|[^@]+)@/.exec(resolution)?.[1];
    if (name) resolved.add(`${name}@${version}`);
  }
  return { versions, resolved };
}

/** The yarn.lock descriptor for a manifest dependency (`jose`, `^5.8.0`). */
export function descriptorFor(dep, range) {
  return /^[a-z]+:/.test(range) ? `${dep}@${range}` : `${dep}@npm:${range}`;
}

/** The `version` of the package installed at `dir`, or undefined. */
export function versionAt(dir) {
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) return undefined;
  return JSON.parse(readFileSync(manifest, 'utf8')).version;
}

/**
 * Every package installed under a `node_modules`, nested ones included, with
 * the name and version from its own package.json. Dot-entries (`.bin`,
 * `.yarn-state.yml`) are not packages and are skipped here.
 */
export function listInstalled(nodeModules) {
  const out = [];
  const visitPackage = (abs) => {
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) {
      out.push({ path: abs, problem: 'symlink' });
      return;
    }
    if (!stat.isDirectory()) {
      out.push({ path: abs, problem: 'not a package directory' });
      return;
    }
    const manifest = join(abs, 'package.json');
    const json = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : {};
    if (!json.name || !json.version) {
      out.push({ path: abs, problem: 'no package.json name/version' });
    } else {
      out.push({ path: abs, name: json.name, version: json.version });
    }
    visitDir(join(abs, 'node_modules'));
  };
  const visitDir = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = join(dir, entry.name);
      if (entry.name.startsWith('@') && entry.isDirectory()) {
        for (const scoped of readdirSync(abs)) visitPackage(join(abs, scoped));
      } else {
        visitPackage(abs);
      }
    }
  };
  visitDir(nodeModules);
  return out;
}

/** Every symlink under `dir`. */
export function findSymlinks(dir) {
  const out = [];
  const walk = (abs) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = join(abs, entry.name);
      if (entry.isSymbolicLink()) out.push(child);
      else if (entry.isDirectory()) walk(child);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/**
 * Every bare `require("x")` in the given compiled files that does not resolve
 * to a file inside `packageRoot`. Node resolution walks up past the package
 * into the monorepo's own node_modules, so "it resolves" is not enough: it has
 * to resolve to something the archive carries. Relative requires are checked
 * the same way. Built-in modules are skipped.
 */
export function findUnresolvedRequires(packageRoot, files) {
  const rootReal = realpathSync(packageRoot);
  const inside = (p) => p === rootReal || p.startsWith(rootReal + sep);
  const out = [];
  for (const file of files) {
    const abs = join(packageRoot, file);
    const code = readFileSync(abs, 'utf8');
    const req = createRequire(abs);
    for (const match of code.matchAll(/\brequire\(\s*(["'])([^"']+)\1\s*\)/g)) {
      const spec = match[2];
      if (spec.startsWith('node:') || builtinModules.includes(spec)) continue;
      let resolved;
      try {
        resolved = realpathSync(req.resolve(spec));
      } catch {
        out.push({ file, spec, problem: 'does not resolve' });
        continue;
      }
      if (!inside(resolved)) out.push({ file, spec, problem: `resolves outside: ${resolved}` });
    }
  }
  return out;
}

/**
 * Removes what a node-modules install adds that the runtime does not need:
 * `.bin` shims (symlinks) and Yarn's `.yarn-state.yml`, at every level.
 */
function pruneInstallMetadata(nodeModules) {
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const isMetadata = entry.name === '.bin' || entry.name === '.yarn-state.yml';
      if (basename(dir) === 'node_modules' && isMetadata) {
        rmSync(abs, { recursive: true, force: true });
      } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(abs);
      }
    }
  };
  if (existsSync(nodeModules)) walk(nodeModules);
}

/**
 * One row per top-level dependency: `{ dep, lock, tested, zipped }` where
 * `lock` is the version yarn.lock pins for the declared range, `tested` the
 * version in the root node_modules and `zipped` the version in the package.
 * A row is ok only when all three are the same version. Rows for the same
 * dependency and version (declared by both the app and @bcr/shared) merge; a
 * dependency locked at two versions is not ok, since the package has room for
 * one at its top level.
 */
export function checkDependencyVersions(candidates) {
  const byKey = new Map();
  for (const c of candidates) {
    const key = `${c.dep}@${c.lock}`;
    if (!byKey.has(key)) byKey.set(key, { ...c });
  }
  const rows = [...byKey.values()];
  const seen = new Map();
  for (const r of rows) seen.set(r.dep, (seen.get(r.dep) ?? 0) + 1);
  for (const r of rows) {
    r.ok = Boolean(r.lock) && r.lock === r.tested && r.tested === r.zipped && seen.get(r.dep) === 1;
  }
  return rows.sort((a, b) => a.dep.localeCompare(b.dep) || String(a.lock).localeCompare(b.lock));
}

export function formatTable(rows) {
  const header = ['dependency', 'yarn.lock', 'root node_modules', 'zip', ''];
  const cells = [
    header,
    ...rows.map((r) => [
      r.dep,
      r.lock ?? '—',
      r.tested ?? '—',
      r.zipped ?? '—',
      r.ok ? 'ok' : 'MISMATCH',
    ]),
  ];
  const widths = header.map((_, i) => Math.max(...cells.map((c) => c[i].length)));
  return cells
    .map((c) => `    ${c.map((v, i) => v.padEnd(widths[i])).join('  ')}`.trimEnd())
    .join('\n');
}

// --- the packaging run ---------------------------------------------------------

/**
 * Packages one app. Throws PackageError on any failed check; the zip is
 * deleted first and again on failure, so a failed run never leaves one.
 */
export function packageFunction({ root, name, keepStaging = false, log = console.log }) {
  if (!name || !Object.hasOwn(APPS, name)) {
    fail(
      `usage: node tools/package-function.mjs <${Object.keys(APPS).join('|')}> [--keep-staging]`,
    );
  }
  const ARTIFACTS = join(root, 'artifacts');
  const ZIP = join(ARTIFACTS, `${name}.zip`);

  // --- 1. no archive at the deploy path until this run has produced one ------
  rmSync(ZIP, { force: true });
  try {
    return build({ root, name, keepStaging, log, ARTIFACTS, ZIP });
  } catch (err) {
    rmSync(ZIP, { force: true });
    throw err;
  }
}

function build({ root, name, keepStaging, log, ARTIFACTS, ZIP }) {
  const APP = join(root, 'packages', name);
  const SHARED = join(root, 'packages/shared');
  const appManifest = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'));
  const readManifest = (dep) => {
    const file = join(root, 'packages', workspaceDir(dep), 'package.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  };
  // @bcr/shared and the app's other workspace dependencies, vendored below.
  const WORKSPACE = workspaceDependencies(appManifest, readManifest).map((dep) => ({
    name: dep,
    dir: join(root, 'packages', workspaceDir(dep)),
  }));
  const STAGING = join(ARTIFACTS, `staging-${name}`);
  const YARN_DIR = join(ARTIFACTS, `staging-${name}-yarn`);
  const rebuild = `Run: corepack yarn workspace @bcr/${name} package`;

  const assertContains = (file, needle, label) => {
    if (!existsSync(file)) fail(`${label}: ${file} is missing. ${rebuild}`);
    if (!readFileSync(file, 'utf8').includes(needle)) {
      fail(`${label}: ${file} does not contain "${needle}" — this is not the Phase-0 build.`);
    }
  };

  // --- 2. the build is complete, has no orphans, and is the Phase-0 build ------
  if (!existsSync(join(APP, 'dist/index.js'))) {
    fail(`packages/${name}/dist/index.js is missing. ${rebuild}`);
  }
  const expected = {};
  for (const [label, dir] of [[`@bcr/${name}`, APP], ...WORKSPACE.map((w) => [w.name, w.dir])]) {
    const {
      expected: js,
      orphans,
      missing,
      unshipped,
    } = compareDistToSrc(join(dir, 'dist'), join(dir, 'src'));
    if (orphans.length > 0) {
      fail(
        `${label}: dist/ has JavaScript with no source in src/ (output of deleted files):\n` +
          orphans.map((f) => `    dist/${f}`).join('\n') +
          `\n  The package script deletes dist/ before building. ${rebuild}`,
      );
    }
    if (missing.length > 0) {
      const sources = missing.map((f) => `src/${f.replace(/\.js$/, '.ts')}`).join(', ');
      fail(`${label}: dist/ lacks the output of ${sources}. ${rebuild}`);
    }
    if (unshipped.length > 0) {
      fail(
        `${label}: src/ has files that are not TypeScript, which this script would not ship:` +
          ` ${unshipped.map((f) => `src/${f}`).join(', ')}. Ship them explicitly or move them out.`,
      );
    }
    expected[label] = js;
  }
  for (const [file, needle] of APPS[name].distMarkers) {
    assertContains(join(APP, 'dist', file), needle, `@bcr/${name}`);
  }
  for (const [file, needle] of SHARED_MARKERS) {
    assertContains(join(SHARED, 'dist', file), needle, '@bcr/shared');
  }

  log(`Packaging @bcr/${name}`);

  // --- 3. clean staging: compiled JavaScript and host.json -------------------
  rmSync(STAGING, { recursive: true, force: true });
  rmSync(YARN_DIR, { recursive: true, force: true });
  mkdirSync(STAGING, { recursive: true });
  const jsOnly = (src) => statSync(src).isDirectory() || isShippedDistFile(src);
  cpSync(join(APP, 'dist'), join(STAGING, 'dist'), { recursive: true, filter: jsOnly });
  cpSync(join(APP, 'host.json'), join(STAGING, 'host.json'));

  // --- 4. production dependencies, exactly as yarn.lock pins them ---------------
  // A throwaway Yarn project: the root manifest, yarn.lock, .yarnrc.yml and every
  // workspace manifest (the lockfile names all of them). `workspaces focus
  // --production` installs only this app's and @bcr/shared's dependencies.
  mkdirSync(YARN_DIR, { recursive: true });
  for (const file of ['package.json', 'yarn.lock', '.yarnrc.yml']) {
    cpSync(join(root, file), join(YARN_DIR, file));
  }
  for (const pkg of readdirSync(join(root, 'packages'))) {
    const manifest = join(root, 'packages', pkg, 'package.json');
    if (!existsSync(manifest)) continue;
    mkdirSync(join(YARN_DIR, 'packages', pkg), { recursive: true });
    cpSync(manifest, join(YARN_DIR, 'packages', pkg, 'package.json'));
  }
  log('  installing production dependencies from yarn.lock (install scripts disabled)');
  try {
    execFileSync('corepack', ['yarn', 'workspaces', 'focus', '--production', `@bcr/${name}`], {
      cwd: YARN_DIR,
      env: {
        ...process.env,
        COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
        YARN_ENABLE_SCRIPTS: 'false',
        YARN_ENABLE_IMMUTABLE_INSTALLS: 'true',
        YARN_CHECKSUM_BEHAVIOR: 'throw',
        YARN_NODE_LINKER: 'node-modules',
        YARN_NM_MODE: 'classic',
        YARN_ENABLE_TELEMETRY: 'false',
        YARN_ENABLE_PROGRESS_BARS: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    fail(
      `yarn workspaces focus failed in ${YARN_DIR}:\n${err.stdout ?? ''}${err.stderr ?? err.message}`,
    );
  }
  if (!readFileSync(join(YARN_DIR, 'yarn.lock')).equals(readFileSync(join(root, 'yarn.lock')))) {
    fail(
      'the production install changed yarn.lock: package.json and yarn.lock are out of sync.' +
        ' Run: corepack yarn install',
    );
  }
  // Everything must be hoisted to the one node_modules the archive ships. A
  // version conflict nests a copy under packages/<pkg>/node_modules, which the
  // archive has no place for.
  for (const pkg of readdirSync(join(YARN_DIR, 'packages'))) {
    const nested = join(YARN_DIR, 'packages', pkg, 'node_modules');
    const entries = existsSync(nested) ? readdirSync(nested).filter((e) => !e.startsWith('.')) : [];
    if (entries.length > 0) {
      fail(
        `@bcr/${pkg} needs its own copy of ${entries.join(', ')} (a version conflict with another` +
          ' dependency). Align the versions in package.json so the install hoists them.',
      );
    }
  }
  const yarnModules = join(YARN_DIR, 'node_modules');
  // The workspace links (@bcr/shared, @bcr/<app>) point into the throwaway
  // project; @bcr/shared is vendored below instead.
  rmSync(join(yarnModules, '@bcr'), { recursive: true, force: true });
  pruneInstallMetadata(yarnModules);
  const links = findSymlinks(yarnModules);
  if (links.length > 0) {
    fail(
      `the installed tree has symlinks, which zip would follow:\n` +
        links.map((l) => `    ${l}`).join('\n'),
    );
  }
  renameSync(yarnModules, join(STAGING, 'node_modules'));

  // --- 5. vendor the workspace packages from their fresh builds -------------------
  const vendoredPaths = new Set();
  for (const w of WORKSPACE) {
    const manifest = JSON.parse(readFileSync(join(w.dir, 'package.json'), 'utf8'));
    const target = join(STAGING, 'node_modules', w.name);
    vendoredPaths.add(target);
    mkdirSync(target, { recursive: true });
    cpSync(join(w.dir, 'dist'), join(target, 'dist'), { recursive: true, filter: jsOnly });
    writeFileSync(
      join(target, 'package.json'),
      `${JSON.stringify(
        {
          name: manifest.name,
          version: manifest.version,
          private: true,
          main: 'dist/index.js',
          dependencies: manifest.dependencies ?? {},
        },
        null,
        2,
      )}\n`,
    );
  }
  const vendored = join(STAGING, 'node_modules/@bcr/shared');

  // --- 6. verify before zipping ---------------------------------------------------
  const lock = parseYarnLock(readFileSync(join(root, 'yarn.lock'), 'utf8'));
  const appPkg = appManifest;
  const wanted = new Map();
  for (const [deps, workspace] of [
    [appPkg.dependencies ?? {}, APP],
    ...WORKSPACE.map((w) => [readManifest(w.name).dependencies ?? {}, w.dir]),
  ]) {
    for (const [dep, range] of Object.entries(deps)) {
      if (String(range).startsWith('workspace:')) continue;
      const key = `${dep}@${range}`;
      if (!wanted.has(key)) wanted.set(key, { dep, range, workspace });
    }
  }
  const rows = checkDependencyVersions(
    [...wanted.values()].map(({ dep, range, workspace }) => ({
      dep,
      lock: lock.versions.get(descriptorFor(dep, range)),
      // What the tests ran against: node resolution from the workspace directory.
      tested:
        versionAt(join(workspace, 'node_modules', dep)) ??
        versionAt(join(root, 'node_modules', dep)),
      zipped: versionAt(join(STAGING, 'node_modules', dep)),
    })),
  );
  log(formatTable(rows));
  const mismatched = rows.filter((r) => !r.ok);
  if (mismatched.length > 0) {
    fail(
      `top-level dependency versions differ between yarn.lock, the root node_modules and the` +
        ` package: ${[...new Set(mismatched.map((r) => r.dep))].join(', ')}.` +
        ` Run: corepack yarn install --immutable`,
    );
  }
  const installed = listInstalled(join(STAGING, 'node_modules')).filter(
    (p) => !vendoredPaths.has(p.path),
  );
  const strangers = installed.filter(
    (p) => p.problem || !lock.resolved.has(`${p.name}@${p.version}`),
  );
  if (strangers.length > 0) {
    fail(
      `installed packages that yarn.lock does not resolve:\n` +
        strangers
          .slice(0, 20)
          .map((p) => `    ${p.problem ? `${p.path}: ${p.problem}` : `${p.name}@${p.version}`}`)
          .join('\n'),
    );
  }
  log(`  ${installed.length} installed packages, every one a yarn.lock resolution`);
  for (const [file, needle] of SHARED_MARKERS) {
    assertContains(join(vendored, 'dist', file), needle, 'vendored @bcr/shared');
  }
  const shippedCode = [
    ...expected[`@bcr/${name}`].map((f) => `dist/${f}`),
    ...WORKSPACE.flatMap((w) => expected[w.name].map((f) => `node_modules/${w.name}/dist/${f}`)),
  ];
  const unresolved = findUnresolvedRequires(STAGING, shippedCode);
  if (unresolved.length > 0) {
    fail(
      `the shipped code requires modules the package does not contain:\n` +
        unresolved.map((u) => `    ${u.file}: require("${u.spec}") ${u.problem}`).join('\n') +
        `\n  Declare them in the package.json of the app or of the workspace package that` +
        ' requires them.',
    );
  }

  // The archive's package.json: exact versions, so even a remote build could not
  // resolve anything else at the top level.
  writeFileSync(
    join(STAGING, 'package.json'),
    `${JSON.stringify(
      {
        name: appPkg.name,
        version: appPkg.version,
        private: true,
        main: 'dist/index.js',
        dependencies: Object.fromEntries(rows.map((r) => [r.dep, r.zipped])),
      },
      null,
      2,
    )}\n`,
  );

  // --- 7. a NEW archive, then read it back -----------------------------------------
  mkdirSync(ARTIFACTS, { recursive: true });
  rmSync(ZIP, { force: true });
  try {
    execFileSync('zip', ['-r', '-q', '-X', ZIP, '.'], {
      cwd: STAGING,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
  const entries = execFileSync('unzip', ['-Z1', ZIP], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
    .split('\n')
    .filter((e) => e && !e.endsWith('/'));
  const under = (prefix) =>
    entries.filter((e) => e.startsWith(prefix)).map((e) => e.slice(prefix.length));
  for (const [label, prefix] of [
    [`@bcr/${name}`, 'dist/'],
    ...WORKSPACE.map((w) => [w.name, `node_modules/${w.name}/dist/`]),
  ]) {
    const got = under(prefix).sort();
    if (JSON.stringify(got) !== JSON.stringify(expected[label])) {
      const extra = got.filter((f) => !expected[label].includes(f));
      fail(
        `the archive's ${prefix} is not exactly the compiled src of ${label}:` +
          ` has ${got.length} files, expected ${expected[label].length}` +
          ` (extra: ${extra.join(', ') || 'none'})`,
      );
    }
  }
  for (const required of ['host.json', 'package.json', 'dist/index.js']) {
    if (!entries.includes(required)) fail(`the archive has no ${required} at its root`);
  }

  const bytes = statSync(ZIP).size;
  log(`  ${(bytes / 1024 / 1024).toFixed(1)} MB, ${entries.length} files`);
  log(`  ${ZIP}`);
  if (bytes < MIN_ZIP_BYTES) {
    fail(
      `the archive is only ${(bytes / 1024).toFixed(0)} KB — too small to contain the dependencies.`,
    );
  }

  if (!keepStaging) {
    rmSync(STAGING, { recursive: true, force: true });
    rmSync(YARN_DIR, { recursive: true, force: true });
  }
  log('✓ Package ready (lockfile versions and Phase-0 @bcr/shared verified inside the archive).');
  return { zip: ZIP, bytes, files: entries.length, dependencies: rows };
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const args = process.argv.slice(2);
  try {
    packageFunction({
      root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
      name: args.find((a) => !a.startsWith('--')),
      keepStaging: args.includes('--keep-staging'),
    });
  } catch (err) {
    console.error(`\n✖ ${err instanceof PackageError ? err.message : err.stack}`);
    process.exit(1);
  }
}
