import { canonicalSitePath } from './sitePath';

/**
 * The shared edge-case table (contract C1). `tools/test/bindings.test.mjs`
 * runs the same spellings through the tool's canonicaliser, so the tool and
 * ingestion can never disagree about which rows name a site.
 */
const CANONICAL: [string, string][] = [
  ['/sites/A', '/sites/A'],
  ['/sites/A/', '/sites/A'],
  ['sites/A', '/sites/A'],
  ['//sites//A', '/sites/A'],
  [' /teams/A ', '/teams/A'],
  ['/sites/0002PESKOVOISp.zo.o.-Ksigowo', '/sites/0002PESKOVOISp.zo.o.-Ksigowo'],
  ['/sites/BCRGROUPSp.zo.o', '/sites/BCRGROUPSp.zo.o'],
];

const NOT_CANONICAL: string[] = [
  '/sites/A/x',
  '/sites/A.',
  '/sites/%41',
  '/sites/x\\..\\Q',
  '/sites/ A',
  '/sites/./A',
  '/sites/x/../A',
  '/sites',
  '/A/B',
];

describe('canonicalSitePath', () => {
  it.each(CANONICAL)('canonicalises %j to %j', (input, expected) => {
    expect(canonicalSitePath(input)).toBe(expected);
  });

  it.each(NOT_CANONICAL)('refuses %j', (input) => {
    expect(canonicalSitePath(input)).toBeNull();
  });

  it.each([
    ['a zero-width space inside the name', '/sites/A​B'],
    ['a tab inside the name', '/sites/A\tB'],
    ['a name that starts with a dot', '/sites/.A'],
    ['a name ending in several dots', '/sites/A..'],
    ['a personal site', '/personal/someone'],
    ['the root', '/'],
    ['an empty string', ''],
    ['a URL', 'https://contoso.sharepoint.com/sites/A'],
  ])('refuses %s', (_label, input) => {
    expect(canonicalSitePath(input)).toBeNull();
  });

  it('keeps the case of the name and of the kind (comparisons lower-case it)', () => {
    expect(canonicalSitePath('/SITES/ClientA/')).toBe('/SITES/ClientA');
  });
});
