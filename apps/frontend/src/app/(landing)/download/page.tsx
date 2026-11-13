import { Metadata } from 'next';
import Link from 'next/link';
import { DownloadHero } from './DownloadHero';
import { FREE_POSTS, offer } from '../trial-offer';
import { CHROME_EXTENSION_URL } from '@hookpost/frontend/components/layout/chrome.extension.url';

// The Chrome extension is named on this page only once it is in the Chrome
// Web Store (CHROME_EXTENSION_URL); until then the page does not mention it.
// There is no Mac or Windows installer (no .dmg/.exe in any release) and no
// APK: on every device Hookpost is the web app, which can be added to the
// Dock, taskbar or home screen. The page says so rather than offering a
// download that opens sign-up.
const withExtension = (text: string) => (CHROME_EXTENSION_URL ? text : '');

export const metadata: Metadata = {
  title: 'Hookpost on Mac, Windows, iOS & Android | Hookpost',
  description: `Use Hookpost in your browser on macOS, Windows, Android and iPhone${withExtension(
    ', or with the Chrome extension'
  )}, and add it to your Dock, taskbar or home screen. No installer needed. Multi-channel AI social media scheduler.`,
  alternates: {
    canonical: 'https://hookpost.hookstep.in/download',
  },
  openGraph: {
    title: 'Hookpost on Mac, Windows, iOS & Android | Hookpost',
    description: `Social scheduling with AI copilot in the browser on macOS, Windows${withExtension(
      ', Chrome'
    )}, Android, and iOS.`,
    url: 'https://hookpost.hookstep.in/download',
  },
};

const CHROME_ICON = (
  <svg className="w-8 h-8 text-hp-text" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 0C8.21 0 4.831 1.757 2.632 4.501l3.953 6.848A5.454 5.454 0 0 1 12 6.545h10.691A12 12 0 0 0 12 0zM1.931 5.47A11.943 11.943 0 0 0 0 12c0 6.012 4.42 10.991 10.189 11.864l3.953-6.847a5.45 5.45 0 0 1-6.865-2.29L1.93 5.47zM12 7.636a4.364 4.364 0 1 0 0 8.728 4.364 4.364 0 0 0 0-8.728zm2.457 4.364a2.457 2.457 0 1 1-4.914 0 2.457 2.457 0 0 1 4.914 0zm7.612-4.364H14.15a5.452 5.452 0 0 1 2.912 4.772c0 1.258-.426 2.418-1.143 3.342l5.345 9.257A11.97 11.97 0 0 0 24 12c0-4.07-2.029-7.669-5.131-9.828l1.2-2.08z" />
  </svg>
);

// What the extension does, and nothing more: it connects a Skool account
// (apps/extension). It does not clip pages or schedule from the browser.
const CHROME_EXTENSION = CHROME_EXTENSION_URL
  ? [
      {
        name: 'Chrome Extension',
        badge: 'Chrome Web Store',
        icon: CHROME_ICON,
        description:
          'Connects your Skool account to Hookpost, so you can schedule posts to your Skool community alongside your other channels.',
        version: 'v1.0.0 • Manifest V3',
        links: [{ label: 'Add to Chrome', href: CHROME_EXTENSION_URL, primary: true }],
      },
    ]
  : [];

const PLATFORMS = [
  {
    name: 'On your Mac',
    badge: 'Safari, Chrome, Edge',
    icon: (
      <svg className="w-8 h-8 text-hp-text" viewBox="0 0 24 24" fill="currentColor">
        <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 3.5c.62-.75 1.04-1.8 0.92-2.85-.9.04-1.98.6-2.62 1.35-.57.65-1.06 1.71-.93 2.73 1 .08 2.01-.48 2.63-1.23z" />
      </svg>
    ),
    description:
      "There is no Mac download yet: Hookpost runs in your browser. After you sign in, Safari's File → Add to Dock (macOS Sonoma or later), or Chrome's Install option, keeps it in your Dock like an app.",
    version: 'Web app • Nothing to install',
    links: [{ label: 'Sign up to use it on your Mac', href: '/auth', primary: true }],
  },
  {
    name: 'On Windows',
    badge: 'Edge, Chrome',
    icon: (
      <svg className="w-8 h-8 text-hp-text" viewBox="0 0 24 24" fill="currentColor">
        <path d="M0 3.449L9.75 2.1v9.451H0V3.449zm10.75-1.5L24 0v11.551H10.75V1.949zM0 12.55h9.75v9.451L0 20.651V12.55zm10.75 0H24V24l-13.25-1.949V12.55z" />
      </svg>
    ),
    description:
      "There is no Windows download yet: Hookpost runs in your browser. After you sign in, Edge's or Chrome's Install option pins it to your taskbar like an app.",
    version: 'Web app • Nothing to install',
    links: [{ label: 'Sign up to use it on Windows', href: '/auth', primary: true }],
  },
  ...CHROME_EXTENSION,
  {
    name: 'On your phone',
    badge: 'Android & iOS',
    icon: (
      <svg className="w-8 h-8 text-hp-text" viewBox="0 0 24 24" fill="currentColor">
        <path d="M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z" />
      </svg>
    ),
    description:
      'Hookpost works in your phone\'s browser. After you sign in, add it to your home screen: Safari → Share → Add to Home Screen on iPhone, or Chrome menu → Add to Home screen on Android.',
    version: 'Web app • Add to home screen',
    links: [{ label: 'Sign up on your phone', href: '/auth', primary: true }],
  },
  {
    name: 'AI Agent & Developer MCP',
    badge: 'Claude Desktop / Cursor',
    icon: (
      <svg className="w-8 h-8 text-hp-text" viewBox="0 0 24 24" fill="currentColor">
        <path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z" />
      </svg>
    ),
    description: 'Model Context Protocol (MCP) server so Claude Code, Cursor, and autonomous AI agents can schedule posts directly.',
    version: 'npx hookpost mcp • Official TypeScript SDK',
    links: [
      { label: 'View MCP Guide', href: '/mcp', primary: true },
      // Our own API docs, not the RapidAPI listing: that listing's URL carries
      // a personal account handle (see (landing)/public-names.spec.ts).
      { label: 'Explore Public API', href: '/docs/public-api', primary: false },
    ],
  },
  {
    name: 'Instant Web Cloud App',
    badge: 'All Browsers',
    icon: (
      <svg className="w-8 h-8 text-hp-text" viewBox="0 0 24 24" fill="currentColor">
        <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM19 18H6c-2.21 0-4-1.79-4-4 0-2.05 1.53-3.76 3.56-3.97l1.07-.11.5-.95C8.08 7.14 9.94 6 12 6c2.62 0 4.88 1.86 5.39 4.43l.3 1.5 1.53.11c1.56.1 2.78 1.41 2.78 2.96 0 1.65-1.35 3-3 3z" />
      </svg>
    ),
    description: 'Zero download required. Access your full multi-channel social calendar directly in Google Chrome, Safari, Edge, or Brave.',
    version: 'Next.js 16 • Ultra-low latency',
    links: [
      { label: 'Launch Web App', href: '/auth', primary: true },
    ],
  },
];

