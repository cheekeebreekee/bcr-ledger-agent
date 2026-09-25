import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import { createLogger, type UserTargetResponsePayload } from '@bcr/shared';
import { ingestionClient } from '../runtime';

const log = createLogger('bot/mydocs');

/**
 * `GET /api/mydocs?userObjectId={guid}&theme={light|dark|contrast}`
 *
 * Renders the Personal Tab that ships with the Teams app. Teams substitutes
 * the `{userObjectId}` and `{theme}` template tokens from the manifest
 * before loading this URL in the tab iframe.
 *
 * Flow:
 *   1. Read the user's AAD id from the query string.
 *   2. Ask the ingestion API which SharePoint site their client documents
 *      live in (`GET /api/user-target`).
 *   3. Return a minimal HTML page with the client name and a button that
 *      opens SharePoint via the Teams JS SDK (falls back to `window.open`).
 *
 * We keep the page tiny and self-contained (inline CSS + JS, one CDN
 * script). SharePoint refuses to be iframed cross-origin, so we deep-link
 * out instead of embedding.
 */
app.http('mydocs', {
  route: 'mydocs',
  methods: ['GET'],
  authLevel: 'anonymous', // Called by Teams inside a personal tab iframe.
  handler: handleMyDocs,
});

export async function handleMyDocs(
  req: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const reqLog = log.child({ invocationId: context.invocationId });
  const userObjectId = req.query.get('userObjectId')?.trim() ?? '';
  const theme = normaliseTheme(req.query.get('theme'));

  if (!userObjectId) {
    return htmlResponse(renderErrorPage(theme, 'Brak identyfikatora użytkownika.'), 400);
  }

  let target: UserTargetResponsePayload;
  try {
    target = await ingestionClient.getUserTarget(userObjectId);
  } catch (err) {
    reqLog.error({ err, userObjectId }, 'user-target lookup failed');
    return htmlResponse(
      renderErrorPage(
        theme,
        'Nie udało się ustalić Twojego klienta. Spróbuj ponownie za chwilę lub skontaktuj się z BCR.',
      ),
      502,
    );
  }

  reqLog.info(
    { userObjectId, clientId: target.clientId, source: target.source },
    'personal tab resolved',
  );

  return htmlResponse(renderTabPage(theme, target), 200);
}

// ---------------------------------------------------------------------------

type TabTheme = 'default' | 'dark' | 'contrast';

function normaliseTheme(raw: string | null): TabTheme {
  if (raw === 'dark') return 'dark';
  if (raw === 'contrast') return 'contrast';
  return 'default';
}

function htmlResponse(html: string, status: number): HttpResponseInit {
  return {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // Teams personal tabs iframe our content, so we must allow same-origin
      // framing from the Teams client. Everything else is denied.
      'content-security-policy':
        "default-src 'self' https://res.cdn.office.net; " +
        "style-src 'unsafe-inline'; " +
        "script-src 'self' 'unsafe-inline' https://res.cdn.office.net; " +
        'frame-ancestors https://*.teams.microsoft.com https://teams.microsoft.com https://*.microsoft.com;',
    },
    body: html,
  };
}

