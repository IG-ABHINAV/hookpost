/**
 * The shared tooltip (top.tip.tsx). On a touch screen it stayed up after a
 * tap and covered its neighbours; there it now closes on its own.
 *   pnpm exec jest -c apps/frontend/jest.config.ts top.tip
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const close = jest.fn();
let lastProps: Record<string, any> = {};
jest.mock('react-tooltip', () => {
  const R = require('react');
  return {
    Tooltip: R.forwardRef((props: Record<string, any>, ref: any) => {
      lastProps = props;
      R.useImperativeHandle(ref, () => ({ close }));
      return null;
    }),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ToolTip, canHover, TOUCH_HIDE_MS } = require('./top.tip');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mockMedia(matches: boolean) {
  const listeners: (() => void)[] = [];
  window.matchMedia = jest.fn(() => ({
    get matches() {
      return matches;
    },
    addEventListener: (_: string, l: () => void) => listeners.push(l),
    removeEventListener: jest.fn(),
  })) as unknown as typeof window.matchMedia;
  return {
    set(next: boolean) {
      matches = next;
      listeners.forEach((l) => l());
    },
  };
}

function render() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  act(() => createRoot(el).render(React.createElement(ToolTip)));
}

beforeEach(() => {
  close.mockReset();
  lastProps = {};
});

describe('ToolTip', () => {
  it('on a mouse or trackpad: the plain hover tooltip', () => {
    mockMedia(true);
    expect(canHover()).toBe(true);
    render();
    expect(lastProps.id).toBe('tooltip');
    expect(lastProps.globalCloseEvents).toBeUndefined();
    expect(lastProps.afterShow).toBeUndefined();
  });

  it('on a touch screen: closes on a tap elsewhere or a scroll', () => {
    mockMedia(false);
    expect(canHover()).toBe(false);
    render();
    expect(lastProps.id).toBe('tooltip');
    expect(lastProps.globalCloseEvents).toEqual(
      expect.objectContaining({ clickOutsideAnchor: true, scroll: true })
    );
  });

  it('on a touch screen: closes by itself after TOUCH_HIDE_MS, counted from the last tap', () => {
    jest.useFakeTimers();
    try {
      mockMedia(false);
      render();
      act(() => lastProps.afterShow());
      jest.advanceTimersByTime(TOUCH_HIDE_MS - 100);
      act(() => lastProps.afterShow());
      jest.advanceTimersByTime(TOUCH_HIDE_MS - 100);
      expect(close).not.toHaveBeenCalled();
      jest.advanceTimersByTime(200);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('follows a change of input (a tablet docked to a trackpad)', () => {
    const media = mockMedia(false);
    render();
    expect(lastProps.afterShow).toBeDefined();
    act(() => media.set(true));
    expect(lastProps.afterShow).toBeUndefined();
  });

  it('treats a browser without matchMedia as touch', () => {
    // @ts-expect-error simulate an old browser
    delete window.matchMedia;
    expect(canHover()).toBe(false);
  });
});
