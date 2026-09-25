/**
 * The site-path edge cases of contract C1. The ingestion's
 * `canonicalSitePath` (clientDirectoryReader.test.ts) holds the same table:
 * a path is canonical on one side exactly when it is on the other. Change
 * both together, never one.
 *
 * Each case is `[input, canonical form or null]`. The canonical form is
 * compared lower-case everywhere.
 */
export const SITE_PATH_CASES = Object.freeze([
  ['/sites/A', '/sites/a'],
  ['/sites/A/', '/sites/a'],
  ['sites/A', '/sites/a'],
  ['//sites//A', '/sites/a'],
  [' /teams/A ', '/teams/a'],
  ['/sites/A/x', null],
  ['/sites/A.', null],
  ['/sites/%41', null],
  ['/sites/x\\..\\Q', null],
  ['/sites/ A', null],
  ['/sites/./A', null],
  ['/sites/x/../A', null],
  ['/sites', null],
  ['/A/B', null],
  ['/sites/0002PESKOVOISp.zo.o.-Ksigowo', '/sites/0002peskovoisp.zo.o.-ksigowo'],
  ['/sites/BCRGROUPSp.zo.o', '/sites/bcrgroupsp.zo.o'],
]);
