/**
 * Cold-start singletons shared between the bot's HTTP functions
 * (`messages` and `mydocs`). Kept in one file so adding a new function
 * is just "import from './runtime'".
 */
import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  type ConfigurationBotFrameworkAuthenticationOptions,
} from 'botbuilder';
import { createLogger } from '@bcr/shared';
import { loadBotConfig } from './config';
import { LedgerBot } from './bot/ledgerBot';
import { IngestionClient } from './services/ingestionClient';
import { AttachmentDownloader } from './services/attachmentDownloader';

const log = createLogger('bot/runtime');

export const config = loadBotConfig();

export const botFrameworkAuth = new ConfigurationBotFrameworkAuthentication(
  {
    MicrosoftAppId: config.microsoftAppId,
    MicrosoftAppPassword: config.microsoftAppPassword,
    MicrosoftAppType: config.microsoftAppType,
    MicrosoftAppTenantId: config.microsoftAppTenantId,
  } satisfies ConfigurationBotFrameworkAuthenticationOptions,
);

export const adapter = new CloudAdapter(botFrameworkAuth);

adapter.onTurnError = async (context, error) => {
  log.error({ err: error, activityId: context.activity.id }, 'unhandled turn error');
  await context.sendActivity(
    '⚠️ Sorry — something went wrong on my side. The error has been logged for investigation.',
  );
};

export const ingestionClient = new IngestionClient({
  baseUrl: config.ingestionBaseUrl,
  scope: config.ingestionScope,
  tenantId: config.microsoftAppTenantId,
  clientId: config.microsoftAppId,
  clientSecret: config.microsoftAppPassword,
});

export const attachmentDownloader = new AttachmentDownloader();

export const bot = new LedgerBot({ ingestionClient, attachmentDownloader });
