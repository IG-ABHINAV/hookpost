import { PUBLISHABLE_CHANNEL_COUNT } from '@hookpost/frontend/app/(landing)/channels/channel-count';
import {
  FREE_POSTS,
  offer,
  TRIAL_PRICE_AFTER,
} from '@hookpost/frontend/app/(landing)/trial-offer';

/**
 * The right half of the sign-in and sign-up pages (auth/layout.tsx), from
 * lg up: a drawing of the week calendar with the composer over it, the
 * networks' logos and three facts.
 *
 * Every fact here is one the homepage already states, from the same source:
 * the channel count from channel-count.ts, the price and the free posts from
 * trial-offer.ts, the MCP clients from the homepage hero. No user counts,
 * ratings or quotes (TestimonialComponent stays empty until there are real,
 * consented ones).
 *
 * Colour comes only from the hp-* tokens, so the panel follows the brand
 * theme switch (brand-colours.guard.spec.ts). The logos are the networks'
 * own, from public/svgs/socials. It is server-rendered markup and ~15KB of
 * SVG that the browser does not fetch below lg (lazy images in a hidden
 * column), so the phone sign-in page is unchanged.
 */

type Network = { name: string; file: string };

/** The logo row: networks a new account can publish to today (channel-specs.ts). */
export const SHOWCASE_NETWORKS: readonly Network[] = [
  { name: 'X', file: 'X' },
  { name: 'LinkedIn', file: 'Linkedin' },
  { name: 'Instagram', file: 'Instagram' },
  { name: 'Threads', file: 'Threads' },
  { name: 'TikTok', file: 'TikTok' },
  { name: 'YouTube', file: 'Youtube' },
  { name: 'Facebook', file: 'Facebook' },
  { name: 'Pinterest', file: 'Pinterest' },
  { name: 'Bluesky', file: 'Bluesky' },
];

const logo = (file: string) => `/svgs/socials/${file}.svg`;

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as const;
const SLOTS = ['9:00', '12:00', '18:00'] as const;

type Chip = {
  day: number;
  slot: number;
  file: string;
  title: string;
  /** Queued by an AI assistant through the MCP server. */
  viaMcp?: boolean;
};

/**
 * The posts drawn on the calendar; Tue 9:00 is the one being written. The
 * composer covers the lower right (Wed-Fri after 9:00), so nothing sits there.
 */
const CHIPS: readonly Chip[] = [
  { day: 0, slot: 0, file: 'Linkedin', title: "We're hiring" },
  { day: 0, slot: 2, file: 'Instagram', title: 'Studio tour' },
  { day: 1, slot: 1, file: 'X', title: 'Launch thread' },
  { day: 1, slot: 2, file: 'Youtube', title: 'Build log #12' },
  { day: 2, slot: 0, file: 'Threads', title: 'What shipped', viaMcp: true },
  { day: 3, slot: 0, file: 'TikTok', title: 'Quick setup' },
  { day: 4, slot: 0, file: 'Bluesky', title: 'Reading list' },
];

const COMPOSER_NETWORKS = ['X', 'Linkedin', 'Threads', 'Bluesky'] as const;

