/**
 * Bot Framework authentication for `/api/messages`: only tokens the Bot
 * Framework channel service issued (`iss` = `https://api.botframework.com`).
 *
 * The SDK's default also accepts "emulator" tokens (botframework-connector
 * 4.23, `EmulatorValidation`): any AAD token whose `appid`/`azp` is this
 * bot's app id, from the issuer of whatever tenant it names, with no audience
 * check, and it then replies to whatever `serviceUrl` the body names. So
 * anyone holding the bot registration's secret could mint one and post an
 * activity naming any guest's `aadObjectId`: the gate reads only body fields,
 * it would pass, and the bot would upload or search as that guest. A channel
 * token is signed with the Bot Framework's own keys and the SDK checks its
 * `serviceurl` claim against the activity, so the body is the channel's, not
 * the caller's.
 *
 * `validateClaims` runs after every token path (channel, emulator, skill,
 * ASE), so this one issuer check closes all but the channel. The Bot
 * Framework Emulator no longer authenticates at all; bot turns are tested
 * with `TestAdapter`.
 */
import {
  ConfigurationBotFrameworkAuthentication,
  type ConfigurationBotFrameworkAuthenticationOptions,
} from 'botbuilder';
import {
  AuthenticationConfiguration,
  AuthenticationConstants,
  AuthenticationError,
  type Claim,
} from 'botframework-connector';

/** Throws unless the token's issuer is the Bot Framework channel service. */
export async function requireChannelIssuer(claims: readonly Claim[]): Promise<void> {
  const issuer = claims.find((c) => c.type === AuthenticationConstants.IssuerClaim)?.value;
  if (issuer !== AuthenticationConstants.ToBotFromChannelTokenIssuer) {
    throw new AuthenticationError('Only Bot Framework channel tokens are accepted.', 401);
  }
}

/** The adapter's authentication: the SDK's, restricted to channel tokens. */
export function createBotFrameworkAuth(
  options: ConfigurationBotFrameworkAuthenticationOptions,
): ConfigurationBotFrameworkAuthentication {
  return new ConfigurationBotFrameworkAuthentication(
    options,
    undefined,
    new AuthenticationConfiguration([], (claims) => requireChannelIssuer(claims)),
  );
}
