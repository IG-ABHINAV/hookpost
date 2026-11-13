import { maskSubscriber, workspaceRow } from './admin.workspaces';

const billing = { state: 'needs_trial', label: 'Needs trial', detail: '', at: null, planState: 'needs_trial' } as any;
const label = (id: string) => (id === 'API_MARKET' ? 'api.market' : id === 'RAPIDAPI' ? 'RapidAPI' : id);

describe('maskSubscriber', () => {
  it('hides the middle of a marketplace buyer id, whatever its length', () => {
    expect(maskSubscriber('usr_8f3a9d1e2b77c2')).toBe('usr_…c2');
    expect(maskSubscriber('jane_doe')).toBe('ja…e');
    expect(maskSubscriber('abcd')).toBe('a…');
    expect(maskSubscriber('  ')).toBe('—');
    expect(maskSubscriber(null)).toBe('—');
    expect(maskSubscriber('usr_8f3a9d1e2b77c2')).not.toContain('8f3a9d1e2b77');
  });
});

describe('workspaceRow', () => {
  const base = {
    id: 'org-1',
    name: 'Acme',
    createdAt: new Date('2026-10-27T04:49:00Z'),
    members: 2,
    owner: 'owner@example.com',
    channels: 1,
    posts: 4,
    billing,
  };

  it('a direct workspace: Direct, no marketplace block', () => {
    expect(workspaceRow({ ...base, source: 'DIRECT' }, label)).toEqual({
      id: 'org-1',
      name: 'Acme',
      source: 'DIRECT',
      sourceLabel: 'Direct',
      createdAt: '2026-10-27T04:49:00.000Z',
      members: 2,
      owner: 'owner@example.com',
      channels: 1,
      posts: 4,
      billing,
      marketplace: null,
      // No chargeback on file (the dispute block the chargeback work added).
      dispute: null,
    });
    expect(workspaceRow({ ...base, source: null }, label).source).toBe('DIRECT');
  });

  it('a marketplace subscriber: masked id, product, plan, status, last call, calls in 7 days', () => {
    const row = workspaceRow(
      {
        ...base,
        members: 0,
        owner: null,
        source: 'API_MARKET',
        account: {
          id: 'acc-1',
          marketplace: 'API_MARKET',
          externalUserId: 'usr_8f3a9d1e2b77c2',
          product: 'social',
          plan: 'trial',
          status: 'ACTIVE',
          lastSeenAt: new Date('2026-10-27T03:00:00Z'),
        },
        calls7d: 12,
      },
      label
    );
    expect(row.sourceLabel).toBe('api.market');
    expect(row.marketplace).toEqual({
      marketplace: 'api.market',
      subscriber: 'usr_…c2',
      product: 'social',
      plan: 'trial',
      status: 'ACTIVE',
      lastCallAt: '2026-10-27T03:00:00.000Z',
      calls7d: 12,
    });
    expect(JSON.stringify(row)).not.toContain('8f3a9d1e2b77');
  });

  it('a marketplace account with no recorded calls reads 0, and no last call is null', () => {
    const row = workspaceRow(
      {
        ...base,
        source: 'RAPIDAPI',
        account: { id: 'a', marketplace: 'RAPIDAPI', externalUserId: 'x', product: 'social', plan: 'basic', status: 'ACTIVE', lastSeenAt: null },
      },
      label
    );
    expect(row.marketplace).toMatchObject({ marketplace: 'RapidAPI', calls7d: 0, lastCallAt: null, subscriber: 'x…' });
  });
});
