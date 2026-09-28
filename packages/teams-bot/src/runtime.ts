/**
 * Cold-start singletons for the bot's HTTP functions. Kept in one file so
 * adding a new function is just "import from './runtime'". Wiring only —
 * the behaviour lives in `bot/**` and `services/**`, where it is tested.
 */
import { CloudAdapter, type ConfigurationBotFrameworkAuthenticationOptions } from 'botbuilder';
import { createLogger } from '@bcr/shared';
import { loadBotConfig } from './config';
import { LedgerBot } from './bot/ledgerBot';
import { createBotFrameworkAuth } from './bot/channelAuth';
import { GateMiddleware } from './bot/gateMiddleware';
import { createTurnErrorHandler } from './bot/turnError';
import { IngestionClient } from './services/ingestionClient';
import { AttachmentDownloader } from './services/attachmentDownloader';
import { SearchClient } from './services/searchClient';
import { SEARCH_FLOOD_LIMIT, UserLimiter } from './services/userLimiter';

const log = createLogger('bot/runtime');

export const config = loadBotConfig();

// Bot Framework channel tokens only: never the SDK's emulator/skill paths
// (`bot/channelAuth.ts`), which the bot secret alone could satisfy.
export const botFrameworkAuth = createBotFrameworkAuth({
  MicrosoftAppId: config.microsoftAppId,
  MicrosoftAppPassword: config.microsoftAppPassword,
  MicrosoftAppType: config.microsoftAppType,
  MicrosoftAppTenantId: config.microsoftAppTenantId,
} satisfies ConfigurationBotFrameworkAuthenticationOptions);

export const adapter = new CloudAdapter(botFrameworkAuth);

// The gate runs first, on every activity type, before any bot logic.
adapter.use(
  new GateMiddleware({ tenantId: config.microsoftAppTenantId, mode: config.botGateMode }),
);

adapter.onTurnError = createTurnErrorHandler(log);

log.info({ botGateMode: config.botGateMode }, 'bot runtime initialised');

export const ingestionClient = new IngestionClient({
  baseUrl: config.ingestionBaseUrl,
  scope: config.ingestionScope,
  tenantId: config.microsoftAppTenantId,
  clientId: config.microsoftAppId,
  clientSecret: config.microsoftAppPassword,
});

export const attachmentDownloader = new AttachmentDownloader();

// Client search (`SEARCH_MODE=on`): ingestion's `POST /api/search`, called with
// a token of this Function App's system-assigned managed identity (the only
// holder of `Documents.Search`), never the bot registration's secret. Off,
// nothing is built and text gets today's help card.
const search =
  config.searchMode === 'on'
    ? {
        client: new SearchClient({
          baseUrl: config.ingestionBaseUrl,
          scope: config.ingestionScope,
        }),
        limiter: new UserLimiter(SEARCH_FLOOD_LIMIT),
        tenantId: config.microsoftAppTenantId,
      }
    : undefined;

log.info(
  {
    searchMode: config.searchMode,
    ...(search
      ? { caller: 'managed_identity', floodLimitPerMinute: SEARCH_FLOOD_LIMIT.limit }
      : {}),
  },
  'search.config',
);

export const bot = new LedgerBot({
  ingestionClient,
  attachmentDownloader,
  ...(search ? { search } : {}),
});
