import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  type ConfigurationBotFrameworkAuthenticationOptions,
  type Activity,
} from 'botbuilder';
import { createLogger } from '@bcr/shared';
import { LedgerBot } from '../bot/ledgerBot';
import { loadBotConfig } from '../config';
import { IngestionClient } from '../services/ingestionClient';
import { AttachmentDownloader } from '../services/attachmentDownloader';

const log = createLogger('bot/messages');

// ---------------------------------------------------------------------------
// Cold-start wiring. Everything below is constructed exactly once per worker.
// ---------------------------------------------------------------------------

const config = loadBotConfig();

const auth = new ConfigurationBotFrameworkAuthentication(
  {
    MicrosoftAppId: config.microsoftAppId,
    MicrosoftAppPassword: config.microsoftAppPassword,
    MicrosoftAppType: config.microsoftAppType,
    MicrosoftAppTenantId: config.microsoftAppTenantId,
  } satisfies ConfigurationBotFrameworkAuthenticationOptions,
);

const adapter = new CloudAdapter(auth);

adapter.onTurnError = async (context, error) => {
  log.error({ err: error, activityId: context.activity.id }, 'unhandled turn error');
  await context.sendActivity(
    '⚠️ Sorry — something went wrong on my side. The error has been logged for investigation.',
  );
};

const ingestionClient = new IngestionClient({
  baseUrl: config.ingestionBaseUrl,
  scope: config.ingestionScope,
  tenantId: config.microsoftAppTenantId,
  clientId: config.microsoftAppId,
  clientSecret: config.microsoftAppPassword,
});

const attachmentDownloader = new AttachmentDownloader();

const bot = new LedgerBot({ ingestionClient, attachmentDownloader });

// ---------------------------------------------------------------------------
// HTTP trigger registration
// ---------------------------------------------------------------------------

app.http('messages', {
  route: 'messages',
  methods: ['POST'],
  authLevel: 'anonymous', // Bot Framework JWT validation is done by the adapter
  handler: handleMessages,
});

export async function handleMessages(
  req: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const authorization = req.headers.get('authorization') ?? '';
  const activity = (await req.json()) as Activity;

  const turnLog = log.child({
    invocationId: context.invocationId,
    activityId: activity.id,
    conversationId: activity.conversation?.id,
    activityType: activity.type,
  });
  turnLog.debug('activity received');

  try {
    // `processActivityDirect` is the official "I already have an Activity
    // and an Authorization header in hand" entry point. It validates the
    // bearer token, builds a TurnContext, invokes our logic, and sends any
    // outbound activities back through the bot connector — all on its own.
    await adapter.processActivityDirect(authorization, activity, async (turnContext) => {
      await bot.run(turnContext);
    });
    return { status: 200 };
  } catch (err) {
    turnLog.error({ err }, 'adapter.processActivityDirect threw');
    return { status: 500, jsonBody: { error: 'turn-failed' } };
  }
}
