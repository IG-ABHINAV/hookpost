/**
 * The calendar's customer filter: it shows which customer is picked and can
 * be cleared again.
 *   pnpm exec jest -c apps/frontend/jest.config.ts select.customer
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

// The real useT suspends until the locale files load
jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({
  useT: () => (_key: string, fallback: string) => fallback,
}));

import { SelectCustomer } from '@hookpost/frontend/components/launches/select.customer';

const integrations = [
  { id: 'i1', customer: { id: 'c-acme', name: 'Acme' } },
  { id: 'i2', customer: { id: 'c-globex', name: 'Globex' } },
] as any[];

const openMenu = (container: HTMLElement) =>
  fireEvent.click(container.querySelector('[data-tooltip-id="tooltip"]')!);

describe('calendar customer filter', () => {
  it('names the selected customer and offers All customers to clear it', () => {
    const onChange = jest.fn();
    const { container } = render(
      React.createElement(SelectCustomer, {
        integrations,
        customer: 'c-acme',
        onChange,
        withAllOption: true,
      })
    );
    expect(screen.getByText('Acme')).toBeTruthy();

    openMenu(container);
    fireEvent.click(screen.getByText('All customers'));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('marks All customers when no filter is set', () => {
    const { container } = render(
      React.createElement(SelectCustomer, {
        integrations,
        customer: null as any,
        onChange: jest.fn(),
        withAllOption: true,
      })
    );
    openMenu(container);
    const selected = (text: string) =>
      screen.getByText(text).classList.contains('bg-newBgColor');
    expect(selected('All customers')).toBe(true);
    expect(selected('Acme')).toBe(false);
    expect(selected('Globex')).toBe(false);
  });

  it('keeps the composer picker without a clear option', () => {
    const { container } = render(
      React.createElement(SelectCustomer, {
        integrations,
        onChange: jest.fn(),
      })
    );
    openMenu(container);
    expect(screen.queryByText('All customers')).toBeNull();
  });
});
