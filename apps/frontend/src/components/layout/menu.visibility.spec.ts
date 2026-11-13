/**
 * Which menu items a user sees. The desktop rail and the phone tab bar both
 * go through isMenuItemVisible (top.menu.tsx useVisibleMenu), so they always
 * offer the same destinations.
 *   pnpm exec jest -c apps/frontend/jest.config.ts menu.visibility
 */
jest.mock('@hookpost/frontend/components/layout/user.context', () => ({ useUser: () => null }));
jest.mock('@hookpost/react/helpers/variable.context', () => ({ useVariables: () => ({}) }));
jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({ useT: () => (k: string, f: string) => f }));
jest.mock('@hookpost/frontend/components/new-layout/menu-item', () => ({ MenuItem: () => null }));
jest.mock('@hookpost/frontend/components/layout/new-modal', () => ({ useModals: () => ({}) }));
jest.mock('@hookpost/frontend/components/layout/agent.media.modal', () => ({ AgentMediaModal: () => null }));
jest.mock('@hookpost/frontend/components/layout/twa.component', () => ({ useIsTwa: () => false }));
jest.mock('@hookpost/frontend/components/layout/plan.limit.prompt', () => ({ aiLocked: () => false }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isMenuItemVisible } = require('./top.menu');

const web = { billingEnabled: true, isTwa: false, isLifetime: false, role: 'ADMIN' };

describe('isMenuItemVisible', () => {
  it('shows a plain item to everyone', () => {
    expect(isMenuItemVisible({ name: 'Media' }, web)).toBe(true);
  });

  it('hides an item marked hide', () => {
    expect(isMenuItemVisible({ name: 'Videos', hide: true }, web)).toBe(false);
  });

  it('hides billing-only items when billing is off', () => {
    const billing = { name: 'Billing', requireBilling: true };
    expect(isMenuItemVisible(billing, web)).toBe(true);
    expect(isMenuItemVisible(billing, { ...web, billingEnabled: false })).toBe(false);
  });

  it('hides priced items inside the Google Play app', () => {
    const earn = { name: 'Earn 30%', hideInTwa: true };
    expect(isMenuItemVisible(earn, web)).toBe(true);
    expect(isMenuItemVisible(earn, { ...web, isTwa: true })).toBe(false);
  });

  it('hides Billing from a lifetime deal', () => {
    expect(isMenuItemVisible({ name: 'Billing' }, { ...web, isLifetime: true })).toBe(false);
    expect(isMenuItemVisible({ name: 'Settings' }, { ...web, isLifetime: true })).toBe(true);
  });

  it('shows a role-limited item only to those roles', () => {
    const billing = { name: 'Billing', role: ['ADMIN', 'SUPERADMIN'] };
    expect(isMenuItemVisible(billing, web)).toBe(true);
    expect(isMenuItemVisible(billing, { ...web, role: 'USER' })).toBe(false);
    expect(isMenuItemVisible(billing, { ...web, role: undefined })).toBe(false);
  });
});