function renderTabPage(theme: TabTheme, t: UserTargetResponsePayload): string {
  const isFallback = t.source === 'fallback';
  const title = escapeHtml(t.title);
  const url = escapeHtml(t.sharepointWebUrl);
  const sourceBadge = isFallback
    ? '<span class="badge badge-warn">Ogólny bufor BCR</span>'
    : '<span class="badge badge-ok">Twój klient</span>';
  const message = isFallback
    ? 'Nie masz przypisanego klienta w katalogu BCR. Twoje dokumenty trafiają do wspólnego folderu BCR Group. Skontaktuj się z opiekunem, aby dodać Cię do właściwego klienta.'
    : 'Poniżej znajdziesz link do dokumentów Twojego klienta w SharePoint.';

  return `<!doctype html>
<html lang="pl" data-theme="${theme}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Moje dokumenty · Asystent BCR</title>
  <script src="https://res.cdn.office.net/teams-js/2.19.0/js/MicrosoftTeams.min.js"></script>
  ${THEME_STYLES}
</head>
<body>
  <main class="wrap">
    <header>
      <h1>Moje dokumenty</h1>
      ${sourceBadge}
    </header>
    <section class="card">
      <p class="client-name">${title}</p>
      <p class="msg">${escapeHtml(message)}</p>
      ${
        url
          ? `<button id="open-btn" class="primary" data-url="${url}">Otwórz w SharePoint</button>
             <p class="tiny">Otworzy się w nowej karcie SharePoint.</p>`
          : '<p class="tiny">Brak URL-a SharePoint dla tego klienta \u2014 zgłoś do BCR.</p>'
      }
    </section>
    <footer>
      <span>Klient: <code>${escapeHtml(t.clientId)}</code></span>
    </footer>
  </main>
  <script>
    (function () {
      var btn = document.getElementById('open-btn');
      if (!btn) return;
      var url = btn.getAttribute('data-url');
      btn.addEventListener('click', function () {
        try {
          if (window.microsoftTeams && microsoftTeams.app) {
            microsoftTeams.app.initialize().then(function () {
              microsoftTeams.app.openLink(url);
            }).catch(function () { window.open(url, '_blank'); });
          } else {
            window.open(url, '_blank');
          }
        } catch (e) {
          window.open(url, '_blank');
        }
      });
    })();
  </script>
</body>
</html>`;
}

function renderErrorPage(theme: TabTheme, message: string): string {
  return `<!doctype html>
<html lang="pl" data-theme="${theme}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Moje dokumenty · Asystent BCR</title>
  ${THEME_STYLES}
</head>
<body>
  <main class="wrap">
    <header><h1>Moje dokumenty</h1></header>
    <section class="card">
      <p class="msg">${escapeHtml(message)}</p>
    </section>
  </main>
</body>
</html>`;
}

// Minimal theme-aware CSS. Uses Teams' three theme names as CSS custom
// property targets. Kept inline so the tab never blocks on a stylesheet.
const THEME_STYLES = `<style>
  :root { --bg: #f5f5f5; --fg: #242424; --card: #fff; --muted: #616161; --accent: #464feb; --accent-fg: #fff; --border: #e0e0e0; }
  html[data-theme="dark"] { --bg: #1f1f1f; --fg: #f5f5f5; --card: #292929; --muted: #adadad; --accent: #7f85f5; --accent-fg: #1f1f1f; --border: #3d3d3d; }
  html[data-theme="contrast"] { --bg: #000; --fg: #fff; --card: #000; --muted: #ffff01; --accent: #ffff01; --accent-fg: #000; --border: #fff; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--fg); }
  .wrap { max-width: 640px; margin: 0 auto; padding: 24px 20px; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 20px; }
  h1 { font-size: 20px; margin: 0; }
  .badge { font-size: 12px; padding: 4px 8px; border-radius: 12px; border: 1px solid var(--border); color: var(--muted); }
  .badge-ok { background: rgba(70, 79, 235, .1); border-color: var(--accent); color: var(--accent); }
  .badge-warn { background: rgba(203, 137, 0, .1); border-color: #cb8900; color: #cb8900; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 20px; }
  .client-name { font-size: 18px; font-weight: 600; margin: 0 0 8px; }
  .msg { color: var(--muted); font-size: 14px; margin: 0 0 16px; line-height: 1.5; }
  button.primary { display: inline-block; padding: 10px 16px; background: var(--accent); color: var(--accent-fg); border: 0; border-radius: 4px; font-size: 14px; font-weight: 600; cursor: pointer; }
  button.primary:hover { filter: brightness(1.05); }
  .tiny { font-size: 12px; color: var(--muted); margin: 8px 0 0; }
  footer { margin-top: 20px; font-size: 12px; color: var(--muted); text-align: right; }
  code { font-family: ui-monospace, Menlo, monospace; }
</style>`;

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
