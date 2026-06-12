import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { UnauthorizedError, ForbiddenError } from '@bcr/shared';

export interface AuthMiddlewareOptions {
  readonly tenantId: string;
  readonly expectedAudience: string;
  readonly expectedRoles: readonly string[];
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
 *  - at least one of `expectedRoles` is present in the `roles` claim
 *
 * Throws `UnauthorizedError` or `ForbiddenError` on failure.
 */
export class AuthMiddleware {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuers: readonly string[];

  constructor(private readonly opts: AuthMiddlewareOptions) {
    this.jwks = createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${opts.tenantId}/discovery/v2.0/keys`),
    );
    this.issuers = [
      `https://sts.windows.net/${opts.tenantId}/`,
      `https://login.microsoftonline.com/${opts.tenantId}/v2.0`,
    ];
  }

  async verify(authorizationHeader: string | null | undefined): Promise<VerifiedCaller> {
    if (!authorizationHeader) {
      throw new UnauthorizedError('Missing Authorization header');
    }
    const [scheme, token] = authorizationHeader.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedError('Authorization header must be a Bearer token');
    }

    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, this.jwks, {
        audience: this.opts.expectedAudience,
        issuer: [...this.issuers],
      });
      payload = verified.payload;
    } catch (err) {
      throw new UnauthorizedError('Token signature/issuer/audience validation failed', err);
    }

    const roles = (payload['roles'] as string[] | undefined) ?? [];
    const hasRequiredRole = this.opts.expectedRoles.some((r) => roles.includes(r));
    if (!hasRequiredRole) {
      throw new ForbiddenError(
        `Caller is missing one of the required app roles: ${this.opts.expectedRoles.join(', ')}`,
      );
    }

    return {
      subject: String(payload.sub ?? ''),
      appId: String(payload['appid'] ?? payload['azp'] ?? ''),
      tenantId: String(payload['tid'] ?? ''),
      roles,
    };
  }
}
