/**
 * The super-admin Refunds page against a fake backend: the per-row Refund
 * dialog, the foreign-product confirmation, and the typed REFUND bulk action.
 *   pnpm exec jest -c apps/frontend/jest.config.ts admin-refunds
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

const mockFetch = jest.fn();
jest.mock('@hookpost/helpers/utils/custom.fetch', () => ({
  useFetch: () => mockFetch,
}));
jest.mock('@hookpost/frontend/components/layout/user.context', () => ({
  useUser: () => ({ id: 'u-admin', isSuperAdmin: true }),
}));
const mockToast = jest.fn();
jest.mock('@hookpost/react/toaster/toaster', () => ({
  useToaster: () => ({ show: mockToast }),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: any) =>
    require('react').createElement('a', { href, ...rest }, children),
}));
jest.mock('@hookpost/frontend/components/layout/loading', () => ({
  LoadingComponent: () => require('react').createElement('div', null, 'Loading'),
}));
jest.mock('@hookpost/react/form/button', () => ({
  Button: ({ children, loading, secondary, innerClassName, ...rest }: any) =>
    require('react').createElement('button', { type: 'button', ...rest }, children),
}));

import { AdminRefundsComponent } from '@hookpost/frontend/components/admin/admin-refunds.component';

const pay = (id: string, over: any = {}) => ({
  id,
  status: 'captured',
  amount: 59900,
  amountRefunded: 0,
  refundable: 59900,
  refundStatus: null,
  currency: 'INR',
  method: 'upi',
  email: `${id}@example.com`,
  description: null,
  international: false,
  createdAt: '2026-10-20T10:00:00.000Z',
  hookpost: true,
  service: 'hookpost',
  organizationId: 'org-1',
  organizationName: 'Acme',
  subscriptionId: 'sub_1',
  ...over,
});

const TEST = pay('pay_TqFWpXxKSIObH8', {
  amount: 100,
  refundable: 100,
  currency: 'USD',
  method: 'card',
  email: 'owner@hookstep.in',
  service: 'hookpost-test',
  organizationId: null,
  organizationName: null,
  subscriptionId: null,
});
const VET = pay('pay_VetNowPay00001', { hookpost: false, service: 'vetnow', organizationName: null });

const json = (body: any, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body });
let payments: any[] = [];
const posts: { url: string; body: any }[] = [];
let historyPages: Record<string, any> = {};
const gets: string[] = [];

const refundRow = (id: string, over: any = {}) => ({
  id,
  paymentId: 'pay_TqFWpXxKSIObH8',
  amount: 100,
  currency: 'USD',
  status: 'processed',
  createdAt: '2026-10-21T09:00:00.000Z',
  reference: null,
  paymentFound: true,
  paymentAmount: 100,
  email: 'owner@hookstep.in',
  description: null,
  madeFrom: 'dashboard',
  madeBy: null,
  reason: null,
  hookpost: true,
  service: 'hookpost-test',
  organizationId: null,
  organizationName: null,
  subscriptionId: null,
  ...over,
});
const historyPage = (refunds: any[], over: any = {}) => ({
  refunds,
  scanned: refunds.length,
  hidden: 0,
  nextSkip: refunds.length,
  hasMore: false,
  from: 1000,
  to: 2000,
  ...over,
});

beforeEach(() => {
  mockFetch.mockReset();
  mockToast.mockReset();
  posts.length = 0;
  gets.length = 0;
  payments = [TEST, VET];
  historyPages = {};
  mockFetch.mockImplementation(async (url: string, init?: any) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body);
      posts.push({ url, body });
      if (url === '/admin/refunds') {
        return json({
          paymentId: body.paymentId,
          status: 'refunded',
          amount: body.amount,
          currency: 'USD',
          refundId: 'rfnd_1',
          refundStatus: 'pending',
        });
      }
      return json({
        results: body.paymentIds.map((id: string) => ({
          paymentId: id,
          status: 'refunded',
          amount: 59900,
          currency: 'INR',
          refundId: `rfnd_${id}`,
          refundStatus: 'pending',
        })),
      });
    }
    gets.push(url);
    if (url.startsWith('/admin/refunds/audit')) return json({ available: true, rows: [] });
    if (url.startsWith('/admin/refunds/history')) {
      // The most specific match wins: 'scope=hookpost&skip=50' over 'scope=hookpost'.
      const key = Object.keys(historyPages)
        .sort((a, b) => b.length - a.length)
        .find((k) => url.includes(k));
      return json(key ? historyPages[key] : historyPage([]));
    }
    return json({ payments, scanned: payments.length, nextSkip: payments.length, hasMore: false, from: 0, to: 1 });
  });
});

const renderPage = () =>
  render(
    React.createElement(
      SWRConfig,
      { value: { provider: () => new Map(), dedupingInterval: 0 } },
      React.createElement(AdminRefundsComponent)
    )
  );

const rowOf = (paymentId: string) => screen.getByText(paymentId).closest('tr') as HTMLElement;

describe('Refunds page', () => {
  it('Refund on a row confirms amount, currency and customer, then sends exactly that amount', async () => {
    renderPage();
    await screen.findByText('pay_TqFWpXxKSIObH8');

    fireEvent.click(within(rowOf('pay_TqFWpXxKSIObH8')).getByText('Refund'));
    const dialog = screen.getByText('Refund this payment?').closest('div')!.parentElement!;
    expect(within(dialog).getByText('owner@hookstep.in')).toBeTruthy();
    expect(within(dialog).getAllByText('$1.00').length).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.click(within(dialog).getByText('Refund $1.00'));
    });
    expect(posts).toEqual([
      { url: '/admin/refunds', body: { paymentId: 'pay_TqFWpXxKSIObH8', amount: 100 } },
    ]);
    await screen.findByText('rfnd_1 (pending)');
    expect(mockToast).toHaveBeenCalledWith('Refunded $1.00 (rfnd_1)', 'success');
  });

  it('a partial amount is sent in cents; more than refundable cannot be sent', async () => {
    renderPage();
    await screen.findByText('pay_TqFWpXxKSIObH8');
    fireEvent.click(within(rowOf('pay_TqFWpXxKSIObH8')).getByText('Refund'));
    const dialog = screen.getByText('Refund this payment?').closest('div')!.parentElement!;
    const input = within(dialog).getByDisplayValue('1.00');

    fireEvent.change(input, { target: { value: '1.01' } });
    expect(within(dialog).getByText(/Enter an amount between/)).toBeTruthy();
    expect((within(dialog).getByText(/^Refund\s*$/) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: '0.40' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Refund $0.40'));
    });
    expect(posts[0].body).toEqual({ paymentId: 'pay_TqFWpXxKSIObH8', amount: 40 });
  });

  it("another product's payment cannot be refunded until the foreign confirmation is ticked", async () => {
    renderPage();
    await screen.findByText('pay_VetNowPay00001');
    expect(within(rowOf('pay_VetNowPay00001')).getByText('Other: vetnow')).toBeTruthy();

    fireEvent.click(within(rowOf('pay_VetNowPay00001')).getByText('Refund'));
    const send = screen.getByText('Refund ₹599.00') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByText(/Confirm foreign product payment/));
    expect(send.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(send);
    });
    expect(posts[0].body).toEqual({
      paymentId: 'pay_VetNowPay00001',
      amount: 59900,
      confirmForeign: true,
    });
  });

  it('bulk: needs REFUND typed, sends 20 ids per request, and adds up the result', async () => {
    payments = Array.from({ length: 25 }, (_, i) => pay(`pay_Bulk${String(i).padStart(10, '0')}`));
    renderPage();
    await screen.findByText('pay_Bulk0000000000');

    fireEvent.click(screen.getByLabelText('Select all refundable'));
    fireEvent.click(screen.getByText('Refund selected (25)'));
    expect(screen.getByText('₹14,975.00')).toBeTruthy();

    const go = screen.getByText('Refund 25') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Type REFUND to confirm'), { target: { value: 'refund' } });
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Type REFUND to confirm'), { target: { value: 'REFUND' } });
    expect(go.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(go);
    });
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts.map((p) => [p.url, p.body.paymentIds.length])).toEqual([
      ['/admin/refunds/bulk', 20],
      ['/admin/refunds/bulk', 5],
    ]);
    expect(posts[0].body.confirmForeign).toBeUndefined();
    await screen.findByText('25 refunded');
    expect(mockToast).toHaveBeenCalledWith('25 of 25 refunded', 'success');
  });
});

describe("Refunds page: the fee is deducted by default (owner, 29 Oct 2026)", () => {
  const withFee = () =>
    pay('pay_FeeOnThisPay01', { fee: 1414, tax: 216, refundableAfterFee: 58486 });

  it('the dialog shows the fee with its GST and the amount less the fee, and sends that by default', async () => {
    payments = [withFee()];
    renderPage();
    await screen.findByText('pay_FeeOnThisPay01');
    fireEvent.click(within(rowOf('pay_FeeOnThisPay01')).getByText('Refund'));
    expect(screen.getByTestId('refund-fee').textContent).toBe('₹14.14 (GST ₹2.16 included)');
    expect(screen.getByTestId('refund-after-fee').textContent).toBe('₹584.86');
    expect(screen.getByDisplayValue('584.86')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText('Refund ₹584.86'));
    });
    expect(posts[0].body).toEqual({ paymentId: 'pay_FeeOnThisPay01', amount: 58486 });
  });

  it('ticking Full refunds everything, fee included', async () => {
    payments = [withFee()];
    renderPage();
    await screen.findByText('pay_FeeOnThisPay01');
    fireEvent.click(within(rowOf('pay_FeeOnThisPay01')).getByText('Refund'));
    fireEvent.click(screen.getByLabelText('Full refund, our mistake'));
    expect(screen.getByDisplayValue('599.00')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText('Refund ₹599.00'));
    });
    expect(posts[0].body).toEqual({ paymentId: 'pay_FeeOnThisPay01', amount: 59900 });
  });

  it('bulk totals are less the fee unless Full is ticked, and Full is sent to the server', async () => {
    payments = [withFee(), pay('pay_FeeOnThisPay02', { fee: 1414, tax: 216, refundableAfterFee: 58486 })];
    renderPage();
    await screen.findByText('pay_FeeOnThisPay01');
    fireEvent.click(screen.getByLabelText('Select all refundable'));
    fireEvent.click(screen.getByText('Refund selected (2)'));
    expect(screen.getByText('₹1,169.72')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Full refund for every payment, our mistake'));
    expect(screen.getByText('₹1,198.00')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Type REFUND to confirm'), { target: { value: 'REFUND' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Refund 2'));
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body.full).toBe(true);
  });
});

describe('Refund history', () => {
  const history = () => screen.getByTestId('refund-history');

  it("lists Razorpay's refunds with where they were made, status, reference and who", async () => {
    historyPages['scope=hookpost'] = historyPage(
      [
        refundRow('rfnd_Dashboard0001', { reference: '529412345678', reason: 'asked by email' }),
        refundRow('rfnd_ThisTool00001', {
          madeFrom: 'tool',
          madeBy: 'second@hookstep.in',
          status: 'pending',
          createdAt: '2026-10-22T09:00:00.000Z',
        }),
        refundRow('rfnd_MandateAuto01', {
          madeFrom: 'other',
          status: 'failed',
          amount: 500,
          currency: 'INR',
          paymentFound: false,
          paymentAmount: null,
          email: null,
        }),
      ],
      { hidden: 2 }
    );
    renderPage();
    const dash = await screen.findByTestId('refund-row-rfnd_Dashboard0001');
    expect(within(dash).getByText('Razorpay dashboard')).toBeTruthy();
    expect(within(dash).getByText('Processed')).toBeTruthy();
    expect(within(dash).getByText(/ref 529412345678/)).toBeTruthy();
    expect(within(dash).getByText('asked by email')).toBeTruthy();
    expect(within(dash).getByText('Hookpost test')).toBeTruthy();

    const tool = screen.getByTestId('refund-row-rfnd_ThisTool00001');
    expect(within(tool).getByText('This tool')).toBeTruthy();
    expect(within(tool).getByText('Pending')).toBeTruthy();
    expect(within(tool).getByText('second@hookstep.in')).toBeTruthy();

    const auto = screen.getByTestId('refund-row-rfnd_MandateAuto01');
    expect(within(auto).getByText('Outside this tool')).toBeTruthy();
    expect(within(auto).getByText('Failed')).toBeTruthy();
    expect(within(auto).getByText('Unknown payment')).toBeTruthy();
    expect(within(auto).getByText('₹5.00')).toBeTruthy();

    // Newest first.
    const ids = within(history())
      .getAllByText(/^rfnd_/)
      .map((e) => e.textContent);
    expect(ids).toEqual(['rfnd_ThisTool00001', 'rfnd_Dashboard0001', 'rfnd_MandateAuto01']);
    expect(within(history()).getByText(/2 of another product or unidentified hidden/)).toBeTruthy();
  });

  it('All products asks for every refund and stops saying some are hidden', async () => {
    historyPages['scope=hookpost'] = historyPage([], { hidden: 1, scanned: 1, nextSkip: 1 });
    historyPages['scope=all'] = historyPage([
      refundRow('rfnd_VetNowRef0001', { hookpost: false, service: 'vetnow' }),
    ]);
    renderPage();
    await within(await screen.findByTestId('refund-history')).findByText(/No Hookpost refunds/);
    expect(within(history()).getByText(/1 of another product or unidentified hidden/)).toBeTruthy();

    fireEvent.click(screen.getByText('All products'));
    const vet = await screen.findByTestId('refund-row-rfnd_VetNowRef0001');
    expect(within(vet).getByText('Other: vetnow')).toBeTruthy();
    expect(within(history()).queryByText(/hidden/)).toBeNull();
    expect(gets).toContain('/admin/refunds/history?scope=all');
  });

  it('Load more asks for the next page inside the same pinned window and adds up what is hidden', async () => {
    historyPages['scope=hookpost'] = historyPage([refundRow('rfnd_Page1Row00001')], {
      hasMore: true,
      nextSkip: 50,
      hidden: 1,
    });
    historyPages['scope=hookpost&skip=50'] = historyPage([refundRow('rfnd_Page2Row00001', { createdAt: '2026-10-01T00:00:00.000Z' })], {
      nextSkip: 100,
      hidden: 3,
    });
    renderPage();
    await screen.findByTestId('refund-row-rfnd_Page1Row00001');
    await act(async () => {
      fireEvent.click(screen.getByText('Load more refunds'));
    });
    await screen.findByTestId('refund-row-rfnd_Page2Row00001');
    expect(gets).toContain('/admin/refunds/history?scope=hookpost&skip=50&to=2000');
    expect(within(history()).getByText(/4 of another product or unidentified hidden/)).toBeTruthy();
    expect(screen.queryByText('Load more refunds')).toBeNull();
  });

  it('a history that cannot be read says so; the payments still work', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('/admin/refunds/history')) return json({ message: 'Razorpay: fetch failed' }, false);
      if (url.startsWith('/admin/refunds/audit')) return json({ available: true, rows: [] });
      return json({ payments, scanned: 2, nextSkip: 2, hasMore: false, from: 0, to: 1 });
    });
    renderPage();
    await screen.findByText(/Could not load the refund history: Razorpay: fetch failed/);
    expect(screen.getByText('pay_TqFWpXxKSIObH8')).toBeTruthy();
  });

  it('a refund made here shows in its row and in the history at once, before Razorpay lists it', async () => {
    renderPage();
    await screen.findByText('pay_VetNowPay00001');
    expect(within(screen.getByTestId('refund-state-pay_VetNowPay00001')).getByText('Not refunded')).toBeTruthy();

    // Only refundable unticked, so the row stays on screen once refunded.
    fireEvent.click(screen.getByLabelText('Only refundable'));
    fireEvent.click(within(rowOf('pay_VetNowPay00001')).getByText('Refund'));
    const dialog = screen.getByText('Refund this payment?').closest('div')!.parentElement!;
    fireEvent.change(within(dialog).getByDisplayValue('599.00'), { target: { value: '100.00' } });
    fireEvent.click(screen.getByText(/Confirm foreign product payment/));
    await act(async () => {
      fireEvent.click(screen.getByText('Refund ₹100.00'));
    });

    const state = screen.getByTestId('refund-state-pay_VetNowPay00001');
    expect(within(state).getByText('Partly refunded')).toBeTruthy();
    expect(within(state).getByText('₹100.00 of ₹599.00 refunded · ₹499.00 left')).toBeTruthy();

    // The server (the mock) never lists it, and it is another product's: hidden under Hookpost...
    expect(screen.queryByTestId('refund-row-rfnd_1')).toBeNull();
    // ...and shown, as made here by nobody named (the test user has no email), under All products.
    fireEvent.click(screen.getByText('All products'));
    const local = await screen.findByTestId('refund-row-rfnd_1');
    expect(within(local).getByText('This tool')).toBeTruthy();
    expect(within(local).getByText('Pending')).toBeTruthy();
  });

  it('a full refund made here takes the row off the refundable list', async () => {
    renderPage();
    await screen.findByText('pay_TqFWpXxKSIObH8');
    fireEvent.click(within(rowOf('pay_TqFWpXxKSIObH8')).getByText('Refund'));
    const dialog = screen.getByText('Refund this payment?').closest('div')!.parentElement!;
    await act(async () => {
      fireEvent.click(within(dialog).getByText('Refund $1.00'));
    });
    await waitFor(() =>
      expect(screen.queryByTestId('refund-state-pay_TqFWpXxKSIObH8')).toBeNull()
    );
    // It is Hookpost's, so it is in the history straight away.
    const local = await screen.findByTestId('refund-row-rfnd_1');
    expect(within(local).getByText('$1.00')).toBeTruthy();
  });

  it('bulk refunds made here all land in the history', async () => {
    payments = [pay('pay_Bulk0000000000'), pay('pay_Bulk0000000001')];
    renderPage();
    await screen.findByText('pay_Bulk0000000000');
    fireEvent.click(screen.getByLabelText('Select all refundable'));
    fireEvent.click(screen.getByText('Refund selected (2)'));
    fireEvent.change(screen.getByLabelText('Type REFUND to confirm'), { target: { value: 'REFUND' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Refund 2'));
    });
    await screen.findByTestId('refund-row-rfnd_pay_Bulk0000000000');
    expect(screen.getByTestId('refund-row-rfnd_pay_Bulk0000000001')).toBeTruthy();
    // Both were refunded in full, so neither is refundable any more.
    expect(screen.queryByTestId('refund-state-pay_Bulk0000000000')).toBeNull();
  });

  it("a first page holding only other products' refunds still offers the next page", async () => {
    historyPages['scope=hookpost'] = historyPage([], { hidden: 50, scanned: 50, nextSkip: 50, hasMore: true });
    historyPages['scope=hookpost&skip=50'] = historyPage([refundRow('rfnd_OlderHookpost1')], { nextSkip: 51 });
    renderPage();
    await within(await screen.findByTestId('refund-history')).findByText(/on the pages scanned so far/);
    await act(async () => {
      fireEvent.click(screen.getByText('Load more refunds'));
    });
    await screen.findByTestId('refund-row-rfnd_OlderHookpost1');
  });

  it('once the server counts a refund made here, it is the server that says how much is refunded', async () => {
    renderPage();
    await screen.findByText('pay_TqFWpXxKSIObH8');
    fireEvent.click(screen.getByLabelText('Only refundable'));
    fireEvent.click(within(rowOf('pay_TqFWpXxKSIObH8')).getByText('Refund'));
    const dialog = screen.getByText('Refund this payment?').closest('div')!.parentElement!;
    // The server still reports the old figure on the reload that follows.
    await act(async () => {
      fireEvent.click(within(dialog).getByText('Refund $1.00'));
    });
    const state = () => screen.getByTestId('refund-state-pay_TqFWpXxKSIObH8');
    await waitFor(() => expect(within(state()).getByText('Fully refunded')).toBeTruthy());

    // Razorpay now counts it...
    payments = [{ ...TEST, status: 'refunded', amountRefunded: 100, refundable: 0 }, VET];
    await act(async () => {
      fireEvent.click(screen.getByText('🔄 Refresh'));
    });
    await waitFor(() => expect(within(state()).getByText('Fully refunded')).toBeTruthy());

    // ...and later the bank fails it and Razorpay gives the amount back: refundable again.
    payments = [TEST, VET];
    await act(async () => {
      fireEvent.click(screen.getByText('🔄 Refresh'));
    });
    await waitFor(() => expect(within(state()).getByText('Not refunded')).toBeTruthy());
    expect(within(state().closest('tr') as HTMLElement).getByText('Refund')).toBeTruthy();
  });
});
