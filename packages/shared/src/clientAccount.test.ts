import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLIENT_ACCOUNT_DOMAIN,
  clientAccountVerdict,
  type ClientAccountVerdict,
} from './clientAccount';

interface Case {
  readonly name: string;
  readonly userType: string | null;
  readonly userPrincipalName: string | null;
  readonly rowNip: string;
  readonly domain: string;
  readonly verdict: ClientAccountVerdict;
}

/**
 * The one case table the runtime and the binding tool (`tools/lib/bindings.mjs`,
 * `tools/test/bindings.test.mjs`) both test. Change both sides or neither.
 */
const table = JSON.parse(
  readFileSync(join(__dirname, '../../../tools/test/client-account-cases.json'), 'utf8'),
) as { readonly domain: string; readonly cases: readonly Case[] };

describe('clientAccountVerdict', () => {
  it('uses the domain the binding tool uses', () => {
    expect(CLIENT_ACCOUNT_DOMAIN).toBe(table.domain);
  });

  it('has cases for every verdict', () => {
    const verdicts = new Set(table.cases.map((c) => c.verdict));
    expect([...verdicts].sort()).toEqual([
      'client',
      'guest',
      'not_member',
      'row_nip_invalid',
      'upn_mismatch',
    ]);
  });

  it.each(table.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(
      clientAccountVerdict(
        { userType: c.userType, userPrincipalName: c.userPrincipalName },
        c.rowNip,
        c.domain,
      ),
    ).toBe(c.verdict);
  });

  it('defaults the domain to CLIENT_ACCOUNT_DOMAIN', () => {
    const account = { userType: 'Member', userPrincipalName: '1111111111@bcr-group.pl' };
    expect(clientAccountVerdict(account, '1111111111')).toBe('client');
    expect(clientAccountVerdict(account, '1111111111', 'contoso.example')).toBe('upn_mismatch');
    expect(clientAccountVerdict({ userType: 'Member' }, '1111111111')).toBe('upn_mismatch');
    expect(clientAccountVerdict({}, '1111111111')).toBe('not_member');
  });
});
