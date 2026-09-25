import { type Activity, type ConversationAccount, TestAdapter, type TurnContext } from 'botbuilder';
import { TURN_ERROR_TEXT } from './cardText';
import { createTurnErrorHandler } from './turnError';

function conversation(conversationType: string): ConversationAccount {
  return { id: 'c', name: '', isGroup: conversationType !== 'personal', conversationType };
}

async function failingTurn(conversationType: string) {
  const error = jest.fn();
  const adapter = new TestAdapter(async () => {
    throw new Error('boom: /sites/OtherClient returned 500');
  });
  adapter.onTurnError = createTurnErrorHandler({ error });
  const activity: Partial<Activity> = {
    type: 'message',
    text: 'hej',
    from: { id: 'user-1', name: 'U' },
    conversation: conversation(conversationType),
  };
  await adapter.processActivity(activity);
  return { error, sent: adapter.activeQueue };
}

describe('createTurnErrorHandler', () => {
  it('logs the error and sends one generic Polish line in a 1:1 chat', async () => {
    const { error, sent } = await failingTurn('personal');
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), activityType: 'message' }),
      'unhandled turn error',
    );
    expect(sent.map((a) => a.text)).toEqual([TURN_ERROR_TEXT]);
    expect(TURN_ERROR_TEXT).not.toMatch(/boom|OtherClient|Sorry/);
  });

  it.each(['groupChat', 'channel'])('stays silent in a %s', async (conversationType) => {
    const { error, sent } = await failingTurn(conversationType);
    expect(error).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
  });

  it('logs and swallows a failure to send the apology', async () => {
    const error = jest.fn();
    const handler = createTurnErrorHandler({ error });
    const context = {
      activity: { id: 'a1', type: 'message', conversation: conversation('personal') },
      sendActivity: jest.fn(async () => {
        throw new Error('connector down');
      }),
    } as unknown as TurnContext;

    await expect(handler(context, new Error('first'))).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenLastCalledWith(
      expect.objectContaining({ activityId: 'a1' }),
      'failed to send turn-error reply',
    );
  });
});
