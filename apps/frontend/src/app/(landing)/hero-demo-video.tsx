'use client';

/**
 * The homepage demo video (hero-demo.ts has the cuts, the encodes and the
 * claims check).
 *
 * Loading, so it costs the page nothing until someone wants it:
 * - preload="none": no video bytes until play. The browser picks the cut from
 *   <source media> and the encode from <source type> (AV1 WebM, else H.264
 *   MP4); no JS is needed for either.
 * - The poster is a <picture> behind the video, not the poster attribute: it
 *   takes the same media query as the sources, AVIF with a WebP fallback, and
 *   loading="lazy" with fixed width and height. The box has a fixed aspect
 *   ratio, so nothing shifts while it loads. A <video> with no frame and no
 *   controls is transparent, so the picture shows through it.
 * - No native controls until a frame is playing: Chrome paints a grey panel
 *   over a frameless video with controls, which would cover the poster. Until
 *   then a play button covers the poster, and turns into a spinner once
 *   pressed, so a slow connection still shows that something is happening.
 *   Without JS the play button is a plain link to the MP4 (in <noscript>).
 *   Accepted trade-off: with JS on, between first paint and hydration there is
 *   no button and no controls (the box is below the fold, so this is rarely
 *   seen; server-rendered controls would grey the poster for everyone).
 * - Mobile: tap to play, with sound. A tap on a narrow video's body only
 *   shows Chrome's controls (it draws no centre play button under ~300px),
 *   which is why the button covers the whole poster.
 * - Desktop (a wide screen with a mouse): muted autoplay once the page has
 *   loaded and half the video is in view, so it never competes with the hero
 *   for LCP. Not on a touch screen (a phone held sideways or a tablet is as
 *   wide as a laptop), and not with reduced motion, Save-Data or a 2G
 *   connection. It pauses when scrolled away, and stops managing playback for
 *   good once the visitor plays, pauses or unmutes it.
 * - If every source fails (a 404, a network error, a file the browser cannot
 *   decode), the poster stays, the video is paused and a line points at the
 *   transcript under it; keyboard focus moves to that line.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { DESKTOP_QUERY, HERO_DEMO, WEBM_AV1_TYPE } from './hero-demo';

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(DESKTOP_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
const isDesktop = () => window.matchMedia(DESKTOP_QUERY).matches;
const onServer = (): boolean | null => null;

type Connection = { saveData?: boolean; effectiveType?: string };

/** A mouse (or trackpad) is the main pointer: not a phone or tablet, whatever its width. */
export const FINE_POINTER_QUERY = '(hover: hover) and (pointer: fine)';

export function autoplayAllowed(): boolean {
  if (!window.matchMedia(FINE_POINTER_QUERY).matches) return false;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  const conn = (navigator as Navigator & { connection?: Connection }).connection;
  if (conn?.saveData) return false;
  // effectiveType is "slow-2g", "2g", "3g" or "4g" (Chromium only).
  return !/2g$/.test(conn?.effectiveType ?? '');
}

/**
 * On an "error" event: every <source> failed (the last one's error leaves
 * networkState at NETWORK_NO_SOURCE), or the one that loaded could not be
 * decoded. Only ever read on that event: while the parser is still adding
 * <source> children, networkState is NETWORK_NO_SOURCE too, until the browser
 * has picked one, so reading it at any other time would call a page that is
 * still loading a failure.
 */
const unplayable = (video: HTMLVideoElement) =>
  video.networkState === HTMLMediaElement.NETWORK_NO_SOURCE || Boolean(video.error);

/**
 * idle: poster and play button. loading: the visitor pressed play, no frame
 * yet (spinner). playing: a frame has played; native controls from here on.
 * failed: every source failed.
 */
type Phase = 'idle' | 'loading' | 'playing' | 'failed';

const FAILED_TEXT = 'The video didn’t load. The transcript below has every line of it.';

