/**
 * Test doubles for the Graph client: a `fetch` that answers from a handler
 * and records every call. No network, no tenant.
 *
 * Everything in these fixtures is synthetic: GUIDs follow the
 * `00000000-0000-4000-8000-…` pattern, NIPs are `000000000x`, hostnames are
 * `contoso.sharepoint.com`. None of it names a real object.
 */

export function jsonResponse(status, body, headers = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export const notFound = (what = 'item') =>
  jsonResponse(404, { error: { code: 'itemNotFound', message: `${what} not found` } });

/**
 * @param {(call: {method:string, path:string, query:URLSearchParams, body:any, headers:object}) =>
 *   Response | Promise<Response> | undefined} handler  `undefined` → 404
 */
export function fakeFetch(handler) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.replace(/^\/v1\.0/, ''));
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    const call = { method, url: String(url), path, query: u.searchParams, body, headers: init.headers ?? {} };
    calls.push(call);
    const res = await handler(call);
    return res ?? notFound(`${method} ${path}`);
  };
  return { fetch, calls };
}

/** A token-shaped string whose claims decode; the signature is junk. */
export function fakeJwt(claims) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none', typ: 'JWT' })}.${enc(claims)}.fake-signature-not-a-secret`;
}

/** Collects printed lines for assertions. */
export function capture() {
  const lines = [];
  return { lines, print: (line = '') => lines.push(String(line)), text: () => lines.join('\n') };
}
