/**
 * Fails the E2E run if the backend tried to reach any host other than
 * localhost while the specs ran (tests/integration/setup/network-guard.cjs
 * refused it). A spec that passes only because a real service answered, or
 * fails only because one did not, is not testing Hookpost.
 *
 * Runs before Playwright stops the web servers, so the control port is up.
 */
export default async function globalTeardown() {
  const control = `http://127.0.0.1:${Number(process.env.E2E_BACKEND_PORT || 53000) + 1}`;
  let res: Response;
  try {
    res = await fetch(`${control}/network`);
  } catch (e) {
    throw new Error(`E2E teardown: the backend's control port did not answer (${e})`);
  }
  if (res.status === 404) {
    // A backend left running from before the guard existed (reuseExistingServer).
    console.warn('E2E teardown: this backend has no /network record; restart it to check outbound requests.');
    return;
  }
  const { blocked } = (await res.json()) as { blocked: { where: string; at: string }[] };
  if (blocked.length) {
    const hosts = [...new Set(blocked.map((b) => b.where))].join(', ');
    throw new Error(
      `E2E: the backend tried to reach ${hosts} (${blocked.length} refused connections). ` +
        'Fake that client in tests/integration/setup and alias it in tests/e2e/server/register.cjs.'
    );
  }
}
