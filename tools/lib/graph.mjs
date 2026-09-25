/**
 * A deliberately small Microsoft Graph client for the operator tools.
 *
 * Node built-ins only (global `fetch`), so the tools run from a clean checkout
 * without `yarn install`.
 *
 * What it guarantees, because every tool relies on it:
 *
 * - **The token is never printed.** It lives in the `Authorization` header and
 *   nowhere else. Error messages are built from the Graph error body and the
 *   request path, and any accidental echo of the token is replaced with
 *   `[REDACTED]` before an error is thrown.
 * - **The token never leaves Graph.** `@odata.nextLink` is followed only when
 *   it points at the same origin as `baseUrl`. A next link on another host
 *   throws rather than receiving the bearer token.
 * - **Throttling is honoured.** 429 and 503 (and 504) are retried a bounded
 *   number of times. `Retry-After` is respected when present, in seconds or as
 *   an HTTP date, and capped. A non-idempotent request is retried only on
 *   those statuses, where Graph has declined the request. A network error
 *   retries only a GET.
 * - **Errors are typed.** `GraphError` carries `status`, `code`, `method`,
 *   `path` and `requestId`, so a caller branches on `err.status === 404`
 *   rather than on message text.
 */

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

const RETRY_STATUSES = new Set([429, 503, 504]);

export class GraphError extends Error {
  /**
   * @param {object} p
   * @param {number} p.status   HTTP status, or 0 for a network failure
   * @param {string} p.code     Graph error code, or the status as text
   * @param {string} p.message  Human-readable, already redacted
   * @param {string} p.method
   * @param {string} p.path     Path relative to the base URL, query string removed
   * @param {string} [p.requestId]
   */
  constructor({ status, code, message, method, path, requestId }) {
    super(`${method} ${path} → ${status || 'network'} ${code}: ${message}`);
    this.name = 'GraphError';
    this.status = status;
    this.code = code;
    this.method = method;
    this.path = path;
    if (requestId) this.requestId = requestId;
  }
}

/** Replace every occurrence of `secret` in `text`. Empty secrets are ignored. */
export function redact(text, secret) {
  if (!secret || typeof text !== 'string') return text;
  return text.split(secret).join('[REDACTED]');
}

/**
 * `Retry-After` in milliseconds, or `undefined` when absent or unparseable.
 * Graph sends seconds; RFC 9110 also allows an HTTP date.
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

/**
 * Decode the claims of a JWT for display. The signature is not checked: this
 * is only for telling the operator who they are signed in as and when the
 * token expires. It returns the claims, never the token.
 */
