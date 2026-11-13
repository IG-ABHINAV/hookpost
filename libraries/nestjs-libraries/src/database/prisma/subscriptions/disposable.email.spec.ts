import { disposableEmail, disposableDomainCount } from './disposable.email';
import { DISPOSABLE_ALLOWLIST } from './disposable-email/allowlist';

// The vendored open-source list (owner, 29 Oct 2026, item 12).
describe('disposableEmail: the vendored disposable-email-domains list', () => {
  it('holds the full list, read once at load', () => {
    expect(disposableDomainCount()).toBeGreaterThan(3000);
  });

  it.each([
    'x@mailinator.com',
    'x@guerrillamail.com',
    'x@10minutemail.com',
    'x@yopmail.com',
    'x@sharklasers.com',
    'x@trashmail.com',
    'x@dispostable.com',
    'X@MAILINATOR.COM',
    ' x@mailinator.com ',
    'x@sub.mailinator.com',
    'x@mailinator.com.',
  ])('%s is disposable', (email) => {
    expect(disposableEmail(email)).toBe(true);
  });

  it.each([
    'x@gmail.com',
    'x@googlemail.com',
    'x@yahoo.com',
    'x@outlook.com',
    'x@icloud.com',
    'x@proton.me',
    'x@rediffmail.com',
    'x@hookstep.in',
    'mailinator@gmail.com',
    'x@not-mailinator.example',
    'x@mailinator.com.evil.example',
    'x@com',
    'x@',
    '',
    null,
    undefined,
  ])('%p is not disposable', (email) => {
    expect(disposableEmail(email as any)).toBe(false);
  });

  it('the allow-list wins over the list, for the domain and its subdomains', () => {
    jest.isolateModules(() => {
      jest.doMock('./disposable-email/allowlist', () => ({ DISPOSABLE_ALLOWLIST: ['mailinator.com'] }));
      const isolated = require('./disposable.email');
      expect(isolated.disposableEmail('x@mailinator.com')).toBe(false);
      expect(isolated.disposableEmail('x@a.mailinator.com')).toBe(false);
      expect(isolated.disposableEmail('x@yopmail.com')).toBe(true);
    });
  });

  it('the shipped allow-list holds only well-formed domains', () => {
    for (const d of DISPOSABLE_ALLOWLIST) expect(d).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
  });
});