export default function DownloadPage() {
  return (
    <div className="min-h-screen bg-hp-bg text-hp-text">
      {/* Dynamic Hero with smart client-side device detection */}
      <DownloadHero offerNote={offer('Free plan available', `${FREE_POSTS}, no card needed`)} />

      {/* All Platforms Grid */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold tracking-tight text-hp-text mb-3">
            Available on every screen you use
          </h2>
          <p className="text-hp-text-2 max-w-xl mx-auto text-sm sm:text-base">
            Your drafts, scheduled queues, connected accounts, and analytics stay synchronized in real-time across all your devices.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {PLATFORMS.map((p) => (
            <div
              key={p.name}
              className="flex flex-col justify-between p-6 rounded-2xl bg-white/[0.03] border border-hp-border hover:border-hp-primary/40 hover:bg-white/[0.05] transition-all duration-300 backdrop-blur-sm group"
            >
              <div>
                <div className="flex items-center justify-between mb-4">
                  <div className="p-2.5 rounded-xl bg-white/5 border border-hp-border group-hover:scale-105 transition-transform duration-200">
                    {p.icon}
                  </div>
                  <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-hp-primary/10 text-hp-primary-text border border-hp-primary/20">
                    {p.badge}
                  </span>
                </div>
                <h3 className="text-xl font-bold text-hp-text mb-2">{p.name}</h3>
                <p className="text-sm text-hp-text-2 mb-4 leading-relaxed">{p.description}</p>
                <div className="text-xs text-hp-text-3 mb-6 font-mono">{p.version}</div>
              </div>

              <div className="flex flex-col gap-2 pt-4 border-t border-hp-border">
                {p.links.map((link) => (
                  <Link
                    key={link.label}
                    href={link.href}
                    className={`text-center py-2.5 px-4 rounded-xl text-sm font-semibold transition-all duration-200 ${
                      link.primary
                        ? 'bg-white/10 hover:bg-white/20 text-hp-text border border-hp-border-strong shadow-sm'
                        : 'text-hp-text-2 hover:text-hp-text hover:underline text-xs'
                    }`}
                  >
                    {link.label}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Quick Install Guide */}
      <section className="max-w-4xl mx-auto px-4 sm:px-6 py-16 border-t border-hp-border text-hp-text-2">
        <h2 className="text-2xl font-bold text-hp-text text-center mb-8">
          Frequently Asked Questions
        </h2>
        <div className="space-y-6 text-sm">
          <div className="p-5 rounded-xl bg-white/[0.02] border border-hp-border">
            <h3 className="font-semibold text-hp-text mb-2">Do I need a separate subscription for each device?</h3>
            <p className="text-hp-text-2">
              No. One Hookpost account gives you access across macOS, Windows, Android, iOS{withExtension(', the Chrome extension,')} and the Web App. Your connected channels, queued posts, and AI settings stay synchronized automatically.
            </p>
          </div>
          <div className="p-5 rounded-xl bg-white/[0.02] border border-hp-border">
            <h3 className="font-semibold text-hp-text mb-2">Is there a Mac or Windows app to download?</h3>
            <p className="text-hp-text-2">
              Not yet. Hookpost runs in your browser, so there is nothing to install. Sign up, then use Safari&apos;s File → Add to Dock on a Mac (macOS Sonoma or later), or the Install option in Chrome or Edge, and it opens in its own window like an app.
            </p>
          </div>
          <div className="p-5 rounded-xl bg-white/[0.02] border border-hp-border">
            <h3 className="font-semibold text-hp-text mb-2">Can AI models (Claude, ChatGPT, Cursor) schedule posts?</h3>
            <p className="text-hp-text-2">
              Yes! Hookpost includes a native Model Context Protocol (MCP) server. You can connect it to Claude Desktop or Cursor to generate and schedule multi-channel posts directly from your AI prompts.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
