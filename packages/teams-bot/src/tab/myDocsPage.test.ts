import { createHash } from 'node:crypto';
import { buildMyDocsResponse, MY_DOCS_CSP } from './myDocsPage';

describe('buildMyDocsResponse (static "Moje dokumenty" page)', () => {
  const res = buildMyDocsResponse();
  const body = String(res.body);
  const headers = res.headers as Record<string, string>;

  it('is a 200 HTML page that says where the documents live', () => {
    expect(res.status).toBe(200);
    expect(headers['content-type']).toBe('text/html; charset=utf-8');
    expect(body).toContain(
      'Twoje dokumenty znajdziesz w swoim zespole w Teams: kanał „Dokumenty księgowe” → karta „Udostępnione”.',
    );
  });

  // Owner's decision (28 Sep 2026): a client is its NIP@ Member account,
  // which can attach in the bot's chat, so the page offers both intakes.
  it('offers the bot chat and the channel, and names the NIP@ account', () => {
    expect(body).toContain('w czacie z Asystentem BCR');
    expect(body).toContain('w tym samym kanale');
    expect(body).toContain('NIP@bcr-group.pl');
    expect(body).toContain(
      '<p>Asystent działa tylko na koncie, które BCR założyło dla Twojej firmy (login: NIP@bcr-group.pl).</p>',
    );
    expect(body).not.toContain('Nowe dokumenty dodawaj w tym samym kanale');
  });

  it('is the same bytes on every call — nothing is looked up or reflected', () => {
    expect(buildMyDocsResponse().body).toBe(body);
    expect(body).not.toMatch(/\$\{|userObjectId|sharepoint\.com|clientId/i);
  });

  it('carries no script and no link', () => {
    expect(body).not.toMatch(/<script|<a\s|href=|\son\w+=/i);
  });

  it('has a strict CSP without unsafe-inline', () => {
    expect(headers['content-security-policy']).toBe(MY_DOCS_CSP);
    expect(MY_DOCS_CSP).not.toContain('unsafe-inline');
    expect(MY_DOCS_CSP).toContain("default-src 'none'");
    expect(MY_DOCS_CSP).toContain("base-uri 'none'");
    expect(MY_DOCS_CSP).toMatch(/frame-ancestors [^;]*https:\/\/teams\.microsoft\.com/);
    expect(headers['x-content-type-options']).toBe('nosniff');
  });

  it('allows exactly the inline style block, by its hash', () => {
    const styles = [...body.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? '');
    expect(styles).toHaveLength(1);
    const hash = createHash('sha256')
      .update(styles[0] ?? '', 'utf8')
      .digest('base64');
    expect(MY_DOCS_CSP).toContain(`style-src 'sha256-${hash}'`);
  });
});
