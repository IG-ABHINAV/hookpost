/**
 * Media retention after a plan ends (owner, 29 Oct 2026; MEDIA_RETENTION_POLICY
 * in trial.policy.ts, carried out by MediaRetentionService): /privacy, /terms
 * and /cancellation-policy state the same rule with the numbers the code
 * uses, and nothing still promises posts and media are kept forever.
 */
import React from 'react';
import { render } from '@testing-library/react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: any) => React.createElement('a', { href, ...rest }, children),
}));
jest.mock('@hookpost/frontend/app/(landing)/site-nav', () => ({ SiteNav: () => null }));

import PrivacyPage from '@hookpost/frontend/app/(landing)/privacy/page';
import TermsPage from '@hookpost/frontend/app/(landing)/terms/page';
import CancellationPolicyPage from '@hookpost/frontend/app/(landing)/cancellation-policy/page';
import {
  MEDIA_KEPT_LINE,
  MEDIA_RETENTION_AFTER_END_DAYS,
  MEDIA_RETENTION_POLICY,
  MEDIA_RETENTION_REMINDER_DAYS,
  PAUSED_WORKSPACE_LINE,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import { cancelDialogCopy } from '@hookpost/frontend/components/billing/cancel.copy';

const text = (page: any) => {
  const { container, unmount } = render(React.createElement(page));
  container.querySelectorAll('script').forEach((s) => s.remove());
  const out = (container.textContent || '').replace(/\s+/g, ' ');
  unmount();
  return out;
};

describe('the media retention rule on the legal pages', () => {
  it('names the 30 days, the 7-day reminder, what goes and what stays', () => {
    expect(MEDIA_RETENTION_AFTER_END_DAYS).toBe(30);
    expect(MEDIA_RETENTION_REMINDER_DAYS).toBe(7);
    expect(MEDIA_RETENTION_POLICY).toContain('for 30 days from the day we email its owner');
    expect(MEDIA_RETENTION_POLICY).toContain('reminder 7 days before');
    expect(MEDIA_RETENTION_POLICY).toMatch(/scheduled, draft and failed posts and the files in its media library/);
    expect(MEDIA_RETENTION_POLICY).toMatch(/unless another workspace uses them/);
    expect(MEDIA_RETENTION_POLICY).toMatch(/Post text, published posts and their pictures, connected channels and settings stay/);
    expect(MEDIA_RETENTION_POLICY).toMatch(/Choosing a plan before the date keeps everything/);
  });

  it.each([
    ['/privacy', PrivacyPage],
    ['/terms', TermsPage],
    ['/cancellation-policy', CancellationPolicyPage],
  ])('%s states it word for word', (_path, page) => {
    expect(text(page)).toContain(MEDIA_RETENTION_POLICY);
  });

  it('no customer copy still says posts are kept "until you choose a plan" without the media limit', () => {
    expect(PAUSED_WORKSPACE_LINE).toContain(MEDIA_KEPT_LINE);
    expect(MEDIA_KEPT_LINE).toBe('your channels and posts are kept, and their media files for 30 days');
    const copy = cancelDialogCopy({ isTrial: false, freePlan: false, refunded: true, tierName: 'Standard' });
    expect(copy).toContain(MEDIA_KEPT_LINE);
  });
});