export function HeroDemoVideo({ label }: { label: string }) {
  const desktop = useSyncExternalStore(subscribe, isDesktop, onServer);
  const hydrated = desktop !== null;
  const ref = useRef<HTMLVideoElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  // The same, for the event handlers and the autoplay observer, which must
  // not wait for a render.
  const phaseRef = useRef<Phase>('idle');
  // Synchronously from event handlers, so focus can move to what renders
  // next; never from inside an effect (React refuses flushSync there).
  const go = (next: Phase, sync = true) => {
    phaseRef.current = next;
    if (sync) flushSync(() => setPhase(next));
    else setPhase(next);
  };
  const { desktop: wide, mobile: narrow } = HERO_DEMO;

  const playWithSound = () => {
    const video = ref.current;
    if (!video || phaseRef.current === 'failed') return;
    if (phaseRef.current === 'idle') go('loading');
    video.muted = false;
    video.play().catch(() => {
      // Refused or interrupted before a frame: offer the button again.
      if (phaseRef.current === 'loading') go('idle');
    });
  };

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    // Focus that was on the play button (or the video) follows the change,
    // rather than dropping to <body> when the button goes.
    const focusWasHere = () => {
      const active = document.activeElement;
      return active === buttonRef.current || active === video;
    };
    const onPlaying = (sync = true) => {
      if (phaseRef.current === 'playing' || phaseRef.current === 'failed') return;
      const refocus = focusWasHere();
      go('playing', sync);
      if (refocus) video.focus();
    };
    // A failed <source> fires "error" on the <source>, which does not bubble;
    // a capturing listener on the video still sees it.
    const onError = (sync = true) => {
      if (!unplayable(video) || phaseRef.current === 'failed') return;
      const refocus = focusWasHere();
      go('failed', sync);
      // A play() with no playable source leaves the element "playing".
      video.pause();
      if (refocus) statusRef.current?.focus();
    };
    // Played before hydration (nothing else can start it then), or a decode
    // error before it (a missing file cannot have failed yet: nothing loads
    // before play).
    if (video.error) onError(false);
    else if (!video.paused && video.readyState > 2) onPlaying(false);
    const playing = () => onPlaying();
    const error = () => onError();
    video.addEventListener('playing', playing);
    video.addEventListener('error', error, true);
    return () => {
      video.removeEventListener('playing', playing);
      video.removeEventListener('error', error, true);
    };
  }, []);

  useEffect(() => {
    const video = ref.current;
    if (!desktop || !video || typeof IntersectionObserver === 'undefined' || !autoplayAllowed()) return;

    // A play or pause event we did not ask for is the visitor's.
    let expected: 'play' | 'pause' | null = null;
    let visitorsNow = false;
    const onPlayPause = (e: Event) => {
      if (e.type === expected) expected = null;
      else visitorsNow = true;
    };
    const onVolume = () => {
      if (!video.muted) visitorsNow = true;
    };
    video.addEventListener('play', onPlayPause);
    video.addEventListener('pause', onPlayPause);
    video.addEventListener('volumechange', onVolume);

    const io = new IntersectionObserver(
      ([entry]) => {
        if (visitorsNow || video.ended || phaseRef.current === 'failed' || phaseRef.current === 'loading') return;
        if (entry.isIntersecting && video.paused) {
          video.muted = true;
          expected = 'play';
          video.play().catch(() => {
            expected = null;
          });
        } else if (!entry.isIntersecting && !video.paused) {
          expected = 'pause';
          video.pause();
        }
      },
      { threshold: 0.5 }
    );
    const observe = () => io.observe(video);
    if (document.readyState === 'complete') observe();
    else window.addEventListener('load', observe, { once: true });

    return () => {
      window.removeEventListener('load', observe);
      io.disconnect();
      video.removeEventListener('play', onPlayPause);
      video.removeEventListener('pause', onPlayPause);
      video.removeEventListener('volumechange', onVolume);
    };
  }, [desktop]);

  const playIcon = (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="ml-1 h-7 w-7 fill-current">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
  const disc =
    'flex h-16 w-16 items-center justify-center rounded-full bg-hp-primary text-hp-on-primary shadow-2xl transition-transform group-hover:scale-105';
  // Behind the video with JS (a frameless video without controls is
  // transparent). Without JS, Chrome shows a video's native controls whatever
  // its attributes say, and their grey panel would cover it, so <noscript>
  // repeats it on top (same URLs: one fetch).
  const posterPicture = (testId?: string) => (
    <picture>
      <source media={DESKTOP_QUERY} type="image/avif" srcSet={wide.posterAvif} width={wide.width} height={wide.height} />
      <source media={DESKTOP_QUERY} type="image/webp" srcSet={wide.posterWebp} width={wide.width} height={wide.height} />
      <source type="image/avif" srcSet={narrow.posterAvif} width={narrow.width} height={narrow.height} />
      <img
        src={narrow.posterWebp}
        width={narrow.width}
        height={narrow.height}
        alt=""
        loading="lazy"
        decoding="async"
        fetchPriority="low"
        className="absolute inset-0 h-full w-full object-contain"
        data-testid={testId}
      />
    </picture>
  );

  return (
    <div
      className="relative mx-auto aspect-[9/16] w-full max-w-[320px] overflow-hidden rounded-2xl border border-hp-border bg-hp-surface shadow-2xl md:aspect-video md:max-w-4xl"
      data-testid="hero-demo-box"
    >
      {posterPicture('hero-demo-poster')}
      <video
        ref={ref}
        className="absolute inset-0 h-full w-full object-contain"
        controls={phase === 'playing'}
        // Focusable before its controls exist, so focus can move to it.
        tabIndex={phase === 'playing' ? undefined : -1}
        playsInline
        preload="none"
        aria-label={label}
        data-testid="hero-demo-video"
      >
        <source src={wide.webm} media={DESKTOP_QUERY} type={WEBM_AV1_TYPE} />
        <source src={wide.mp4} media={DESKTOP_QUERY} type="video/mp4" />
        <source src={narrow.webm} type={WEBM_AV1_TYPE} />
        <source src={narrow.mp4} type="video/mp4" />
      </video>
      {/* Without JS: the poster on top, and the same button as a link to the MP4 for each width. */}
      <noscript>
        {posterPicture('hero-demo-poster-nojs')}
        <a
          href={narrow.mp4}
          aria-label={`${label} (MP4)`}
          className="group absolute inset-0 flex items-center justify-center md:hidden"
        >
          <span className={disc}>{playIcon}</span>
        </a>
        <a
          href={wide.mp4}
          aria-label={`${label} (MP4)`}
          className="group absolute inset-0 hidden items-center justify-center md:flex"
        >
          <span className={disc}>{playIcon}</span>
        </a>
      </noscript>
      {hydrated && (phase === 'idle' || phase === 'loading') ? (
        <button
          ref={buttonRef}
          type="button"
          onClick={playWithSound}
          aria-label={phase === 'loading' ? 'Loading the demo video' : 'Play the demo video'}
          aria-busy={phase === 'loading'}
          data-testid="hero-demo-play"
          data-phase={phase}
          className="group absolute inset-0 flex items-center justify-center"
        >
          <span className={disc}>
            {phase === 'loading' ? (
              <span aria-hidden="true" className="h-7 w-7 animate-spin rounded-full border-[3px] border-black/25 border-t-black motion-reduce:animate-none" />
            ) : (
              playIcon
            )}
          </span>
        </button>
      ) : null}
      {/* Always mounted and empty until a failure fills it, so screen readers
          announce the line (a live region inserted with its text often is not). */}
      <p
        ref={statusRef}
        role="status"
        tabIndex={-1}
        data-testid="hero-demo-status"
        className={
          phase === 'failed'
            ? 'absolute inset-x-3 bottom-3 rounded-lg bg-hp-bg/80 px-3 py-2 text-center text-xs text-hp-text/85 outline-none'
            : 'sr-only'
        }
      >
        {phase === 'failed' ? FAILED_TEXT : ''}
      </p>
    </div>
  );
}
