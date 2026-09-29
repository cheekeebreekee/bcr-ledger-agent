import { Writable } from 'node:stream';
import { createRootLogger } from './logger';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(line));
      done();
    },
  });
  return { logger: createRootLogger(stream), lines };
}

describe('root logger redaction', () => {
  // App Insights used to hold every client's file names, client titles and
  // SharePoint locations. Ids stay; client data is censored wherever it
  // appears, top level or one object down.
  it.each([
    'filename',
    'fileName',
    'originalFilename',
    'webUrl',
    'fullPath',
    'sitePath',
    'title',
    'parties',
    'nip',
    'extraction',
    // A client account's UPN is `{NIP}@bcr-group.pl`.
    'userPrincipalName',
    'upn',
  ])('censors %s at the top level and one level down', (key) => {
    const { logger, lines } = capture();
    logger.info({ [key]: 'sensitive', nested: { [key]: 'sensitive' } }, 'm');
    const [line] = lines;
    expect(line?.[key]).toBe('[REDACTED]');
    expect((line?.['nested'] as Record<string, unknown>)[key]).toBe('[REDACTED]');
  });

  it('keeps ids', () => {
    const { logger, lines } = capture();
    logger.info({ documentId: 'd-1', clientId: '0002', driveItemId: 'item-1' }, 'document.filed');
    expect(lines[0]).toMatchObject({ documentId: 'd-1', clientId: '0002', driveItemId: 'item-1' });
  });

  it('censors secrets one level down', () => {
    const { logger, lines } = capture();
    logger.info({ req: { authorization: 'Bearer x', token: 't' } }, 'm');
    expect(lines[0]?.['req']).toEqual({ authorization: '[REDACTED]', token: '[REDACTED]' });
  });

  it('applies to child loggers made with createLogger-style bindings', () => {
    const { logger, lines } = capture();
    logger.child({ area: 'x', filename: 'faktura-klienta.pdf' }).info('m');
    expect(lines[0]?.['filename']).toBe('[REDACTED]');
  });
});
