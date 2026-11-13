/**
 * Which stylesheet each part of the site loads. Next inlines a route's CSS
 * into its HTML twice (experimental.inlineCss), so an import in the wrong
 * layout puts the whole app's CSS into a page that does not need it: /auth
 * was 1.09MB of HTML with global.scss (Blueprint 5 and Uppy included) in
 * the (app) root layout. The E2E suite measures the built page
 * (tests/e2e/specs/page-weight.spec.ts); this pins the structure.
 *   pnpm exec jest -c apps/frontend/jest.config.ts stylesheets
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const APP = join(__dirname);
const read = (p: string) => readFileSync(join(APP, p), 'utf8');
const imports = (src: string) =>
  // Side-effect imports only: `import './auth.scss';`, `import '../app-styles';`.
  [...src.matchAll(/^import\s+['"]([^'"]+)['"];?$/gm)].map((m) => m[1]);

const layoutsUnder = (dir: string): string[] =>
  readdirSync(join(APP, dir)).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(join(APP, p)).isDirectory()) return layoutsUnder(p);
    return name === 'layout.tsx' ? [p] : [];
  });

describe('stylesheets', () => {
  it('the (app) root layout imports no stylesheet (it would be inlined into /auth)', () => {
    const src = read('(app)/layout.tsx');
    expect(src).not.toMatch(/global\.scss|\.css['"]/);
  });

  it('/auth loads only its own sheet', () => {
    expect(imports(read('(app)/auth/layout.tsx'))).toEqual(['./auth.scss']);
    const sheet = read('(app)/auth/auth.scss');
    expect(sheet).toContain("@config '../../../../tailwind.auth.config.cjs'");
    expect(sheet).not.toMatch(/uppy|polonto|blueprint|copilot/i);
  });

  it('every other (app) layout with pages under it loads the app sheets', () => {
    const appStyles = read('(app)/app-styles.ts');
    expect(imports(appStyles)).toEqual([
      '../global.scss',
      'react-tooltip/dist/react-tooltip.css',
      '@copilotkit/react-ui/styles.css',
    ]);
    const layouts = layoutsUnder('(app)').filter(
      (p) => p !== join('(app)', 'layout.tsx') && !p.startsWith(join('(app)', 'auth'))
    );
    // Only the topmost layout of each subtree needs it.
    const topmost = layouts.filter(
      (p) => !layouts.some((q) => q !== p && p.startsWith(q.replace(/layout\.tsx$/, '')))
    );
    expect(topmost.sort()).toEqual(
      [
        '(app)/(preview)/p/[id]/layout.tsx',
        '(app)/(site)/layout.tsx',
        '(app)/integrations/social/layout.tsx',
        '(app)/invite/layout.tsx',
        '(app)/oauth/authorize/layout.tsx',
      ].map((p) => join(...p.split('/')))
    );
    for (const p of topmost) {
      const target = imports(read(p)).find((i) => i.endsWith('app-styles'));
      expect({ layout: p, imports: target }).toEqual({ layout: p, imports: expect.any(String) });
      expect(relative(APP, join(APP, p, '..', target!))).toBe(join('(app)', 'app-styles'));
    }
  });

  it('global.scss no longer carries the dead Blueprint 5 sheet or Uppy', () => {
    const global = read('global.scss');
    expect(global).not.toMatch(/polonto\.css|@uppy/);
    expect(existsSync(join(APP, 'polonto.css'))).toBe(false);
  });

  it('Uppy styles travel with the components that render Uppy', () => {
    const root = join(APP, '..');
    for (const file of [
      'components/media/media.component.tsx',
      'components/media/new.uploader.tsx',
      'components/new-launch/editor.tsx',
    ]) {
      expect(readFileSync(join(root, file), 'utf8')).toMatch(/import ['"][^'"]*media\/uppy\.scss['"]|import '\.\/uppy\.scss'/);
    }
  });
});
