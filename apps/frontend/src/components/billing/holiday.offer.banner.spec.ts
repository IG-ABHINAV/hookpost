// The festival banner as rendered (holiday.offer.banner.tsx): today's theme,
// $7/month, the countdown, "Claim offer", the 24-hour close, the hero pill
// and glow. No particles or emoji art in any of it.
//   pnpm exec jest -c apps/frontend/jest.config.ts holiday.offer.banner
import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import {
  FestivalPill,
  HeroGlow,
  HolidayOfferBanner,
  HolidayOfferStrip,
} from './holiday.offer.banner';
import { BANNER_DISMISS_KEY, BANNER_DISMISS_MS } from './holiday.offer';

const ist = (s: string) => Date.parse(`${s}+05:30`);

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

describe('HolidayOfferStrip (homepage, /pricing)', () => {
  it('winter: the offer at $7/month, a countdown to the real end, Claim offer, no rupees, no snow', () => {
    jest.useFakeTimers({ now: ist('2026-12-12T09:00:00') });
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;
    const { getByTestId, getByText, container } = render(
      React.createElement(HolidayOfferStrip, { initialKey: 'winter' })
    );
    const strip = getByTestId('holiday-offer');
    expect(strip.getAttribute('data-festival')).toBe('winter');
    expect(strip.textContent).toContain(
      'Winter offer — every channel, every feature for $7/month'
    );
    expect(getByTestId('holiday-offer-countdown').textContent).toBe('Offer ends in 2d 14h');
    expect(getByText('Claim offer').getAttribute('href')).toBe('/auth');
    expect(container.querySelector('[data-testid="snowfall"]')).toBeNull();
    expect(container.textContent).not.toMatch(/[\u{1F300}-\u{1FAFF}\u2744]/u); // no emoji
    expect(container.textContent).not.toMatch(/₹|INR|trial|lifetime/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('Christmas week: the Christmas theme, even on a page built in November', () => {
    jest.useFakeTimers({ now: ist('2026-12-20T12:00:00') });
    const { getByTestId } = render(
      React.createElement(HolidayOfferStrip, { initialKey: 'winter' })
    );
    expect(getByTestId('holiday-offer').getAttribute('data-festival')).toBe('christmas');
    expect(getByTestId('holiday-offer').textContent).toContain('Christmas offer');
  });

  it('closing it hides it for 24 hours and remembers that', () => {
    jest.useFakeTimers({ now: ist('2026-11-09T12:00:00') });
    const { queryByTestId, getByLabelText } = render(
      React.createElement(HolidayOfferStrip, { initialKey: 'winter' })
    );
    fireEvent.click(getByLabelText('Close the offer banner for a day'));
    expect(queryByTestId('holiday-offer')).toBeNull();
    expect(Number(localStorage.getItem(BANNER_DISMISS_KEY))).toBe(ist('2026-11-09T12:00:00'));
    cleanup();
    // still closed an hour later
    jest.setSystemTime(ist('2026-11-09T13:00:00'));
    expect(
      render(React.createElement(HolidayOfferStrip, { initialKey: 'winter' })).queryByTestId(
        'holiday-offer'
      )
    ).toBeNull();
    cleanup();
    // back after 24 hours
    jest.setSystemTime(ist('2026-11-09T12:00:00') + BANNER_DISMISS_MS);
    expect(
      render(React.createElement(HolidayOfferStrip, { initialKey: 'winter' })).queryByTestId(
        'holiday-offer'
      )
    ).not.toBeNull();
  });

  it('the countdown ticks with the clock', () => {
    jest.useFakeTimers({ now: ist('2026-12-14T20:39:00') });
    const { getByTestId } = render(
      React.createElement(HolidayOfferStrip, { initialKey: 'winter' })
    );
    expect(getByTestId('holiday-offer-countdown').textContent).toBe('Offer ends in 3h 20m');
    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(getByTestId('holiday-offer-countdown').textContent).toBe('Offer ends in 3h 19m');
  });

  it('a festival still to come shows without a countdown; nothing after the calendar', () => {
    jest.useFakeTimers({ now: ist('2027-01-07T12:00:00') });
    const gap = render(React.createElement(HolidayOfferStrip, { initialKey: 'new-year' }));
    expect(gap.getByTestId('holiday-offer').getAttribute('data-festival')).toBe('lohri-sankranti');
    expect(gap.queryByTestId('holiday-offer-countdown')).toBeNull();
    cleanup();
    jest.setSystemTime(ist('2027-04-01T00:00:00'));
    expect(
      render(React.createElement(HolidayOfferStrip, { initialKey: 'holi' })).container.textContent
    ).toBe('');
  });
});

describe('hero accents', () => {
  it('a "Winter offer" pill and a glow in the theme colours, switching with the calendar', () => {
    jest.useFakeTimers({ now: ist('2026-11-20T12:00:00') });
    const pill = render(React.createElement(FestivalPill, { initialKey: 'winter' }));
    expect(pill.getByTestId('festival-pill').textContent).toBe('Winter offer$7/month');
    const glow = render(React.createElement(HeroGlow, { initialKey: 'winter' }));
    const el = glow.getByTestId('festival-glow');
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.style.getPropertyValue('--f-glow')).toBe('#2f7bff');
    cleanup();
    jest.setSystemTime(ist('2027-03-20T12:00:00'));
    const holi = render(React.createElement(HeroGlow, { initialKey: 'holi' }));
    expect(holi.getByTestId('festival-glow').getAttribute('data-festival')).toBe('holi');
    cleanup();
    jest.setSystemTime(ist('2027-04-01T00:00:00'));
    expect(
      render(React.createElement(HeroGlow, { initialKey: 'holi' })).queryByTestId('festival-glow')
    ).toBeNull();
  });
});

describe('HolidayOfferBanner (in-app Plans)', () => {
  it("names today's festival, $7/month and the countdown", () => {
    jest.useFakeTimers({ now: ist('2027-01-26T10:00:00') });
    const { getByTestId } = render(React.createElement(HolidayOfferBanner));
    expect(getByTestId('holiday-offer').textContent).toContain(
      'Republic Day offer — every channel, every feature for $7/month'
    );
    expect(getByTestId('holiday-offer-countdown').textContent).toMatch(/^Offer ends in /);
  });
});