const CalendarMock = () => (
  <div aria-hidden="true" className="relative hidden xl:block pb-[56px] pe-[8px]">
    {/* A low glow behind the window, in the theme's own colour. */}
    <div className="pointer-events-none absolute inset-x-[10%] top-[18%] bottom-[10%] -z-10 rounded-full bg-hp-primary/[0.09] blur-[64px]" />

    <div className="overflow-hidden rounded-[14px] border border-hp-border bg-hp-surface shadow-2xl">
      <div className="flex h-[44px] items-center justify-between border-b border-hp-border px-[16px]">
        <div className="flex items-baseline gap-[10px]">
          <span className="text-[13px] font-[600] text-hp-text">This week</span>
          <span className="text-[11px] text-hp-text-3">{CHIPS.length} scheduled</span>
        </div>
        <div className="flex rounded-[8px] border border-hp-border p-[2px] text-[11px]">
          {['Day', 'Week', 'Month'].map((view) => (
            <span
              key={view}
              className={
                view === 'Week'
                  ? 'rounded-[6px] bg-hp-elevated px-[10px] py-[3px] font-[600] text-hp-text'
                  : 'px-[10px] py-[3px] text-hp-text-3'
              }
            >
              {view}
            </span>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-[46px_repeat(5,minmax(0,1fr))]">
        <div />
        {DAYS.map((day) => (
          <div
            key={day}
            className="border-s border-hp-border/70 px-[10px] py-[8px] text-[11px] font-[500] text-hp-text-2"
          >
            {day}
          </div>
        ))}

        {SLOTS.map((slot, row) => (
          <div key={slot} className="contents">
            <div className="border-t border-hp-border/70 pe-[8px] pt-[8px] text-end text-[10px] tabular-nums text-hp-text-3">
              {slot}
            </div>
            {DAYS.map((day, col) => {
              const chip = CHIPS.find((c) => c.day === col && c.slot === row);
              const drafting = col === 1 && row === 0;
              return (
                <div
                  key={day}
                  className="h-[66px] border-s border-t border-hp-border/70 p-[5px]"
                >
                  {drafting && (
                    <div className="flex h-full items-center justify-center rounded-[8px] border border-dashed border-hp-primary/70 bg-hp-primary/[0.08] text-[10px] font-[600] text-hp-primary-text">
                      New post
                    </div>
                  )}
                  {chip && (
                    <div className="flex h-full flex-col justify-between rounded-[8px] border border-hp-border bg-hp-elevated px-[7px] py-[6px]">
                      <div className="flex items-center gap-[5px]">
                        <img
                          src={logo(chip.file)}
                          alt=""
                          width={14}
                          height={14}
                          loading="lazy"
                          decoding="async"
                          className="h-[14px] w-[14px] rounded-[4px]"
                        />
                        {chip.viaMcp && (
                          <span className="ms-auto text-[9px] font-[600] text-hp-accent">via Claude</span>
                        )}
                      </div>
                      <div className="truncate text-[11px] font-[500] leading-[1.25] text-hp-text">
                        {chip.title}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>

    {/* The composer, writing the Tue 9:00 post. The only motion on the page. */}
    <div className="auth-float absolute bottom-0 end-0 w-[300px] rounded-[14px] border border-hp-border-strong bg-hp-surface p-[14px] shadow-2xl">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-[600] text-hp-text">New post</span>
        <div className="flex gap-[4px]">
          {COMPOSER_NETWORKS.map((file) => (
            <img
              key={file}
              src={logo(file)}
              alt=""
              width={20}
              height={20}
              loading="lazy"
              decoding="async"
              className="h-[20px] w-[20px] rounded-[5px]"
            />
          ))}
        </div>
      </div>
      <p className="mt-[10px] text-[12.5px] leading-[1.5] text-hp-text-2">
        Episode 14 is out: how we planned a month of posts in one afternoon. Link in the comments.
      </p>
      <div className="mt-[12px] flex items-center justify-between border-t border-hp-border pt-[12px]">
        <span className="text-[11px] tabular-nums text-hp-text-3">Tue, 9:00 AM</span>
        <span className="rounded-[8px] bg-hp-primary px-[12px] py-[6px] text-[11px] font-[600] text-hp-on-primary">
          Add to calendar
        </span>
      </div>
    </div>
  </div>
);

const Icon = ({ d }: { d: string }) => (
  <svg
    aria-hidden="true"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="shrink-0 text-hp-primary-text"
  >
    <path d={d} />
  </svg>
);

const CALENDAR_ICON = 'M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z';
const PROMPT_ICON = 'M5 8l4 4-4 4M12 16h7';
const PRICE_ICON = 'M20 12V7a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5Zm0 0h-5M4 10h16';

/** The three facts under the drawing; each is stated on the homepage too. */
export const showcaseFacts = () => [
  {
    icon: CALENDAR_ICON,
    title: `${PUBLISHABLE_CHANNEL_COUNT} networks, one calendar`,
    body: 'Write once, adjust per network, and see the whole week at a glance.',
  },
  {
    icon: PROMPT_ICON,
    title: 'Post from Claude or Cursor',
    body: 'The MCP server lets Claude Code, Cursor and Windsurf draft and queue your posts.',
  },
  {
    icon: PRICE_ICON,
    title: `${TRIAL_PRICE_AFTER} a month, one flat price`,
    body: offer(
      'Start on the Free plan. Pay by UPI, card or NetBanking.',
      `${FREE_POSTS} to start, no card needed. Pay by UPI, card or NetBanking.`
    ),
  },
];

export const AuthShowcase = () => {
  const more = PUBLISHABLE_CHANNEL_COUNT - SHOWCASE_NETWORKS.length;
  return (
    <div className="flex w-full flex-col gap-[40px]">
      <CalendarMock />

      <div className="flex flex-col gap-[28px]">
        <ul className="flex flex-wrap items-center gap-[8px]" aria-label="Some of the networks Hookpost publishes to">
          {SHOWCASE_NETWORKS.map((n) => (
            <li key={n.name}>
              <img
                src={logo(n.file)}
                alt={n.name}
                title={n.name}
                width={28}
                height={28}
                loading="lazy"
                decoding="async"
                className="h-[28px] w-[28px] rounded-[7px]"
              />
            </li>
          ))}
          {more > 0 && (
            <li className="ps-[6px] text-[13px] text-hp-text-3">and {more} more</li>
          )}
        </ul>

        <ul className="grid gap-[20px] xl:grid-cols-3 xl:gap-[24px]">
          {showcaseFacts().map((fact) => (
            <li key={fact.title} className="flex flex-col gap-[8px]">
              <Icon d={fact.icon} />
              <span className="text-[14px] font-[600] leading-[1.3] text-hp-text">{fact.title}</span>
              <span className="text-[13px] leading-[1.5] text-hp-text-2">{fact.body}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
