/**
 * Synthetic IR-0 traces: pino lines as the pre-Phase-0 ingestion wrote them,
 * wrapped the way App Insights stores them (JSON in `message`). Fake ids only.
 */

import { LEGACY_MESSAGES as M } from '../lib/misfiled.mjs';

const g = (s) => `00000000-0000-4000-8000-${s.padStart(12, '0')}`;
// Uploader object ids: synthetic, but valid GUIDs, as real oids are.
export const U1 = g('f001');
export const U2 = g('f002');
export const U3 = g('f003');
export const U4 = g('f004');
export const U5 = g('f005');
export const U6 = g('f006');
export const HOST = 'https://contoso.sharepoint.com';

/** A pino line as the ingestion wrote it. */
export function line(ms, msg, fields = {}) {
  return {
    timestamp: new Date(Date.parse('2026-09-01T10:00:00Z') + ms).toISOString(),
    message: JSON.stringify({ level: 30, msg, ...fields }),
  };
}

/**
 * Six uploads that cover the join:
 *  d1  fallback, uploader known by conversation
 *  d2  fallback then promoted into client 0002
 *  d3  directory, uploader known by client
 *  d4  directory, two uploaders of the same client within the window → ambiguous
 *  d6  an admin user, routed to fallback
 *  d7  an upload with no "client resolved" line
 */
export function traces() {
  return [
    line(0, M.noDirectoryMatch, { conversationId: 'conv1', userAadObjectId: U1 }),
    line(3, M.clientResolved, { invocationId: 'inv1', conversationId: 'conv1', resolution: 'fallback', clientId: 'FALLBACK', sitePath: '/sites/BCRGROUP' }),
    line(900, M.uploaded, { invocationId: 'inv1', conversationId: 'conv1', filename: 'a.pdf', driveItemId: 'd1', webUrl: `${HOST}/sites/BCRGROUP/Shared%20Documents/98_Nieposortowane/a.pdf` }),

    line(10_000, M.noDirectoryMatch, { conversationId: 'conv2', userAadObjectId: U2 }),
    line(10_002, M.clientResolved, { invocationId: 'inv2', conversationId: 'conv2', resolution: 'fallback', clientId: 'FALLBACK', sitePath: '/sites/BCRGROUP' }),
    line(10_500, M.classified, { invocationId: 'inv2', filename: 'b.pdf', folderPath: '01_Faktury/x' }),
    line(10_600, M.promoted, { clientId: '0002' }),
    line(10_601, M.refined, { invocationId: 'inv2', filename: 'b.pdf', clientId: '0002', resolution: 'directory', sitePath: '/sites/0002CLIENTB', promotedFromFallback: true, folderPath: '01_Faktury/01_Faktury_sprzedaży/2026/09' }),
    line(11_000, M.uploaded, { invocationId: 'inv2', filename: 'b.pdf', driveItemId: 'd2', webUrl: `${HOST}/sites/0002CLIENTB/Shared%20Documents/01_Faktury/b.pdf` }),

    line(20_000, M.routedByUser, { userAadObjectId: U3, clientId: '0001' }),
    line(20_001, M.clientResolved, { invocationId: 'inv3', conversationId: 'conv3', resolution: 'directory', clientId: '0001', sitePath: '/sites/0001CLIENTA' }),
    line(21_000, M.uploaded, { invocationId: 'inv3', filename: 'c.pdf', driveItemId: 'd3', webUrl: `${HOST}/sites/0001CLIENTA/Shared%20Documents/c.pdf` }),

    line(30_000, M.routedByUser, { userAadObjectId: U4, clientId: '0001' }),
    line(30_001, M.routedByUser, { userAadObjectId: U5, clientId: '0001' }),
    line(30_002, M.clientResolved, { invocationId: 'inv4', conversationId: 'conv4', resolution: 'directory', clientId: '0001', sitePath: '/sites/0001CLIENTA' }),
    line(30_500, M.uploaded, { invocationId: 'inv4', filename: 'd.pdf', driveItemId: 'd4', webUrl: `${HOST}/sites/0001CLIENTA/Shared%20Documents/d.pdf` }),

    line(40_000, M.adminMatch, { userAadObjectId: U6, clientId: 'BCR' }),
    line(40_001, M.noDirectoryMatch, { conversationId: 'conv6', userAadObjectId: U6 }),
    line(40_002, M.clientResolved, { invocationId: 'inv6', conversationId: 'conv6', resolution: 'fallback', clientId: 'FALLBACK', sitePath: '/sites/BCRGROUP' }),
    line(40_500, M.uploaded, { invocationId: 'inv6', filename: 'e.pdf', driveItemId: 'd6', webUrl: `${HOST}/sites/BCRGROUP/Shared%20Documents/e.pdf` }),

    line(50_000, M.uploaded, { invocationId: 'inv7', filename: 'f.pdf', driveItemId: 'd7', webUrl: `${HOST}/sites/0009OTHER/Shared%20Documents/f.pdf` }),
    { timestamp: '2026-09-01T11:00:00Z', message: 'Executing function' },
  ];
}
