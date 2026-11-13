/**
 * @jest-environment node
 */
/**
 * next.config.js redirects the URLs AI assistants send people to that never
 * existed (/for-agencies, /docs). The /for-<role> rule spells the role slugs
 * out in a regex, so a role added to personas.ts without it would 404 again:
 * this pins the two lists together and checks every destination is a page.
 * The live 308s are covered by tests/e2e/specs/festival-pages.spec.ts.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ROLE_LINKS } from './(landing)/for/personas';

const config = readFileSync(join(__dirname, '..', '..', 'next.config.js'), 'utf8');
const landing = join(__dirname, '(landing)');

describe('redirects for guessed URLs', () => {
  it('/for-<role> covers exactly the role pages in personas.ts', () => {
    const m = config.match(/source:\s*'\/for-:slug\(([^)]+)\)'/);
    expect(m).not.toBeNull();
    const slugs = m![1].split('|').sort();
    expect(slugs).toEqual(ROLE_LINKS.map((r) => r.slug).sort());
    expect(config).toMatch(/source:\s*'\/for-:slug\([^)]+\)',\s*destination:\s*'\/for\/:slug',\s*permanent:\s*true/);
  });

  it('every role slug has a page under /for/<role>', () => {
    for (const { slug } of ROLE_LINKS) {
      expect({ slug, page: existsSync(join(landing, 'for', '(roles)', slug, 'page.tsx')) }).toEqual({
        slug,
        page: true,
      });
    }
  });

  it('/docs goes to the public API docs, which exist, and /docs itself is not a page', () => {
    expect(config).toMatch(/source:\s*'\/docs',\s*destination:\s*'\/docs\/public-api',\s*permanent:\s*true/);
    expect(existsSync(join(landing, 'docs', 'public-api', 'page.tsx'))).toBe(true);
    expect(existsSync(join(landing, 'docs', 'page.tsx'))).toBe(false);
  });

  it('/blog is redirected once, not twice', () => {
    expect(config.match(/source:\s*'\/blog'/g)).toHaveLength(1);
  });
});
