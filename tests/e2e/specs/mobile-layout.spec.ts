/**
 * Phone layout of the signed-in app, measured rather than eyeballed. Runs in
 * the iphone / iphone-se (WebKit) and android (Chromium) projects, plus
 * desktop-layout at 1440px for what must not change on a computer
 * (playwright.config.ts).
 *
 * What it guards (31 Oct 2026 UI pass):
 *  - the nav rail becomes a bottom tab bar on phones, and nothing hides
 *    under it or under the home indicator;
 *  - no page scrolls sideways;
 *  - no field is under 16px on a touch screen (iPhone zooms into those);
 *  - the composer's actions stay on screen and are not covered;
 *  - month view shows all seven days; settings tabs scroll as a row;
 *  - post actions are reachable without hover;
 *  - the super-admin bar's boxes show their whole placeholder at 320, 375
 *    and 393px, impersonating or not (2 Nov 2026: "Select user to switch to"
 *    was cut to "Select use" on a 320px phone).
 */
import { expect, Page, test, BrowserContext } from '@playwright/test';
import { BACKEND, control, invisibleText, PASSWORD, setLightTheme, uniqueEmail } from './support';

/** A new email/password account, not signed in anywhere: its email and session token. */
async function register(tag = 'mobile') {
  const email = uniqueEmail(tag);
  const res = await fetch(`${BACKEND}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, company: 'Sunrise Coaching Academy', provider: 'LOCAL' }),
  });
  const auth = (res.headers.getSetCookie?.() || [])
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith('auth='))
    ?.slice(5);
  expect(res.status, 'register').toBe(200);
  await fetch(`${BACKEND}/user/self`, { headers: { cookie: `auth=${auth}` } });
  return { email, auth: decodeURIComponent(auth!) };
}

// WebKit does not keep Secure cookies on http://localhost, so the phone
// projects get the same session cookies without the flag (the browser is the
// only thing that reads it; the backend checks the token).
function sessionCookie(browserName: string, name: string, value: string, httpOnly = true) {
  return { name, value, httpOnly, domain: 'localhost', path: '/', secure: browserName !== 'webkit', sameSite: 'Lax' as const };
}

async function signUp(context: BrowserContext, browserName: string, tag = 'mobile') {
  const { email, auth } = await register(tag);
  await context.addCookies([
    sessionCookie(browserName, 'auth', auth),
    sessionCookie(browserName, 'hp_logged_in', '1', false),
  ]);
  return { email, auth };
}

async function workspace(context: BrowserContext, browserName: string) {
  const { email } = await signUp(context, browserName);
  await control.givePlan(email, 'PRO');
  for (const [provider, name] of [
    ['bluesky', 'sunrise.bsky.social'],
    ['x', 'Sunrise Coaching'],
    ['linkedin', 'Sunrise Coaching Academy Official Page'],
    ['instagram', 'sunrise.coaching'],
    ['youtube', 'Sunrise Coaching Academy Channel'],
  ]) {
    await control.addChannel(email, provider, name);
  }
  return email;
}

/** Nothing on the page reaches past the right edge. */
async function expectNoSidewaysScroll(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, 'page width').toBeLessThanOrEqual(innerWidth);
}

/** Visible text fields under 16px (iPhone Safari zooms into them). */
async function smallFields(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('input, textarea, select, [contenteditable="true"]')]
      .filter((el) => !['checkbox', 'radio', 'range', 'file', 'hidden', 'color'].includes((el as HTMLInputElement).type))
      .filter((el) => el.getBoundingClientRect().width > 0)
      .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
      .map((el) => `${el.tagName} ${getComputedStyle(el).fontSize} ${el.getAttribute('placeholder') || el.getAttribute('name') || ''}`)
  );
}

/** The element's whole box is on screen and it is the topmost thing at its centre. */
async function expectOnScreenAndUncovered(page: Page, selector: ReturnType<Page['locator']>) {
  const box = await selector.boundingBox();
  expect(box, 'has a box').not.toBeNull();
  const vp = page.viewportSize()!;
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height + 0.5);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width + 0.5);
  const hit = await selector.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!top && (el === top || el.contains(top));
  });
  expect(hit, 'not covered by another element').toBe(true);
}

/**
 * A platform super admin, signed in; with `impersonating`, impersonating a
 * customer's account (the cookie POST /user/impersonate sets).
 */
async function superAdmin(context: BrowserContext, browserName: string, impersonating: boolean) {
  const admin = await signUp(context, browserName, 'mobile-admin-bar');
  await control.makeSuperAdmin(admin.email);
  if (!impersonating) return;
  const customer = await register('mobile-admin-bar-customer');
  const found = await (
    await fetch(`${BACKEND}/user/impersonate?name=${encodeURIComponent(customer.email)}`, {
      headers: { cookie: `auth=${admin.auth}` },
    })
  ).json();
  expect(found, 'customer found').toHaveLength(1);
  await context.addCookies([sessionCookie(browserName, 'impersonate', found[0].id)]);
}

/**
 * The box is on screen and its whole placeholder fits inside it: the text's
 * width in the box's own font against the box's content width.
 */
async function expectWholePlaceholder(page: Page, box: ReturnType<Page['locator']>, placeholder: string) {
  await expect(box).toBeVisible();
  await expect(box).toHaveAttribute('placeholder', placeholder);
  const m = await box.evaluate((el: HTMLInputElement) => {
    const cs = getComputedStyle(el);
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const r = el.getBoundingClientRect();
    return {
      text: ctx.measureText(el.placeholder).width,
      room: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
      left: r.left,
      right: r.right,
    };
  });
  const vw = page.viewportSize()!.width;
  expect(m.left, `${placeholder}: starts on screen`).toBeGreaterThanOrEqual(0);
  expect(m.right, `${placeholder}: ends on screen`).toBeLessThanOrEqual(vw + 0.5);
  expect(m.text, `${placeholder}: whole placeholder in the box at ${vw}px`).toBeLessThanOrEqual(m.room);
}

const SEARCH_PLACEHOLDER = 'Write the user details';
const SWITCH_PLACEHOLDER = 'Select user to switch to';

test.describe('phone layout', () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(!isMobile, 'phone projects only');
  });

  test('the app shell: tab bar at the bottom, no rail, nothing under the bar', async ({ page, context, browserName }) => {
    await workspace(context, browserName);
    await page.goto('/launches');
    const bar = page.getByRole('navigation', { name: 'Main menu' });
    await expect(bar).toBeVisible();
    await expect(page.locator('#left-menu')).toBeHidden();

    const vp = page.viewportSize()!;
    const barBox = (await bar.boundingBox())!;
    expect(Math.round(barBox.y + barBox.height)).toBe(vp.height);
    expect(barBox.width).toBe(vp.width);
    await expect(bar.getByRole('link', { name: 'Calendar' })).toHaveAttribute('aria-current', 'page');

    // Scrolled to the very bottom, the page's last pixel sits above the bar.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const shellBottom = await page.evaluate(
      () => document.querySelector('main')!.getBoundingClientRect().bottom
    );
    expect(shellBottom).toBeLessThanOrEqual(barBox.y + 1);
    await expectNoSidewaysScroll(page);
  });

  test('More opens the rest of the menu above the bar and goes there', async ({ page, context, browserName }) => {
    await workspace(context, browserName);
    await page.goto('/launches');
    const bar = page.getByRole('navigation', { name: 'Main menu' });
    await bar.getByRole('button', { name: 'More' }).click();
    const sheet = page.getByRole('dialog', { name: 'More' });
    await expect(sheet).toBeVisible();
    // The sheet sits on the bar, not over it.
    const sheetBox = (await sheet.boundingBox())!;
    const barBox = (await bar.boundingBox())!;
    expect(sheetBox.y + sheetBox.height).toBeLessThanOrEqual(barBox.y + 1);

    await sheet.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings/);
    await expect(sheet).toBeHidden();
    await expect(bar.getByRole('button', { name: 'More' })).toHaveClass(/bg-boxFocused/);
  });

  // /analytics is left out: opening it asks the networks for numbers, which
  // the E2E backend refuses. It is the same SidePanel as /plugs.
  for (const path of ['/launches', '/launches?display=day', '/launches?display=month', '/launches?display=list', '/settings', '/plugs', '/third-party', '/agents', '/media', '/billing']) {
    test(`${path}: no sideways scroll and no field under 16px`, async ({ page, context, browserName }) => {
      await workspace(context, browserName);
      await page.goto(path);
      await expect(page.locator('main')).toBeVisible();
      // Let SWR data and lazy panels render (no networkidle: some pages poll).
      await page.waitForTimeout(1500);
      await expectNoSidewaysScroll(page);
      expect(await smallFields(page)).toEqual([]);
    });
  }

  test('month view fits all seven days on screen', async ({ page, context, browserName }) => {
    await workspace(context, browserName);
    await page.goto('/launches?display=month');
    const vp = page.viewportSize()!;
    for (const day of ['Mon', 'Sun']) {
      const head = page.getByText(day, { exact: true }).first();
      await expect(head).toBeVisible();
      const box = (await head.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
    }
  });

  test('settings: the tabs are one row and the page starts on the first screen', async ({ page, context, browserName }) => {
    await workspace(context, browserName);
    await page.goto('/settings');
    const tabs = page.getByRole('tab');
    await expect(tabs.first()).toBeVisible();
    const first = (await tabs.nth(0).boundingBox())!;
    const second = (await tabs.nth(1).boundingBox())!;
    expect(Math.abs(first.y - second.y)).toBeLessThan(2);
    expect(first.height).toBeGreaterThanOrEqual(44);
    const heading = page.getByText('Date Metrics').first();
    await expect(heading).toBeInViewport();
  });

  test('channel panels are a row above the page (plugs)', async ({ page, context, browserName }) => {
    await workspace(context, browserName);
    await page.goto('/plugs');
    const first = page.getByText('sunrise.bsky.social').first();
    const second = page.getByText('Sunrise Coaching', { exact: true }).first();
    await expect(first).toBeVisible();
    const a = (await first.boundingBox())!;
    const b = (await second.boundingBox())!;
    expect(Math.abs(a.y - b.y)).toBeLessThan(8);
  });

  test('agent: channels and "Start a new chat" are reachable', async ({ page, context, browserName }) => {
    await workspace(context, browserName);
    await page.goto('/agents');
    await expect(page.getByText('Select Channels')).toBeInViewport();
    await expect(page.getByRole('link', { name: /Start a new chat/ })).toBeInViewport();
    await expectNoSidewaysScroll(page);
  });

  test('composer: actions on screen, uncovered, and the caption box usable', async ({ page, context, browserName }) => {
    await workspace(context, browserName);
    await page.goto('/launches?display=week');
    await page.getByRole('button', { name: 'Create Post' }).first().click();
    for (const provider of ['bluesky', 'x']) {
      await page.locator(`.bg-popup img[alt="${provider}"]`).first().click();
    }
    const editor = page.getByRole('textbox').first();
    await editor.click();
    await page.keyboard.type('Diwali offer: 20% off all batches this week');

    const add = page.getByRole('button', { name: 'Add to Calendar' });
    await expectOnScreenAndUncovered(page, add);
    await expectOnScreenAndUncovered(page, page.getByRole('button', { name: /Save as draft/i }));
    await expect(editor).toBeInViewport();
    expect(await smallFields(page)).toEqual([]);
    await expectNoSidewaysScroll(page);

    // From 375px up the three option chips share one row.
    if (page.viewportSize()!.width >= 375) {
      const tag = (await page.getByText('Tag', { exact: true }).boundingBox())!;
      const remind = (await page.getByText('Remind me', { exact: true }).boundingBox())!;
      expect(Math.abs(tag.y - remind.y)).toBeLessThan(4);
    }

    await add.click();
    await expect(page.locator('.bg-popup')).toHaveCount(0);
  });

  // 2 Nov 2026 sweep: at 320px the editor's tool row ran past the caption
  // box, so the last tools and the character count (with its over-the-limit
  // warning) were cut off. The row wraps now, and the box grows with it.
  test('composer at 320px: every editor tool and the character count on screen', async ({ page, context, browserName }) => {
    await workspace(context, browserName);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/launches?display=week');
    await page.getByRole('button', { name: 'Create Post' }).first().click();
    await page.locator('.bg-popup img[alt="bluesky"]').first().click();
    await page.getByRole('textbox').first().click();
    await page.keyboard.type('Diwali offer');
    const counter = page.getByText(/^\d+\/300$/).first();
    await expect(counter).toBeVisible();
    for (const tool of [page.locator('[data-tooltip-content="Insert Emoji"]').first(), counter]) {
      await tool.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      const b = (await tool.boundingBox())!;
      expect(b.x, 'starts on screen').toBeGreaterThanOrEqual(0);
      expect(b.x + b.width, 'ends on screen').toBeLessThanOrEqual(320.5);
      // Not under the "Add comment" button or the next part of the form: the
      // wrapped rows grow the caption box (a cyclic h-full kept it one row tall).
      const hit = await tool.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!top && (el === top || el.contains(top) || top.contains(el));
      });
      expect(hit, 'not covered').toBe(true);
    }
    await expectNoSidewaysScroll(page);
  });

  // 4 Nov 2026: at 320px the assistant launcher (CopilotPopup) floated on the
  // editor's right edge. Below md it sits in the composer's title row.
  test('composer at 320px: the assistant launcher is clear of the editor', async ({ page, context, browserName }) => {
    await workspace(context, browserName);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/launches?display=week');
    await page.getByRole('button', { name: 'Create Post' }).first().click();
    await page.locator('.bg-popup img[alt="bluesky"]').first().click();
    const launcher = page.locator('.copilotKitPopup .copilotKitButton');
    await expect(launcher).toBeVisible();
    const l = (await launcher.boundingBox())!;
    expect(Math.min(l.width, l.height), 'launcher is a 44px target').toBeGreaterThanOrEqual(44);
    expect(l.x + l.width, 'launcher on screen').toBeLessThanOrEqual(320.5);
    // The title row ("Create Post") is the composer's top 52px on a phone.
    expect(l.y + l.height, 'in the title row').toBeLessThanOrEqual(56);
    const e = (await page.getByRole('textbox').first().boundingBox())!;
    const overlaps = l.x < e.x + e.width && e.x < l.x + l.width && l.y < e.y + e.height && e.y < l.y + l.height;
    expect(overlaps, 'launcher over the editor').toBe(false);

    // Open, the assistant covers the composer: nothing of it shows through.
    await launcher.click();
    const win = page.locator('.copilotKitWindow.open');
    await expect(win).toBeVisible();
    const covered = await page.evaluate(() => {
      const w = document.querySelector('.copilotKitWindow')!;
      const r = w.getBoundingClientRect();
      return [0.25, 0.4, 0.55].map((f) => {
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height * f);
        return !!top && w.contains(top);
      });
    });
    expect(covered, 'the open assistant is on top').toEqual([true, true, true]);
  });

  // 4 Nov 2026: in the light theme the calendar's day names and hours were
  // 4.0-4.3:1 and today's date (pink) 2.3:1; body text needs 4.5:1.
  test('light theme: calendar day names, hours and today read at 4.5:1', async ({ page, context, browserName }) => {
    await workspace(context, browserName);
    await setLightTheme(context, browserName);
    await page.goto('/launches?display=week');
    await expect(page.locator('body')).toHaveClass(/light/);
    await expect(page.getByText('Monday', { exact: true }).first()).toBeVisible();
    await expect.poll(() => invisibleText(page, 'main', 4.5)).toEqual([]);
  });

  // 2 Nov 2026 sweep: hard-coded white text vanished in the light theme on
  // the affiliate page and the plan picker (plan names and prices).
  test('light theme: /affiliate and the plan picker have no white-on-white text', async ({ page, context, browserName }) => {
    await workspace(context, browserName);
    await setLightTheme(context, browserName);
    await page.goto('/affiliate');
    await expect(page.locator('body')).toHaveClass(/light/);
    await expect(page.locator('main h1').first()).toBeVisible();
    await expect.poll(() => invisibleText(page)).toEqual([]);

    // A workspace with no plan opens on the plan picker.
    await signUp(context, browserName);
    await setLightTheme(context, browserName);
    await page.goto('/billing');
    await expect(page.getByText('Standard', { exact: true }).first()).toBeVisible();
    // The plan picker is drawn outside <main>. Polled: the plan cards fade
    // their colours in (transition-all).
    const picker = page.getByTestId('plan-picker');
    await expect(picker).toBeVisible();
    // The wordmark's cyan "post" (logo-text.component.tsx, brand colour) is
    // left to the owner; everything else must read.
    await expect
      .poll(async () => (await invisibleText(page, '[data-testid="plan-picker"]')).filter((t) => !t.startsWith('SPAN "post"')))
      .toEqual([]);
  });

  test('day view: a post can be previewed, duplicated and deleted by touch', async ({ page, context, browserName }) => {
    await workspace(context, browserName);
    await page.goto('/launches?display=day');
    await page.getByRole('button', { name: 'Create Post' }).first().click();
    await page.locator('.bg-popup img[alt="bluesky"]').first().click();
    await page.getByRole('textbox').first().click();
    await page.keyboard.type('New batch starts Monday');
    await page.getByRole('button', { name: 'Add to Calendar' }).click();
    await expect(page.locator('.bg-popup')).toHaveCount(0);

    // The new post may land tomorrow (see calendar.helpers rangeShowingPost);
    // the calendar follows it.
    const card = page.getByText('New batch starts Monday').first();
    await expect(card).toBeVisible();
    const preview = page.locator('[data-tooltip-content="Preview Post"]').first();
    await expect(preview).toBeVisible();
    // 4 Nov 2026: every card action is a 44px target (Delete Post was 31px).
    for (const name of ['Preview Post', 'Duplicate Post', 'Delete Post']) {
      const icon = page.locator(`[data-tooltip-content="${name}"]`).first();
      const box = (await icon.locator('xpath=..').boundingBox())!;
      expect(Math.min(box.width, box.height), name).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width, `${name} on screen`).toBeLessThanOrEqual(page.viewportSize()!.width + 0.5);
    }
  });

  // 320 (iPhone SE), 375 and 393px: the narrowest phones in use.
  for (const impersonating of [false, true]) {
    test(`super-admin bar${impersonating ? ', impersonating' : ''}: the whole placeholder shows at 320, 375 and 393px`, async ({ page, context, browserName }) => {
      await superAdmin(context, browserName, impersonating);
      for (const width of [320, 375, 393]) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto('/launches');
        const bar = page.getByTestId('admin-bar');
        if (impersonating) {
          await expect(bar).toContainText('Currently Impersonating');
          const row = bar.getByTestId('admin-bar-switch-user');
          await expectWholePlaceholder(page, row.locator('input[name="switchUser"]'), SWITCH_PLACEHOLDER);
          const button = (await row.getByRole('button', { name: 'Switch User' }).boundingBox())!;
          expect(button.x + button.width, 'Switch User on screen').toBeLessThanOrEqual(width + 0.5);
        } else {
          await expectWholePlaceholder(page, bar.locator('input[name="impersonate"]'), SEARCH_PLACEHOLDER);
        }
        await expectNoSidewaysScroll(page);
      }
    });
  }

  // The search's results open under the box and end inside the screen: at
  // 320px, and at 768px (md), where a 90vw cap from the box's left ran about
  // 15px off the right edge.
  test('super-admin bar: the search results stay on screen at 320 and 768px', async ({ page, context, browserName }) => {
    await superAdmin(context, browserName, false);
    const customer = await register('mobile-admin-bar-search');
    for (const width of [320, 768]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/launches');
      await page.getByTestId('admin-bar').locator('input[name="impersonate"]').fill(customer.email);
      const results = page.getByTestId('admin-bar-results');
      const row = results.getByText(customer.email);
      await expect(row).toBeVisible();
      for (const box of [(await results.boundingBox())!, (await row.boundingBox())!]) {
        expect(box.x, `results start on screen at ${width}px`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `results end on screen at ${width}px`).toBeLessThanOrEqual(width + 0.5);
      }
      await expectNoSidewaysScroll(page);
    }
  });
});

// The admin pages on a phone: mobile-admin.spec.ts.

test.describe('desktop layout is unchanged', () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(isMobile, 'desktop project only');
  });

  // The phone-only wrap of the editor tool row (MultiMediaComponent is also
  // used by the agent, subreddit and Veo3 settings) must not reach a computer.
  for (const width of [768, 1024, 1440]) {
    test(`${width}px: the editor tools and the character count stay on one line`, async ({ page, context, browserName }) => {
      await workspace(context, browserName);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/launches?display=week');
      await page.getByRole('button', { name: 'Create Post' }).first().click();
      await page.locator('.bg-popup img[alt="bluesky"]').first().click();
      await page.getByRole('textbox').first().click();
      await page.keyboard.type('Diwali offer');
      const counter = page.getByText(/^\d+\/300$/).first();
      await expect(counter).toBeVisible();
      const mid = async (l: ReturnType<Page['locator']>) => {
        const b = (await l.boundingBox())!;
        return b.y + b.height / 2;
      };
      const emoji = await mid(page.locator('[data-tooltip-content="Insert Emoji"]').first());
      expect(Math.abs(emoji - (await mid(counter))), 'counter on the tools line').toBeLessThan(8);
    });
  }

  test('rail on the left, no tab bar, composer side by side', async ({ page, context, browserName }) => {
    await workspace(context, browserName);
    await page.goto('/launches');
    await expect(page.locator('#left-menu')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toBeHidden();
    const has = await page.evaluate(() => document.documentElement.classList.contains('has-mobile-nav'));
    // The bar is mounted but hidden by CSS from md up; the inset it publishes
    // only applies below md (mobile.scss), so it costs a desktop nothing.
    const inset = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--app-bottom-inset').trim()
    );
    expect(has).toBe(true);
    expect(inset === '' || /^(0px|env\(|0)/.test(inset)).toBe(true);
    await expectNoSidewaysScroll(page);

    await page.getByRole('button', { name: 'Create Post' }).first().click();
    const modal = page.locator('.bg-popup');
    const preview = modal.getByText('Post Preview', { exact: true });
    const create = modal.getByText('Create Post', { exact: true }).first();
    const pb = (await preview.boundingBox())!;
    const cb = (await create.boundingBox())!;
    expect(Math.abs(pb.y - cb.y)).toBeLessThan(30);
    expect(pb.x).toBeGreaterThan(cb.x + 400);
  });

  // The phone fix for the switch-user box must leave a computer's bar alone:
  // one 52px row, the box and Switch User side by side.
  test('super-admin bar, impersonating: one row, the whole placeholder', async ({ page, context, browserName }) => {
    await superAdmin(context, browserName, true);
    await page.goto('/launches');
    const bar = page.getByTestId('admin-bar');
    await expect(bar).toContainText('Currently Impersonating');
    expect((await bar.locator('> div').boundingBox())!.height).toBeLessThanOrEqual(53);
    const row = bar.getByTestId('admin-bar-switch-user');
    const box = row.locator('input[name="switchUser"]');
    await expectWholePlaceholder(page, box, SWITCH_PLACEHOLDER);
    const b = (await box.boundingBox())!;
    const button = (await row.getByRole('button', { name: 'Switch User' }).boundingBox())!;
    expect(Math.abs(b.y + b.height / 2 - (button.y + button.height / 2)), 'box and button in one row').toBeLessThan(2);
    expect(button.x).toBeGreaterThan(b.x + b.width);
  });
});
