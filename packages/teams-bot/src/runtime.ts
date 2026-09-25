/**
 * Cold-start singletons for the bot's HTTP functions. Kept in one file so
 * adding a new function is just "import from './runtime'". Wiring only —
 * the behaviour lives in `bot/**` and `services/**`, where it is tested.
 */
import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  type ConfigurationBotFrameworkAuthenticationOptions,
} from 'botbuilder';
import { createLogger } from '@bcr/shared';
import { loadBotConfig } from './config';
import { LedgerBot } from './bot/ledgerBot';
import { GateMiddleware } from './bot/gateMiddleware';
import { createTurnErrorHandler } from './bot/turnError';
import { IngestionClient } from './services/ingestionClient';
import { AttachmentDownloader } from './services/attachmentDownloader';

const log = createLogger('bot/runtime');

export const config = loadBotConfig();

export const botFrameworkAuth = new ConfigurationBotFrameworkAuthentication({
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

export const bot = new LedgerBot({ ingestionClient, attachmentDownloader });
