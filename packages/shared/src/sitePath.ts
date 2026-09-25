/**
 * The one canonical spelling of a SharePoint site-collection path, or `null`
 * when the path cannot be trusted to name exactly one site.
 *
 * A client target, the quarantine and every forbidden site are site
 * collections: `/sites/<name>` or `/teams/<name>`, nothing deeper. Graph and
 * the HTTP layer drop empty segments and resolve `.`/`..`, and a sub-path can
 * address a subweb of someone else's site, so a check that compared spellings
 * let rows through to BCR GROUP or into another client's collection. Only
 * this shape is accepted:
 *
 *  - surrounding whitespace is trimmed and empty segments are dropped
 *    (`//sites//X/` is `/sites/X`);
 *  - exactly two segments, the first `sites` or `teams` (any case);
 *  - the name is `[A-Za-z0-9_-]` then `[A-Za-z0-9._-]*`, and does not end in
 *    `.` — so no `%`-escape, backslash, whitespace or zero-width character,
 *    and no `.`/`..` segment.
 *
 * The result keeps the name's case (it is the path requested from Graph);
 * every comparison lower-cases it. `tools/lib/bindings.mjs` applies the same
 * rule, and both sides test the same table of spellings.
 */
export function canonicalSitePath(path: string): string | null {
  const segments = path.trim().split('/').filter(Boolean);
  if (segments.length !== 2) return null;
  const [kind, name] = segments as [string, string];
  if (!/^(sites|teams)$/i.test(kind)) return null;
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name) || name.endsWith('.')) return null;
  return `/${kind}/${name}`;
}
