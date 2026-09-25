/**
 * A synthetic tenant for driving `directory-bindings.mjs` end to end.
 *
 * Rows of the Client Directory:
 *   1  client A  — clean: private team, standard channel, one eligible guest,
 *                  ingestion write grant readable → PATCH
 *   2  client B  — a staff (Member) id on the row, site permissions
 *                  unreadable → SKIP until confirmed and verified. Its Team
 *                  predates onboarding: no "BCR Group —" description, which
 *                  is a warning only
 *   3  admin row — IsAdmin → SKIP
 *   4  client C  — Public team → SKIP
 *   5  inactive  — not examined
 *
 * Guests A and B are also in a security group that is not a Team; it must
 * not count against them. The "multi" guest is in Teams A and C, so it is
 * bound to neither. `memberOf` reports whether a group is a Team only when
 * `resourceProvisioningOptions` is selected, as Graph does.
 *
 * All identifiers are fake: `00000000-0000-4000-8000-…` GUIDs, NIPs
 * `000000000x`, `contoso.sharepoint.com`.
 */

import { fakeFetch, jsonResponse, notFound } from './fake-graph.mjs';

const g = (suffix) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const HOST = 'contoso.sharepoint.com';

export const IDS = Object.freeze({
  host: HOST,
  dirSite: `${HOST},${g('d01')},${g('d02')}`,
  list: g('d03'),
  ingestApp: g('e1'),
  otherApp: g('e2'),
  teamA: g('a001'),
  teamB: g('a002'),
  teamC: g('a003'),
  teamStaff: g('a0ff'),
  groupNotTeam: g('a0ee'),
  guestA: g('b001'),
  guestB: g('b002'),
  guestMulti: g('b003'),
  staff: g('c001'),
  ownerA: g('c002'),
  siteA: `${HOST},${g('5a1')},${g('5a2')}`,
  siteB: `${HOST},${g('5b1')},${g('5b2')}`,
  siteC: `${HOST},${g('5c1')},${g('5c2')}`,
  siteStaff: `${HOST},${g('5f1')},${g('5f2')}`,
  driveA: 'b!fakeDriveA',
  driveB: 'b!fakeDriveB',
  driveC: 'b!fakeDriveC',
  channelA: '19:fakechannela@thread.tacv2',
  channelB: '19:fakechannelb@thread.tacv2',
  channelC: '19:fakechannelc@thread.tacv2',
});

const CHANNEL = 'Dokumenty księgowe';

function initialItems() {
  const base = { Status: 'Active', SiteHostname: HOST, DriveName: 'Dokumenty', RootFolder: '' };
  return new Map([
    ['1', { ...base, Title: 'Client A', ClientId: '0001', NIP: '0000000001', SitePath: '/sites/0001CLIENTA' }],
    [
      '2',
      {
        ...base,
        Title: 'Client B',
        ClientId: '0002',
        NIP: '0000000002',
        SitePath: '/sites/0002CLIENTB',
        UserAadObjectIds: `${IDS.staff}\n${IDS.guestB}`,
      },
    ],
    ['3', { Status: 'Active', Title: 'BCR staff', ClientId: 'BCR', IsAdmin: true, UserAadObjectIds: IDS.staff }],
    ['4', { ...base, Title: 'Client C', ClientId: '0003', NIP: '0000000003', SitePath: '/sites/0003CLIENTC' }],
    ['5', { ...base, Status: 'Inactive', Title: 'Old', ClientId: '0009', SitePath: '/sites/0009OLD' }],
  ]);
}

