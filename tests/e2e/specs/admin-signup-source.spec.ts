/**
 * The Source column on the super-admin Users page (/admin/users): where each
 * sign-up came from (utm source / medium, ad click id, or the referrer's
 * host such as claude.ai for the Claude directory) beside the workspace's
 * marketplace source, and the search finding users by it.
 *
 * Every account is a test account made here; the first touch is the hp_attr
 * cookie the marketing pages write, sent with the sign-up.
 */
import { expect, test } from '@playwright/test';
import { control, failOnServerErrors, signUpViaApi } from './support';

test.describe('admin users page: sign-up source', () => {
  test('each row names its source, and the search finds users by it', async ({ page, browser }) => {
    const errors = failOnServerErrors(page);
    const signUp = async (attribution?: Record<string, unknown>) => {
      const context = await browser.newContext();
      const { email } = await signUpViaApi(context, { country: 'US', attribution });
      await context.close();
      return email;
    };
    const claude = await signUp({ referrer: 'https://claude.ai/', landing_path: '/auth' });
    const ads = await signUp({
      utm_source: 'meta',
      utm_medium: 'paid_social',
      utm_campaign: 'hp_e2e_campaign',
      referrer: 'https://l.facebook.com/',
      landing_path: '/mcp',
    });
    const direct = await signUp();

    const admin = await signUpViaApi(page.context());
    await control.givePlan(admin.email, 'STANDARD');
    await control.makeSuperAdmin(admin.email);
    await page.goto('/admin/users');

    await expect(page.getByRole('columnheader', { name: 'Source' })).toBeVisible();
    const sourceOf = (email: string) =>
      page.getByRole('row').filter({ hasText: email }).locator('[data-testid^="user-source-"]').first();

    await expect(sourceOf(claude).getByTestId('user-source-label')).toHaveText('claude.ai');
    await expect(sourceOf(claude)).toContainText('/auth');
    await expect(sourceOf(claude).getByTestId('user-source-marketplace')).toHaveText('Direct');
    await expect(sourceOf(ads).getByTestId('user-source-label')).toHaveText('meta / hp_e2e_campaign');
    await expect(sourceOf(ads)).toContainText('/mcp');
    await expect(sourceOf(direct).getByTestId('user-source-label')).toHaveText('direct');

    // Clicking the source opens the user's panel with the sign-up in plain words.
    await sourceOf(claude).click();
    const panel = page.getByTestId('signup-details');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('signup-Source')).toHaveText('claude.ai');
    await expect(panel.getByTestId('signup-Came from (referrer)')).toHaveText('claude.ai');
    await expect(panel.getByTestId('signup-First page')).toHaveText('/auth');
    await expect(panel.getByTestId('signup-Country')).toHaveText(/^US/);
    await expect(panel.getByTestId('signup-Signed up with')).toHaveText('LOCAL');
    await expect(panel.getByTestId('signup-Signed up at')).toHaveText(/^\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} IST$/);
    await expect(panel.getByTestId('signup-First channel connected')).toHaveText('Never');
    await expect(panel.getByTestId('signup-Channels / posts')).toHaveText('0 channels, 0 posts');
    await expect(panel.getByTestId('signup-Last checkout')).not.toBeEmpty();
    await page.getByRole('button', { name: '✕', exact: true }).click();
    await expect(panel).toHaveCount(0);

    // Find every Claude-directory sign-up by typing the source.
    await page.getByPlaceholder(/Search by email/).fill('claude.ai');
    await expect(page.getByRole('row').filter({ hasText: claude })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: ads })).toHaveCount(0);
    await expect(page.getByRole('row').filter({ hasText: direct })).toHaveCount(0);
    await page.getByPlaceholder(/Search by email/).fill('hp_e2e_campaign');
    await expect(page.getByRole('row').filter({ hasText: ads })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: claude })).toHaveCount(0);

    errors.assertNone();
  });
});