export function describeToken(token) {
  try {
    const part = String(token).split('.')[1];
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return {
      who: claims.upn ?? claims.unique_name ?? claims.preferred_username ?? claims.app_displayname,
      appId: claims.appid ?? claims.azp,
      scopes: claims.scp ?? '',
      roles: Array.isArray(claims.roles) ? claims.roles : [],
      audience: claims.aud,
      tenantId: claims.tid,
      expiresAt: typeof claims.exp === 'number' ? new Date(claims.exp * 1000) : undefined,
    };
  } catch {
    return undefined;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} [opts]
 * @param {string} [opts.token]            Defaults to `process.env.GRAPH_TOKEN`.
 * @param {string} [opts.baseUrl]
 * @param {typeof fetch} [opts.fetch]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {number} [opts.maxRetries]       Retries after the first attempt.
 * @param {number} [opts.maxRetryAfterMs]  Cap on a single wait.
 * @param {(info: {attempt:number, status:number, waitMs:number, path:string}) => void} [opts.onRetry]
 */
export function createGraph(opts = {}) {
  const token = opts.token ?? process.env.GRAPH_TOKEN;
  if (!token) {
    throw new Error(
      'No GRAPH_TOKEN in the environment. See tools/README.md, section "Authentication".',
    );
  }
  const baseUrl = (opts.baseUrl ?? GRAPH_BASE).replace(/\/+$/, '');
  const origin = new URL(baseUrl).origin;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const maxRetries = opts.maxRetries ?? 5;
  const maxRetryAfterMs = opts.maxRetryAfterMs ?? 120_000;
  const onRetry = opts.onRetry ?? (() => {});

  /** Absolute URL for `path`, refusing any host other than Graph's. */
  function resolveUrl(path) {
    if (/^https?:\/\//i.test(path)) {
      if (new URL(path).origin !== origin) {
        throw new GraphError({
          status: 0,
          code: 'foreignHost',
          message: 'refusing to send the Graph token to another host',
          method: 'GET',
          path: new URL(path).origin,
        });
      }
      return path;
    }
    return `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  /** The path as shown in errors: relative, without the query string. */
  function displayPath(url) {
    const u = new URL(url);
    const basePath = new URL(baseUrl).pathname;
    const p = u.pathname.startsWith(basePath) ? u.pathname.slice(basePath.length) : u.pathname;
    try {
      return decodeURIComponent(p) || '/';
    } catch {
      return p || '/';
    }
  }

  /**
   * @param {string} method
   * @param {string} path  Relative to the base URL, or an absolute Graph URL.
   * @param {object} [o]
   * @param {unknown} [o.body]
   * @param {Record<string,string>} [o.headers]
   * @param {boolean} [o.eventual]  Adds `ConsistencyLevel: eventual` (advanced directory queries).
   */
  async function request(method, path, o = {}) {
    const url = resolveUrl(path);
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(o.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(o.eventual ? { ConsistencyLevel: 'eventual' } : {}),
      ...(o.headers ?? {}),
    };
    const shownPath = displayPath(url);

    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers,
          ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
        });
      } catch (err) {
        // The request may or may not have reached Graph. Only a GET is safe
        // to repeat blind.
        if (method === 'GET' && attempt < maxRetries) {
          const waitMs = Math.min(1000 * 2 ** attempt, maxRetryAfterMs);
          onRetry({ attempt: attempt + 1, status: 0, waitMs, path: shownPath });
          await sleep(waitMs);
          continue;
        }
        throw new GraphError({
          status: 0,
          code: 'networkError',
          message: redact(String(err?.message ?? err), token),
          method,
          path: shownPath,
        });
      }

      if (RETRY_STATUSES.has(response.status) && attempt < maxRetries) {
        const hinted = parseRetryAfter(response.headers.get('retry-after'));
        const waitMs = Math.min(hinted ?? 1000 * 2 ** attempt, maxRetryAfterMs);
        onRetry({ attempt: attempt + 1, status: response.status, waitMs, path: shownPath });
        // Drain the body so the connection can be reused.
        await response.text().catch(() => '');
        await sleep(waitMs);
        continue;
      }

      const text = await response.text();
      let payload = {};
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { raw: text.slice(0, 500) };
        }
      }

      if (!response.ok) {
        const error = payload?.error ?? {};
        throw new GraphError({
          status: response.status,
          code: String(error.code ?? response.status),
          message: redact(String(error.message ?? response.statusText ?? ''), token),
          method,
          path: shownPath,
          requestId: error.innerError?.['request-id'] ?? response.headers.get('request-id') ?? '',
        });
      }
      return payload;
    }
  }

  /** Every page of a collection, following `@odata.nextLink`. */
  async function all(path, o = {}) {
    const rows = [];
    let next = path;
    const seen = new Set();
    while (next) {
      if (seen.has(next)) {
        throw new GraphError({
          status: 0,
          code: 'pagingLoop',
          message: 'the same @odata.nextLink came back twice',
          method: 'GET',
          path: displayPath(resolveUrl(next)),
        });
      }
      seen.add(next);
      const page = await request('GET', next, o);
      rows.push(...(Array.isArray(page.value) ? page.value : []));
      next = page['@odata.nextLink'];
    }
    return rows;
  }

  /** GET that returns `null` on 404 instead of throwing. */
  async function tryGet(path, o = {}) {
    try {
      return await request('GET', path, o);
    } catch (err) {
      if (err instanceof GraphError && err.status === 404) return null;
      throw err;
    }
  }

  return {
    request,
    all,
    tryGet,
    get: (path, o) => request('GET', path, o),
    post: (path, body, o = {}) => request('POST', path, { ...o, body }),
    patch: (path, body, o = {}) => request('PATCH', path, { ...o, body }),
  };
}

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving order.
 * Graph throttles per app and per tenant; four is polite and still fast.
 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Encode each segment of a server-relative path for a Graph `:/path:` address. */
export function encodePath(path) {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