export function createTenant() {
  const state = {
    items: initialItems(),
    columns: [
      { id: 'c1', name: 'Title', displayName: 'Title', text: {} },
      { id: 'c2', name: 'RootFolder', displayName: 'RootFolder', text: {} },
    ],
  };

  const users = new Map([
    [IDS.guestA, { id: IDS.guestA, userType: 'Guest', userPrincipalName: 'guest.a_example.com#EXT#@contoso.onmicrosoft.com' }],
    [IDS.guestB, { id: IDS.guestB, userType: 'Guest', userPrincipalName: 'guest.b_example.com#EXT#@contoso.onmicrosoft.com' }],
    [IDS.guestMulti, { id: IDS.guestMulti, userType: 'Guest', userPrincipalName: 'guest.m_example.com#EXT#@contoso.onmicrosoft.com' }],
    [IDS.staff, { id: IDS.staff, userType: 'Member', userPrincipalName: 'staff@contoso.example' }],
    [IDS.ownerA, { id: IDS.ownerA, userType: 'Member', userPrincipalName: 'owner@contoso.example' }],
  ]);
  const teams = [
    { id: IDS.teamA, displayName: '0001 Client A', description: 'BCR Group — 0001', visibility: 'Private' },
    { id: IDS.teamB, displayName: '0002 Client B', description: '', visibility: 'Private' },
    { id: IDS.teamC, displayName: '0003 Client C', description: 'BCR Group — 0003', visibility: 'Public' },
    { id: IDS.teamStaff, displayName: 'BCR GROUP', description: 'BCR staff team', visibility: 'Private' },
  ].map((t) => ({ ...t, resourceProvisioningOptions: ['Team'] }));
  const securityGroup = {
    id: IDS.groupNotTeam,
    displayName: 'All client guests',
    description: 'security group',
    resourceProvisioningOptions: [],
  };

  const sites = new Map([
    ['/sites/0001CLIENTA', { id: IDS.siteA, team: IDS.teamA, drive: IDS.driveA, channel: IDS.channelA }],
    ['/sites/0002CLIENTB', { id: IDS.siteB, team: IDS.teamB, drive: IDS.driveB, channel: IDS.channelB }],
    ['/sites/0003CLIENTC', { id: IDS.siteC, team: IDS.teamC, drive: IDS.driveC, channel: IDS.channelC }],
    ['/sites/BCRGROUP', { id: IDS.siteStaff, team: IDS.teamStaff, drive: 'b!fakeDriveStaff' }],
  ]);
  const siteById = new Map([...sites].map(([path, s]) => [s.id, { ...s, path }]));
  const siteByTeam = new Map([...sites].map(([path, s]) => [s.team, { ...s, path }]));
  const byDrive = new Map([...sites].map(([path, s]) => [s.drive, { ...s, path }]));

  const members = new Map([
    [IDS.teamA, [IDS.guestA, IDS.guestMulti, IDS.staff, IDS.ownerA]],
    [IDS.teamB, [IDS.guestB, IDS.staff]],
    [IDS.teamC, [IDS.guestMulti]],
    [IDS.teamStaff, [IDS.staff, IDS.ownerA]],
    [IDS.groupNotTeam, [IDS.guestA, IDS.guestB]],
  ]);
  const owners = new Map([
    [IDS.teamA, [IDS.ownerA]],
    [IDS.teamB, [IDS.staff]],
    [IDS.teamC, [IDS.staff]],
    [IDS.teamStaff, [IDS.ownerA]],
  ]);
  const permissions = new Map([
    [IDS.siteA, [{ id: 'p1', roles: ['write'], grantedToIdentitiesV2: [{ application: { id: IDS.ingestApp } }] }]],
    [IDS.siteB, 'forbidden'],
    [IDS.siteC, [{ id: 'p3', roles: ['write'], grantedToIdentitiesV2: [{ application: { id: IDS.ingestApp } }] }]],
  ]);

  const listBase = `/sites/${IDS.dirSite}/lists/${IDS.list}`;
  const userOut = (id) => ({ '@odata.type': '#microsoft.graph.user', ...users.get(id), displayName: id.slice(-4) });

  const handler = ({ method, path, query, body }) => {
    let m;
    if (method === 'GET' && path === `${listBase}/items`) {
      return jsonResponse(200, {
        value: [...state.items].map(([id, fields]) => ({ id, fields: { ...fields } })),
      });
    }
    if ((m = path.match(new RegExp(`^${escape(listBase)}/items/(\\d+)/fields$`)))) {
      const fields = state.items.get(m[1]);
      if (!fields) return notFound();
      if (method === 'PATCH') {
        Object.assign(fields, body);
        return jsonResponse(200, { ...fields });
      }
      return jsonResponse(200, { ...fields });
    }
    if (path === `${listBase}/columns`) {
      if (method === 'POST') {
        state.columns.push({ id: `c${state.columns.length + 1}`, name: body.name, displayName: body.displayName, text: body.text });
        return jsonResponse(201, body);
      }
      return jsonResponse(200, { value: state.columns });
    }
    if (method !== 'GET') return undefined;
    if (path === '/groups' && String(query.get('$filter')).includes('resourceProvisioningOptions')) {
      return jsonResponse(200, { value: teams });
    }
    if ((m = path.match(/^\/groups\/([^/]+)\/sites\/root$/))) {
      const s = siteByTeam.get(m[1]);
      return s ? jsonResponse(200, { id: s.id, webUrl: `https://${HOST}${s.path}` }) : notFound();
    }
    if ((m = path.match(/^\/groups\/([^/]+)\/(members|owners)$/))) {
      const ids = (m[2] === 'members' ? members : owners).get(m[1]) ?? [];
      return jsonResponse(200, { value: ids.map(userOut) });
    }
    if ((m = path.match(/^\/users\/([^/]+)\/memberOf$/))) {
      const withKind = String(query.get('$select')).includes('resourceProvisioningOptions');
      const groups = [...teams, securityGroup].filter((t) => (members.get(t.id) ?? []).includes(m[1]));
      return jsonResponse(200, {
        value: groups.map((t) => ({
          '@odata.type': '#microsoft.graph.group',
          id: t.id,
          displayName: t.displayName,
          description: t.description,
          ...(withKind ? { resourceProvisioningOptions: t.resourceProvisioningOptions } : {}),
        })),
      });
    }
    if ((m = path.match(/^\/users\/([^/]+)$/))) {
      return users.has(m[1]) ? jsonResponse(200, userOut(m[1])) : notFound('user');
    }
    if ((m = path.match(/^\/sites\/([^/:]+):(\/sites\/[^/]+)$/))) {
      const s = sites.get(m[2]);
      return s ? jsonResponse(200, { id: s.id, webUrl: `https://${m[1]}${m[2]}` }) : notFound('site');
    }
    if ((m = path.match(/^\/sites\/([^/]+)\/drives$/))) {
      const s = siteById.get(m[1]);
      if (!s) return notFound();
      return jsonResponse(200, {
        value: [
          { id: s.drive, name: 'Dokumenty', driveType: 'documentLibrary' },
          { id: `${s.drive}-assets`, name: 'Zasoby witryny', driveType: 'documentLibrary' },
        ],
      });
    }
    if ((m = path.match(/^\/sites\/([^/]+)\/permissions$/))) {
      const p = permissions.get(m[1]);
      if (p === 'forbidden') {
        return jsonResponse(403, { error: { code: 'accessDenied', message: 'Access denied' } });
      }
      return jsonResponse(200, { value: p ?? [] });
    }
    if ((m = path.match(/^\/teams\/([^/]+)\/channels$/))) {
      const s = siteByTeam.get(m[1]);
      return jsonResponse(200, {
        value: [
          { id: `19:general-${m[1].slice(-4)}@thread.tacv2`, displayName: 'General', membershipType: 'standard' },
          ...(s?.channel ? [{ id: s.channel, displayName: CHANNEL, membershipType: 'standard' }] : []),
        ],
      });
    }
    if ((m = path.match(/^\/teams\/([^/]+)\/channels\/([^/]+)\/filesFolder$/))) {
      const s = siteByTeam.get(m[1]);
      if (!s || s.channel !== m[2]) return notFound();
      return jsonResponse(200, {
        id: `FOLDER-${s.drive}`,
        name: CHANNEL,
        parentReference: { driveId: s.drive, driveType: 'documentLibrary' },
      });
    }
    if ((m = path.match(/^\/drives\/([^/]+)\/root$/))) {
      return byDrive.has(m[1]) ? jsonResponse(200, { id: `ROOT-${m[1]}` }) : notFound();
    }
    if ((m = path.match(/^\/drives\/([^/]+)\/items\/([^/]+)$/))) {
      if (!byDrive.has(m[1]) || m[2] !== `FOLDER-${m[1]}`) return notFound();
      return jsonResponse(200, {
        id: m[2],
        name: CHANNEL,
        parentReference: { driveId: m[1], id: `ROOT-${m[1]}`, path: `/drives/${m[1]}/root:` },
      });
    }
    return undefined;
  };

  const { fetch, calls } = fakeFetch(handler);
  return { fetch, calls, state, IDS };
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
