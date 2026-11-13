/**
 * The three places that tell people what deleting an account does - the
 * public /data-deletion page, section 8 of the privacy policy and the in-app
 * dialog - must say the same thing, and only what the code does.
 *   pnpm exec jest -c apps/frontend/jest.config.ts deletion-texts
 */
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: any) =>
    React.createElement('a', { href, ...rest }, children),
}));

jest.mock('@hookpost/helpers/utils/custom.fetch', () => ({ useFetch: () => jest.fn() }));
jest.mock('@hookpost/react/helpers/delete.dialog', () => ({ deleteDialog: jest.fn() }));
jest.mock('@hookpost/react/form/button', () => ({
  Button: (props: any) =>
    React.createElement('button', { onClick: props.onClick }, props.children),
}));
jest.mock('@hookpost/react/helpers/variable.context', () => ({
  useVariables: () => ({ isSecured: true }),
}));
jest.mock('@hookpost/frontend/components/layout/layout.context', () => ({ setCookie: jest.fn() }));
jest.mock('@hookpost/react/toaster/toaster', () => ({ useToaster: () => ({ show: jest.fn() }) }));
jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({
  useT: () => (_key: string, fallback: string) => fallback,
}));
jest.mock('@hookpost/frontend/components/ui/icons', () => ({ TrashIcon: () => null }));

import DataDeletionPage from '@hookpost/frontend/app/(landing)/data-deletion/page';
import PrivacyPolicyPage from '@hookpost/frontend/app/(landing)/privacy/page';
import DeleteAccountComponent from '@hookpost/frontend/components/settings/delete-account.component';
import { deleteDialog } from '@hookpost/react/helpers/delete.dialog';

/** Rendered text, JSON-LD scripts left out, whitespace collapsed. */
const rendered = (page: () => React.ReactElement) => {
  const { container, unmount } = render(React.createElement(page));
  container.querySelectorAll('script').forEach((s) => s.remove());
  const out = {
    text: (container.textContent || '').replace(/\s+/g, ' '),
    hrefs: Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href')),
  };
  unmount();
  return out;
};

const deletion = rendered(DataDeletionPage as any);
const privacy = rendered(PrivacyPolicyPage as any);
const deletionPage = deletion.text;
const privacyPage = privacy.text;
const section8 = privacyPage.slice(privacyPage.indexOf('8. Data Retention'), privacyPage.indexOf('9. Security'));

describe('the /data-deletion page', () => {
  it('lists what happens at once: sign-out, revoked apps and keys, cancelled posts', () => {
    expect(deletionPage).toContain('You are signed out everywhere');
    expect(deletionPage).toContain('API key of every workspace you own stop working');
    expect(deletionPage).toMatch(/Approved Apps.*is revoked and its tokens are erased/);
    expect(deletionPage).toContain('Nothing more is published');
    expect(deletionPage).toContain('RSS auto-posts and channel token refreshes are cancelled');
    expect(deletionPage).toContain('your referral code stops working');
  });

  it('describes the Razorpay cancellation as the request it is, and how to check', () => {
    expect(deletionPage).toContain('we ask our payment provider, Razorpay, to cancel your subscription at once');
    expect(deletionPage).toContain('even if Razorpay does not confirm');
    expect(deletionPage).not.toMatch(/it is cancelled with our payment provider/);
  });

  it('says the hashed email goes to Meta only', () => {
    expect(deletionPage).toContain('Meta also receives a one-way hash of your email address');
    expect(deletionPage).toContain('Google does not receive your email address');
    expect(deletionPage).not.toMatch(/Meta and Google receive[^.]*hashed email/);
  });

  it('promises the 30-day purge, and says when file links stop working', () => {
    expect(deletionPage).toContain('erased for good 30 days after you delete your account');
    expect(deletionPage).toContain('their links on media.hookstep.in stop working then');
    expect(deletionPage).toContain('A fingerprint of each connected channel');
    expect(deletionPage).not.toContain('Hookpost hides deleted things instead of erasing them');
  });

  it('covers every Page a Facebook login connected', () => {
    expect(deletionPage).toContain('including every Page picked in the same sign-in');
    expect(deletionPage).toContain('names, usernames, picture links and IDs Meta gave us');
  });

  it('names Hookstep and support@hookstep.in, nothing about source code or the legal entity', () => {
    expect(deletionPage).toContain('Hookstep');
    expect(deletionPage).toContain('support@hookstep.in');
    expect(deletionPage).not.toMatch(/open[ -]?source|github|postiz|gitroom|JR Consulting/i);
  });
});

describe('privacy policy section 8', () => {
  it('describes deletion like the /data-deletion page and links to it', () => {
    expect(section8).toContain('you are signed out');
    expect(section8).toContain('scheduled posts are cancelled');
    expect(section8).toContain('Data Deletion');
    expect(section8).toContain('purged or anonymised 30 days after deletion');
    expect(section8).toContain('deleted from our storage 30 days after you delete your account');
    expect(privacy.hrefs).toContain('/data-deletion');
  });
});

describe('the in-app delete-account dialog', () => {
  it('says what happens at once, links to the details, and never says "permanently"', () => {
    const { container } = render(React.createElement(DeleteAccountComponent));
    const shown = container.textContent || '';
    expect(shown).toContain('Signs you out, revokes your channel and app connections and cancels scheduled posts at once; everything else is erased 30 days later.');
    expect(shown).not.toMatch(/permanently/i);
    const link = container.querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/data-deletion#what-we-keep');
  });

  it('asks for confirmation with the same facts', async () => {
    (deleteDialog as jest.Mock).mockResolvedValueOnce(false);
    const { container } = render(React.createElement(DeleteAccountComponent));
    await act(async () => {
      fireEvent.click(container.querySelector('button') as HTMLButtonElement);
    });
    const [message] = (deleteDialog as jest.Mock).mock.calls[0];
    expect(message).toContain('you are signed out, your channel and app connections are revoked and nothing more is published');
    expect(message).toContain('everything else is erased 30 days later');
    expect(message).toContain('This cannot be undone.');
  });
});
