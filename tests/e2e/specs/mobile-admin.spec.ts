/**
 * The Super Admin portal on a phone, measured. Runs in the iphone / iphone-se
 * (WebKit) and android (Chromium) projects (playwright.config.ts), at the
 * device's own width and again at 320px (the narrowest phone in use).
 *
 * The owner's Android phone (~390px, 1 Nov 2026) showed the admin pages
 * broken: the super-admin bar's buttons ran off the right edge, wide tables
 * squeezed every column to a few characters, filter fields wider than the
 * screen. What each admin page must do on a phone:
 *  - no app rail; the phone tab bar instead;
 *  - nothing scrolls the page sideways, and nothing in it sits past the edge
 *    unless it is inside its own sideways scroller that ends on screen;
 *  - the super-admin bar wraps: search box and every button on screen;
 *  - the section tabs are one row that scrolls sideways;
 *  - a table is a list of cards: no header row, every cell on screen.
 *
 * Seed data (one super admin, channels, an error, a contact message, a
 * payment) is written once, through the API and the E2E control port.
 */
import { BrowserContext, expect, Page, test } from '@playwright/test';
import { BACKEND, control, invisibleText, PASSWORD, setLightTheme, uniqueEmail } from './support';

const PAGES = [
  '/admin/users',
  '/admin/stats',
  '/admin/errors',
  '/admin/contact',
  '/admin/refunds',
  '/admin/marketplaces',
  '/admin/affiliates',
];

let email = '';
let auth = '';

