import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { createLogger, UnauthorizedError, ForbiddenError } from '@bcr/shared';

export interface AuthMiddlewareOptions {
  readonly tenantId: string;
  readonly expectedAudience: string;
  /** Injected in tests (e.g. `createLocalJWKSet`); defaults to the tenant's JWKS endpoint. */
  readonly keySet?: JWTVerifyGetKey;
}

/**
 * Who may call a route. Both conditions must hold: the token carries at least
 * one of `roles`, AND the calling application (`appid` on v1 tokens, `azp` on
 * v2) is one of `appIds`. The role alone is not enough — any app granted the
 * role could otherwise assert an arbitrary user id to the API.
 */
export interface CallerPolicy {
  readonly roles: readonly string[];
  readonly appIds: readonly string[];
}

export interface VerifiedCaller {
  readonly subject: string;
  readonly appId: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
}

/**
 * Validates an Azure AD JWT obtained via the client-credentials flow.
 *
 * Checks performed:
 *  - signature against the tenant's JWKS endpoint
 *  - issuer = `https://sts.windows.net/<tenant>/` or `https://login.microsoftonline.com/<tenant>/v2.0`
 *  - audience = `expectedAudience` (the ingestion App Registration's App ID URI)
 *  - `tid` = the tenant
 *  - at least one of the policy's roles is present in the `roles` claim
 *  - the calling app id is on the policy's allow-list
 *
 * Throws `UnauthorizedError` or `ForbiddenError` on failure.
 */
export class AuthMiddleware {
  private readonly log = createLogger('ingestion/auth');
  private readonly keySet: JWTVerifyGetKey;
  private readonly issuers: readonly string[];

  constructor(private readonly opts: AuthMiddlewareOptions) {
    this.keySet =
      opts.keySet ??
      createRemoteJWKSet(
        new URL(`https://login.microsoftonline.com/${opts.tenantId}/discovery/v2.0/keys`),
      );
    this.issuers = [
      `https://sts.windows.net/${opts.tenantId}/`,
      `https://login.microsoftonline.com/${opts.tenantId}/v2.0`,
    ];
  }

  async verify(
    authorizationHeader: string | null | undefined,
    policy: CallerPolicy,
  ): Promise<VerifiedCaller> {
    if (!authorizationHeader) {
      throw new UnauthorizedError('Missing Authorization header');
    }
    const [scheme, token] = authorizationHeader.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedError('Authorization header must be a Bearer token');
    }

    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, this.keySet, {
        audience: this.opts.expectedAudience,
        issuer: [...this.issuers],
      });
      payload = verified.payload;
    } catch (err) {
      throw new UnauthorizedError('Token signature/issuer/audience validation failed', err);
    }

    const tenantId = String(payload['tid'] ?? '');
    if (tenantId !== this.opts.tenantId) {
      throw new UnauthorizedError('Token was issued for a different tenant');
    }

    const roles = Array.isArray(payload['roles']) ? (payload['roles'] as unknown[]).map(String) : [];
    if (!policy.roles.some((r) => roles.includes(r))) {
      throw new ForbiddenError('Caller is missing a required app role');
    }

    const appId = String(payload['appid'] ?? payload['azp'] ?? '');
    const allowed = policy.appIds.map((id) => id.toLowerCase());
    if (!appId || !allowed.includes(appId.toLowerCase())) {
      this.log.warn({ event: 'ingestion.caller.rejected', appId }, 'ingestion.caller.rejected');
      throw new ForbiddenError('Calling application is not allowed on this route');
    }

    return {
      subject: String(payload.sub ?? ''),
      appId,
      tenantId,
      roles,
    };
  }
}
