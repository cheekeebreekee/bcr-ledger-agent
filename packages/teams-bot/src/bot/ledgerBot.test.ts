import type { Attachment } from 'botbuilder';
import { filterFileAttachments } from './ledgerBot';

describe('filterFileAttachments', () => {
  it('keeps Teams file download info attachments', () => {
    const attachments: Attachment[] = [
      {
        contentType: 'application/vnd.microsoft.teams.file.download.info',
        name: 'Invoice_03_2026.pdf',
        content: { downloadUrl: 'https://graph.microsoft.com/...', uniqueId: 'abc' },
      },
    ];
    expect(filterFileAttachments(attachments)).toHaveLength(1);
  });

  it('keeps bot-framework attachments with a contentUrl', () => {
    const attachments: Attachment[] = [
      {
        contentType: 'application/pdf',
        name: 'Receipt_2026-03-15.pdf',
        contentUrl: 'https://smba.trafficmanager.net/attachments/...',
      },
    ];
    expect(filterFileAttachments(attachments)).toHaveLength(1);
  });

  it('drops adaptive-card replies', () => {
    const attachments: Attachment[] = [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: { type: 'AdaptiveCard' },
      },
    ];
    expect(filterFileAttachments(attachments)).toHaveLength(0);
  });

  it('drops attachments with neither contentUrl nor Teams payload', () => {
    const attachments: Attachment[] = [
      { contentType: 'text/plain', name: 'mention' },
    ];
    expect(filterFileAttachments(attachments)).toHaveLength(0);
  });

  it('returns an empty array for an empty input', () => {
    expect(filterFileAttachments([])).toEqual([]);
  });
});