test.beforeAll(async () => {
  // A long address, so the users table has something that does not fit.
  email = uniqueEmail('mobile-admin.with-a-rather-long-address');
  const res = await fetch(`${BACKEND}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, company: 'Sunrise Coaching Academy Private Limited', provider: 'LOCAL' }),
  });
  expect(res.status, 'register').toBe(200);
  auth = decodeURIComponent(
    (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('auth='))!.slice(5)
  );
  await fetch(`${BACKEND}/user/self`, { headers: { cookie: `auth=${auth}` } });
  await control.makeSuperAdmin(email);
  await control.givePlan(email, 'PRO');
  for (const [provider, name] of [
    ['x', 'Sunrise Coaching'],
    ['linkedin', 'Sunrise Coaching Academy Official Page'],
    ['youtube', 'Sunrise Coaching Academy Channel'],
  ]) {
    await control.addChannel(email, provider, name);
  }
  await control.errorLog(email, {
    platform: 'x',
    message: 'Unknown Error: {"title":"Forbidden","detail":"You are not permitted to perform this action.","type":"about:blank","status":403}',
  });
  // Its own IP: the contact form takes one message per IP per minute.
  await fetch(`${BACKEND}/public/contact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${Math.floor(Math.random() * 200) + 1}` },
    body: JSON.stringify({
      name: 'Priya Raghunathan',
      email: 'priya.raghunathan.coaching@hookpost-test.invalid',
      topic: 'billing',
      message: 'Hello, I was charged twice for my Standard plan this month. Could you look into it and refund one of them?',
    }),
  });
  await control.razorpayPayment({ email, amount: 59900 });
});

// WebKit does not keep Secure cookies on http://localhost (mobile-layout.spec.ts).
async function signIn(context: BrowserContext, browserName: string) {
  const common = { domain: 'localhost', path: '/', secure: browserName !== 'webkit', sameSite: 'Lax' as const };
  await context.addCookies([
    { name: 'auth', value: auth, httpOnly: true, ...common },
    { name: 'hp_logged_in', value: '1', httpOnly: false, ...common },
  ]);
}

/** Boxes past either edge of the screen, outside a sideways scroller that ends on screen. */
async function offScreen(page: Page, scope: string) {
  return page.evaluate((scope) => {
    const vw = window.innerWidth;
    const inScroller = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== 'visible') {
          const r = p.getBoundingClientRect();
          return r.left >= -1 && r.right <= vw + 1;
        }
      }
      return false;
    };
    return [...document.querySelectorAll(`${scope} *`)]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (r.right > vw + 1 || r.left < -1) && !inScroller(el);
      })
      .slice(0, 5)
      .map((el) => `${el.tagName} "${(el.textContent || '').trim().slice(0, 40)}" ${Math.round(el.getBoundingClientRect().left)}..${Math.round(el.getBoundingClientRect().right)}`);
  }, scope);
}

async function checkAdminPage(page: Page, path: string) {
  await page.goto(path);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  const nav = page.getByRole('navigation', { name: 'Admin sections' });
  await expect(nav).toBeVisible();
  // Let SWR fill the page before measuring.
  await page.waitForLoadState('networkidle');
  const vw = page.viewportSize()!.width;

  // The app shell: no rail, the phone tab bar.
  await expect(page.locator('#left-menu')).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Main menu' })).toBeVisible();

  // Nothing scrolls the page sideways.
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, 'page width').toBeLessThanOrEqual(innerWidth);

  // The super-admin bar wraps: the search box and every button are on screen.
  const bar = page.getByTestId('admin-bar');
  const search = bar.locator('input[name="impersonate"]');
  await expect(search).toBeVisible();
  const controls = [search, ...(await bar.getByTestId('admin-bar-actions').locator('> *').all())];
  expect(controls.length, 'bar buttons').toBeGreaterThan(3);
  for (const c of controls) {
    const b = (await c.boundingBox())!;
    expect(b.x, `${await c.textContent()} starts on screen`).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width, `${await c.textContent()} ends on screen`).toBeLessThanOrEqual(vw + 0.5);
  }
  expect(await offScreen(page, '[data-testid="admin-bar"]')).toEqual([]);

  // Section tabs: one row, scrolling sideways inside a box that fits.
  const tabs = nav.getByRole('link');
  await expect(tabs).toHaveCount(PAGES.length);
  const first = (await tabs.nth(0).boundingBox())!;
  const last = (await tabs.nth(PAGES.length - 1).boundingBox())!;
  expect(Math.abs(first.y - last.y), 'tabs in one row').toBeLessThan(2);
  const navBox = (await nav.boundingBox())!;
  expect(navBox.x + navBox.width).toBeLessThanOrEqual(vw + 0.5);
  expect(await nav.evaluate((el) => getComputedStyle(el).overflowX)).toBe('auto');
  await expect(nav.locator('[aria-current="page"]')).toHaveAttribute('href', path);
  // The current tab is scrolled into view within the row.
  await expect
    .poll(async () => {
      const t = (await nav.locator('[aria-current="page"]').boundingBox())!;
      return t.x >= navBox.x - 0.5 && t.x + t.width <= navBox.x + navBox.width + 0.5;
    }, { message: 'current tab visible in the row' })
    .toBe(true);

  // Everything in the page fits (or sits in its own scroller that does).
  expect(await offScreen(page, 'main')).toEqual([]);

  // Tables are cards: no header row, every cell on screen.
  for (const table of await page.locator('main table').all()) {
    if (!(await table.isVisible())) continue;
    await expect(table.locator('thead')).toBeHidden();
    for (const td of (await table.locator('tbody td').all()).slice(0, 40)) {
      const b = await td.boundingBox();
      if (!b || !b.width) continue;
      expect(b.x).toBeGreaterThanOrEqual(-0.5);
      expect(b.x + b.width).toBeLessThanOrEqual(vw + 0.5);
    }
  }
}

test.describe('admin portal on a phone', () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(!isMobile, 'phone projects only');
  });

  for (const path of PAGES) {
    test(`${path} fits the phone`, async ({ page, context, browserName }) => {
      await signIn(context, browserName);
      await checkAdminPage(page, path);
    });

    test(`${path} fits a 320px phone`, async ({ page, context, browserName }) => {
      await signIn(context, browserName);
      await page.setViewportSize({ width: 320, height: 640 });
      await checkAdminPage(page, path);
    });
  }

  test('/admin opens Users & Billing', async ({ page, context, browserName }) => {
    await signIn(context, browserName);
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/users$/);
    await expect(page.getByRole('navigation', { name: 'Admin sections' })).toBeVisible();
  });

  test('users: each user is a card with its email whole on screen', async ({ page, context, browserName }) => {
    await signIn(context, browserName);
    await page.goto('/admin/users');
    const cell = page.locator('main table tbody td', { hasText: email }).first();
    await expect(cell).toBeVisible();
    const vw = page.viewportSize()!.width;
    const b = (await cell.boundingBox())!;
    // A card spans most of the screen, not a 40px column.
    expect(b.width).toBeGreaterThan(vw * 0.6);
    const text = page.locator('main table tbody').getByText(email, { exact: true }).first();
    const t = (await text.boundingBox())!;
    expect(t.x + t.width).toBeLessThanOrEqual(vw + 0.5);
    // The other columns are labelled lines of the same card.
    await expect(page.locator('main table tbody td[data-label="Billing state"]').first()).toBeVisible();
  });

  test('errors: an error is a card with its actions on screen', async ({ page, context, browserName }) => {
    await signIn(context, browserName);
    await page.goto('/admin/errors');
    const row = page.getByTestId('error-row').first();
    await expect(row).toBeVisible();
    const vw = page.viewportSize()!.width;
    for (const name of ['View', 'Copy']) {
      const b = (await row.getByRole('button', { name }).boundingBox())!;
      expect(b.x + b.width).toBeLessThanOrEqual(vw + 0.5);
    }
  });
});

test.describe('admin portal on a computer is unchanged', () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(isMobile, 'desktop-layout only');
  });

  test('rail, one-row super-admin bar, tables with header rows', async ({ page, context, browserName }) => {
    await signIn(context, browserName);
    await page.goto('/admin/users');
    await expect(page.locator('#left-menu')).toBeVisible();
    const bar = (await page.getByTestId('admin-bar').locator('> div').boundingBox())!;
    expect(bar.height).toBeLessThanOrEqual(53);
    await expect(page.locator('main table thead').first()).toBeVisible();
    await page.goto('/admin/errors');
    await expect(page.getByText('Message', { exact: true })).toBeVisible();
  });
});

/**
 * Light mode (2 Nov 2026 sweep): the admin pages hard-coded white text and
 * navy panels, so with the light theme the titles, the current tab, the
 * numbers and the user drawer were white on white. Every text in the page
 * must differ from what is behind it.
 */
test.describe('admin portal in light mode', () => {
  for (const path of PAGES) {
    test(`${path}: no text is the colour of what is behind it`, async ({ page, context, browserName }) => {
      await signIn(context, browserName);
      await setLightTheme(context, browserName);
      await page.goto(path);
      await expect(page.locator('body')).toHaveClass(/light/);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('main h1').first()).toBeVisible();
      expect(await invisibleText(page)).toEqual([]);
    });
  }

  test('the user journey drawer reads in light mode', async ({ page, context, browserName }) => {
    await signIn(context, browserName);
    await setLightTheme(context, browserName);
    await page.goto('/admin/users');
    await page.getByRole('button', { name: 'View full lifecycle journey' }).first().click();
    // The journey drawer: the user's name heading and the SUPERADMIN badge again.
    const drawer = page.getByTestId('journey-drawer');
    await expect(drawer.getByText(email)).toBeVisible();
    await page.waitForLoadState('networkidle');
    // Labels too: they inherit the drawer's colour (it is a portal on <body>).
    expect(await invisibleText(page, '[data-testid="journey-drawer"]')).toEqual([]);
    // A long email wraps inside the drawer instead of running off a phone.
    expect(await offScreen(page, '[data-testid="journey-drawer"]')).toEqual([]);
  });
});

test.describe('admin stats range', () => {
  test('"Today" is labelled as one UTC day, not today to tomorrow', async ({ page, context, browserName }) => {
    await signIn(context, browserName);
    await page.goto('/admin/stats');
    const label = page.getByTestId('stats-range');
    await expect(label).toBeVisible();
    await expect(label).toHaveText(/^[^—]+ \(UTC\)$/);
    await page.getByRole('button', { name: 'Last 7 days' }).click();
    await expect(label).toHaveText(/ — .+ \(UTC\)$/);
  });
});
