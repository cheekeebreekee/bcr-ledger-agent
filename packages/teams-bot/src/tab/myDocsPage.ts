import { createHash } from 'node:crypto';
import type { HttpResponseInit } from '@azure/functions';

/**
 * The former "Moje dokumenty" Personal Tab, reduced to a static page (P0-5).
 *
 * The tab used to take `userObjectId` from its query string and ask
 * ingestion for that user's client site — so anyone could read any user's
 * routing by changing the id (an IDOR). The manifest no longer declares the
 * tab; the route stays only so installs of the old app version get a page
 * instead of a 404.
 *
 * The page is the same bytes for everyone: it reads no query parameter,
 * calls nothing, and contains no data. It has no script; its only style
 * block is allowed by hash, so the CSP needs no `'unsafe-inline'`.
 */

const STYLE = [
  ':root{color-scheme:light dark;--bg:#f5f5f5;--fg:#242424;--card:#fff;--border:#e0e0e0}',
  '@media (prefers-color-scheme:dark){:root{--bg:#1f1f1f;--fg:#f5f5f5;--card:#292929;--border:#3d3d3d}}',
  'body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
  'background:var(--bg);color:var(--fg)}',
  'main{max-width:640px;margin:0 auto;padding:24px 16px}',
  'h1{font-size:20px;margin:0 0 16px}',
  'section{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:20px}',
  'p{font-size:14px;line-height:1.5;margin:0 0 12px}',
  'p:last-child{margin-bottom:0}',
].join('');

const STYLE_HASH = createHash('sha256').update(STYLE, 'utf8').digest('base64');

const HTML = `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Moje dokumenty · Asystent BCR</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Moje dokumenty</h1>
<section>
<p>Twoje dokumenty znajdziesz w swoim zespole w Teams: kanał „Dokumenty księgowe” → karta „Udostępnione”.</p>
<p>Nowe dokumenty wysyłaj jako załączniki w czacie z Asystentem BCR albo dodawaj w tym samym kanale: jako załącznik do wpisu lub na karcie „Udostępnione”. Asystent BCR zapisze każdy plik w odpowiednim folderze.</p>
<p>Asystent działa tylko na koncie, które BCR założyło dla Twojej firmy (login: NIP@bcr-group.pl).</p>
</section>
</main>
</body>
</html>
`;

/**
 * Teams hosts that may frame a personal tab (classic and new Teams, web and
 * desktop, and Teams inside Microsoft 365 / Outlook).
 */
const FRAME_ANCESTORS = [
  'https://teams.microsoft.com',
  'https://*.teams.microsoft.com',
  'https://*.cloud.microsoft',
  'https://*.office.com',
  'https://*.microsoft365.com',
].join(' ');

export const MY_DOCS_CSP = [
  "default-src 'none'",
  `style-src 'sha256-${STYLE_HASH}'`,
  "base-uri 'none'",
  "form-action 'none'",
  `frame-ancestors ${FRAME_ANCESTORS}`,
].join('; ');

export function buildMyDocsResponse(): HttpResponseInit {
  return {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': MY_DOCS_CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
    body: HTML,
  };
}
