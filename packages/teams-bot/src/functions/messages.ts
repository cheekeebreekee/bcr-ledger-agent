import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import type { Activity } from 'botbuilder';
import { createLogger } from '@bcr/shared';
import { adapter, bot } from '../runtime';

const log = createLogger('bot/messages');

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
