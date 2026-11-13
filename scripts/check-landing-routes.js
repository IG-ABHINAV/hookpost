#!/usr/bin/env node
/**
 * Every page under (landing) must be reachable by an anonymous visitor.
 *
 * Adding a marketing route is two steps: create the directory, and add a prefix
 * to the allowlist in proxy.ts. Nothing enforced step two, so a route that
 * looked finished would 307 every logged-out visitor - and a crawler, and a
 * payment reviewer - straight to /auth.
 *
 * It has now happened three times: /refund-policy, /shipping-policy, and
 * /pricing. The last one was the expensive one. Razorpay's banking partner
 * clicked Pricing in the footer, hit a login wall, and moved 19 netbanking
 * banks plus Diners Club to ACTION REQUIRED with the note "there is no option
 * to proceed to the checkout page or complete a transaction". They were right
 * about what they could see.
 *
 * Run: node scripts/check-landing-routes.js
 */
const fs = require('fs');
const path = require('path');

const LANDING = path.join(__dirname, '..', 'apps/frontend/src/app/(landing)');
const PROXY = path.join(__dirname, '..', 'apps/frontend/src/proxy.ts');

const proxy = fs.readFileSync(PROXY, 'utf8');
// Collect every literal used with startsWith/=== in the allowlist.
const allowed = [...proxy.matchAll(/(?:startsWith|===)\(?\s*'([^']+)'/g)]
  .map((m) => m[1])
  // Drop the bare '/' entry. It is an exact-match check for the homepage, but
  // as a startsWith prefix it matches every path in existence - which made the
  // first version of this script pass unconditionally. It reported "all 46
  // routes reachable" while /pricing was 307ing in production. Verified by
  // deleting the /pricing line and confirming the check now fails.
  .filter((a) => a !== '/');

// Mirror proxy.ts EXACTLY: it uses a plain startsWith, so '/refund' really does
// allow '/refund-policy' in production.
//
// This used to require a segment boundary ('/refund' only covering '/refund/x'),
// which is stricter than the proxy and reported /cancellation-policy,
// /refund-policy and /shipping-policy as broken while all three served 200 to
// anonymous visitors. A guard that cries wolf gets ignored, and then the next
// real /pricing-style regression goes out unnoticed - so the rule here has to
// be the proxy's rule, not a tighter one.
const isAllowed = (route) => allowed.some((a) => route.startsWith(a));

function routes(dir, prefix = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    // Route groups (x) do not appear in the URL; [dynamic] segments are covered
    // by their parent prefix.
    if (e.name.startsWith('(')) {
      out.push(...routes(path.join(dir, e.name), prefix));
      continue;
    }
    if (e.name.startsWith('[') || e.name.startsWith('_')) continue;
    const p = `${prefix}/${e.name}`;
    if (fs.existsSync(path.join(dir, e.name, 'page.tsx'))) out.push(p);
    out.push(...routes(path.join(dir, e.name), p));
  }
  return out;
}

const missing = routes(LANDING).filter((r) => !isAllowed(r));

// The other direction. proxy.ts sends an anonymous visitor to /auth only for the
// first segments listed in APP_ROUTE_SEGMENTS (proxy.routes.ts); every other
// unlisted URL is left to Next's 404. A directory added under (app),
// (extension) or (provider) and not listed there would then load its signed-in
// page for a logged-out visitor instead of bouncing them to /auth.
const SRC_APP = path.join(__dirname, '..', 'apps/frontend/src/app');
const ROUTES_TS = path.join(__dirname, '..', 'apps/frontend/src/proxy.routes.ts');
const routesSrc = fs.readFileSync(ROUTES_TS, 'utf8');
const setBody = (name) => {
  const m = routesSrc.match(new RegExp(`${name}[^=]*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  if (!m) throw new Error(`${name} not found in proxy.routes.ts`);
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
};
const appSegments = setBody('APP_ROUTE_SEGMENTS');
const topSegments = (dir) => {
  const out = new Set();
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('(')) {
      for (const s of topSegments(path.join(dir, e.name))) out.add(s);
      continue;
    }
    if (e.name.startsWith('[') || e.name.startsWith('_')) continue;
    out.add(e.name);
  }
  return out;
};
const appGroups = fs
  .readdirSync(SRC_APP, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('(landing)'))
  .map((e) => path.join(SRC_APP, e.name));
const unhandledApp = [];
for (const dir of appGroups) {
  // Top-level folders directly under src/app that are themselves routes (auth,
  // integrations, oauth, api) or route groups containing them.
  const isGroup = path.basename(dir).startsWith('(');
  const segs = isGroup ? topSegments(dir) : new Set([path.basename(dir)]);
  for (const seg of segs) {
    // /api and dotted names (sitemap.xml, key files) are excluded by the
    // proxy matcher; /auth is the login page.
    if (seg === 'api' || seg === 'auth' || seg.includes('.')) continue;
    // Already answered before the redirect step (uploads, /p/, /provider/, ...).
    if (isAllowed(`/${seg}`) || isAllowed(`/${seg}/x`)) continue;
    if (!appSegments.has(seg)) unhandledApp.push(`/${seg}`);
  }
}
if (unhandledApp.length) {
  console.error('These signed-in app routes are NOT in APP_ROUTE_SEGMENTS');
  console.error('(apps/frontend/src/proxy.routes.ts), so a logged-out visitor would');
  console.error('reach the page instead of being sent to /auth:\n');
  for (const m of [...new Set(unhandledApp)]) console.error(`  ${m}`);
  process.exit(1);
}

if (missing.length) {
  console.error('These (landing) routes are NOT allowlisted in proxy.ts and will');
  console.error('307 anonymous visitors to /auth:\n');
  for (const m of missing) console.error(`  ${m}`);
  console.error('\nAdd a startsWith() entry for each in apps/frontend/src/proxy.ts.');
  process.exit(1);
}
console.log(`✓ all ${routes(LANDING).length} (landing) routes are publicly reachable`);
console.log(`✓ every signed-in app route is listed in APP_ROUTE_SEGMENTS (${appSegments.size} segments)`);
