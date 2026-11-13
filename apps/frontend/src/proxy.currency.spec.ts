/**
 * @jest-environment node
 *
 * The proxy no longer guesses a currency: no hookpost_currency cookie and no
 * x-hookpost-* headers, whatever x-country or cf-ipcountry say. The backend
 * decides (services/billing.currency.ts).
 *   pnpm exec jest -c apps/frontend/jest.config.ts
 */
import { NextRequest } from 'next/server';
import { proxy } from '@hookpost/frontend/proxy';

const get = (path: string, headers: Record<string, string> = {}) =>
  proxy(new NextRequest(`https://hookpost.hookstep.in${path}`, { headers }));

describe('proxy: no currency guessing', () => {
  it.each([
    ['/', { 'cf-ipcountry': 'US' }],
    ['/pricing', { 'x-country': 'IN' }],
    ['/pricing', { 'cf-ipcountry': 'IN', cookie: 'hookpost_currency=USD' }],
  ])('%s with %p sets no currency cookie', async (path, headers) => {
    const res = await get(path, headers as Record<string, string>);
    expect(res.headers.get('set-cookie') || '').not.toContain('hookpost_currency');
    expect(res.headers.get('x-middleware-request-x-hookpost-currency')).toBeNull();
    expect(res.headers.get('x-middleware-request-x-hookpost-country')).toBeNull();
  });
});
