/**
 * The emailed link's token leaves the address bar (it signs in whoever uses
 * it, and analytics scripts read the URL); a reload of the clean address
 * still finds it in the tab (review of f4bee956b, 25 Oct 2026).
 */
import {
  ACTIVATION_CODE_KEY,
  ACTIVATION_CONFIRM_PATH,
  forgetActivationCode,
  takeActivationCode,
} from '@hookpost/frontend/components/auth/activation.link';

const memory = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
};
const throwing = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

describe('takeActivationCode', () => {
  it('takes the token from the address and keeps it in the tab', () => {
    const s = memory();
    expect(takeActivationCode('eyJ.abc.def', s)).toBe('eyJ.abc.def');
    expect(s.data.get(ACTIVATION_CODE_KEY)).toBe('eyJ.abc.def');
  });

  it('on the clean address (a reload), finds it in the tab', () => {
    const s = memory();
    takeActivationCode('eyJ.abc.def', s);
    expect(takeActivationCode('confirm', s)).toBe('eyJ.abc.def');
  });

  it('nothing in the address or the tab: none', () => {
    expect(takeActivationCode('confirm', memory())).toBeNull();
    expect(takeActivationCode(undefined, memory())).toBeNull();
    expect(takeActivationCode(['a', 'b'], memory())).toBeNull();
  });

  it('blocked storage still works for the link itself', () => {
    expect(takeActivationCode('eyJ.abc.def', throwing)).toBe('eyJ.abc.def');
    expect(takeActivationCode('confirm', throwing)).toBeNull();
    expect(() => forgetActivationCode(throwing)).not.toThrow();
  });

  it('forgets it once used', () => {
    const s = memory();
    takeActivationCode('eyJ.abc.def', s);
    forgetActivationCode(s);
    expect(takeActivationCode('confirm', s)).toBeNull();
  });

  it('the clean address carries no token', () => {
    expect(ACTIVATION_CONFIRM_PATH).toBe('/auth/activate/confirm');
  });
});
