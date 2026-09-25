import type { Attachment } from 'botbuilder';
import {
  AttachmentDownloader,
  type DownloadFetcher,
  mimeFromExtension,
} from './attachmentDownloader';

type FetchResult = Awaited<ReturnType<DownloadFetcher>>;

function fetcherReturning(result: Partial<FetchResult> & { bytes?: string }) {
  return jest.fn<ReturnType<DownloadFetcher>, Parameters<DownloadFetcher>>(async () => ({
    statusCode: result.statusCode ?? 200,
    headers: result.headers ?? {},
    body: {
      arrayBuffer: async () => {
        const buf = Buffer.from(result.bytes ?? 'file-bytes');
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      },
    },
  }));
}

const TEAMS_FILE = 'application/vnd.microsoft.teams.file.download.info';

describe('AttachmentDownloader', () => {
  it('downloads a Teams file from its downloadUrl and infers the type from the extension', async () => {
    const fetcher = fetcherReturning({ bytes: '%PDF-1.7' });
    const downloader = new AttachmentDownloader({ fetcher });

    const result = await downloader.download({
      contentType: TEAMS_FILE,
      name: 'Faktura.PDF',
      content: { downloadUrl: 'https://files.example.test/dl?tempauth=secret' },
    });

    expect(fetcher).toHaveBeenCalledWith('https://files.example.test/dl?tempauth=secret', {
      method: 'GET',
    });
    expect(result.content.toString()).toBe('%PDF-1.7');
    expect(result.contentType).toBe('application/pdf');
  });

  it('prefers a string content-type header over the inferred type', async () => {
    const fetcher = fetcherReturning({ headers: { 'content-type': 'image/png' } });
    const result = await new AttachmentDownloader({ fetcher }).download({
      contentType: TEAMS_FILE,
      name: 'scan.pdf',
      content: { downloadUrl: 'https://files.example.test/dl' },
    });
    expect(result.contentType).toBe('image/png');
  });

  it('ignores a multi-valued content-type header', async () => {
    const fetcher = fetcherReturning({ headers: { 'content-type': ['a/b', 'c/d'] } });
    const result = await new AttachmentDownloader({ fetcher }).download({
      contentType: TEAMS_FILE,
      name: 'noext',
      content: { downloadUrl: 'https://files.example.test/dl' },
    });
    expect(result.contentType).toBe('application/octet-stream');
  });

  it('rejects a Teams file without a downloadUrl, without naming the file', async () => {
    const downloader = new AttachmentDownloader({ fetcher: fetcherReturning({}) });
    const exactly = /^Teams file attachment is missing a downloadUrl$/;
    await expect(
      downloader.download({ contentType: TEAMS_FILE, name: 'poufne.pdf', content: {} }),
    ).rejects.toThrow(exactly);
    await expect(
      downloader.download({ contentType: TEAMS_FILE, name: 'poufne.pdf' }),
    ).rejects.toThrow(exactly);
  });

  it('downloads a Bot Framework attachment from contentUrl with its declared type', async () => {
    const fetcher = fetcherReturning({});
    const result = await new AttachmentDownloader({ fetcher }).download({
      contentType: 'image/jpeg',
      name: 'photo.jpg',
      contentUrl: 'https://attachments.example.test/1',
    });
    expect(fetcher).toHaveBeenCalledWith('https://attachments.example.test/1', { method: 'GET' });
    expect(result.contentType).toBe('image/jpeg');
  });

  it('defaults a contentUrl attachment without a type to octet-stream', async () => {
    const result = await new AttachmentDownloader({ fetcher: fetcherReturning({}) }).download({
      contentUrl: 'https://attachments.example.test/1',
    } as Attachment);
    expect(result.contentType).toBe('application/octet-stream');
  });

  it('decodes inline base64 content without any network call', async () => {
    const fetcher = fetcherReturning({});
    const result = await new AttachmentDownloader({ fetcher }).download({
      contentType: 'text/plain',
      content: Buffer.from('hello').toString('base64'),
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.content.toString()).toBe('hello');
    expect(result.contentType).toBe('text/plain');
  });

  it('defaults inline content without a type to octet-stream', async () => {
    const result = await new AttachmentDownloader().download({
      content: Buffer.from('x').toString('base64'),
    } as Attachment);
    expect(result.contentType).toBe('application/octet-stream');
  });

  it('rejects an attachment with nothing to download, without naming it', async () => {
    await expect(
      new AttachmentDownloader().download({ contentType: 'application/pdf', name: 'poufne.pdf' }),
    ).rejects.toThrow(/^Attachment has no downloadable payload$/);
  });

  it.each([401, 403, 404, 500])(
    'rejects an HTTP %i download with the status only',
    async (status) => {
      const downloader = new AttachmentDownloader({
        fetcher: fetcherReturning({ statusCode: status }),
      });
      await expect(
        downloader.download({
          contentType: 'application/pdf',
          contentUrl: 'https://x.test/?sig=s',
        }),
      ).rejects.toThrow(`Attachment download failed with HTTP ${status}`);
    },
  );
});

describe('mimeFromExtension', () => {
  it.each([
    ['a.pdf', 'application/pdf'],
    ['a.png', 'image/png'],
    ['a.jpg', 'image/jpeg'],
    ['a.JPEG', 'image/jpeg'],
    ['a.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['a.csv', 'text/csv'],
    ['a.exe', undefined],
    [undefined, undefined],
    ['', undefined],
  ])('%p → %p', (name, mime) => {
    expect(mimeFromExtension(name)).toBe(mime);
  });
});
