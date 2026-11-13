// Tailwind config for the sign-up and sign-in pages (/auth, /auth/login,
// /auth/forgot, /auth/activate) only.
//
// Next inlines a route's whole stylesheet into its HTML twice (a <style> tag
// and the RSC payload; experimental.inlineCss in next.config.js, kept for the
// marketing pages' LCP). /auth used to get the full app sheet, Tailwind
// generated from the entire monorepo plus the app's component styles, so the
// page that every ad ends on was ~1.09MB of HTML (Postiz's is ~80KB). With
// its own sheet it carries only the classes its own tree can render.
//
// Spreading the base config keeps theme, plugins, darkMode and screens
// byte-identical; only the content scan differs, as for the landing config.
// The scan covers the auth pages, the auth components, the providers the
// (app) root layout renders around them (components/layout) and the shared
// form, toaster and modal components. If an auth page ever renders a
// component from elsewhere, add its path here or it renders unstyled.
const base = require('./tailwind.config.cjs');

module.exports = {
  ...base,
  content: [
    './src/app/(app)/auth/**/*.{ts,tsx}',
    './src/app/(app)/layout.tsx',
    './src/components/auth/**/*.{ts,tsx}',
    './src/components/layout/**/*.{ts,tsx}',
    './src/components/ui/**/*.{ts,tsx}',
    '../../libraries/react-shared-libraries/src/**/*.{ts,tsx}',
    '../../libraries/helpers/src/**/*.{ts,tsx}',
  ],
};
