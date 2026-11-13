import { filterWorkspaces, marketplaceLine, membersLabel, roleLabel, WorkspaceView } from './workspaces.view';

const billing = { state: 'needs_trial', label: 'Needs trial', detail: '', at: null, planState: null } as any;
const w = (over: Partial<WorkspaceView>): WorkspaceView => ({
  id: 'o',
  name: 'W',
  source: 'DIRECT',
  sourceLabel: 'Direct',
  createdAt: '2026-10-27T04:49:00.000Z',
  members: 1,
  owner: null,
  channels: 0,
  posts: 0,
  billing,
  marketplace: null,
  ...over,
});

const rows = [
  w({ id: 'o1', name: 'Salon Design', owner: 'sales@salon.example' }),
  w({ id: 'o2', name: 'apimkt social', source: 'API_MARKET', sourceLabel: 'api.market', members: 0, marketplace: { marketplace: 'api.market', subscriber: 'usr_…c2', product: 'social', plan: 'trial', status: 'ACTIVE', lastCallAt: null, calls7d: 0 } }),
  w({ id: 'o3', name: 'RapidAPI buyer', source: 'RAPIDAPI', sourceLabel: 'RapidAPI', members: 0 }),
];

describe('filterWorkspaces', () => {
  it('by source (the clicked chip), or all', () => {
    expect(filterWorkspaces(rows, null).map((r) => r.id)).toEqual(['o1', 'o2', 'o3']);
    expect(filterWorkspaces(rows, 'DIRECT').map((r) => r.id)).toEqual(['o1']);
    expect(filterWorkspaces(rows, 'API_MARKET').map((r) => r.id)).toEqual(['o2']);
    expect(filterWorkspaces(rows, 'RAPIDAPI').map((r) => r.id)).toEqual(['o3']);
  });

  it('by name, owner, masked subscriber or a whole id', () => {
    expect(filterWorkspaces(rows, null, 'SALON').map((r) => r.id)).toEqual(['o1']);
    expect(filterWorkspaces(rows, null, 'sales@').map((r) => r.id)).toEqual(['o1']);
    expect(filterWorkspaces(rows, null, 'usr_').map((r) => r.id)).toEqual(['o2']);
    expect(filterWorkspaces(rows, null, 'o3').map((r) => r.id)).toEqual(['o3']);
    expect(filterWorkspaces(rows, 'DIRECT', 'apimkt')).toEqual([]);
  });
});

describe('labels', () => {
  it('role and members in plain words', () => {
    expect(roleLabel('SUPERADMIN')).toBe('Owner');
    expect(roleLabel('ADMIN')).toBe('Admin');
    expect(roleLabel('USER')).toBe('Member');
    expect(roleLabel(undefined)).toBe('Member');
    expect(membersLabel(1)).toBe('1 member');
    expect(membersLabel(0)).toBe('0 members');
    expect(membersLabel(3)).toBe('3 members');
  });

  it('a marketplace line: product, plan, status, calls in 7 days, last call in IST', () => {
    expect(marketplaceLine(null)).toBeNull();
    expect(
      marketplaceLine({ marketplace: 'api.market', subscriber: 'usr_…c2', product: 'social', plan: 'pro', status: 'ACTIVE', lastCallAt: '2026-10-27T03:00:00.000Z', calls7d: 12 })
    ).toBe('social · pro · active · 12 calls in 7 days · last call 27 Oct 2026, 08:30 IST');
    expect(
      marketplaceLine({ marketplace: 'RapidAPI', subscriber: 'x…', product: 'social', plan: 'basic', status: 'BLOCKED', lastCallAt: null, calls7d: 1 })
    ).toBe('social · basic · blocked · 1 call in 7 days · never called');
  });
});

describe('disputeLine', () => {
  it('names the chargeback and its reason, and nothing for other workspaces', () => {
    const { disputeLine } = require('@hookpost/frontend/components/admin/workspaces.view');
    expect(disputeLine(null)).toBeNull();
    expect(disputeLine(undefined)).toBeNull();
    const line = disputeLine({ at: '2026-10-29T11:26:00Z', reason: 'chargeback', paymentId: 'pay_1' });
    expect(line).toMatch(/^Chargeback /);
    expect(line).toContain('chargeback');
  });
});
