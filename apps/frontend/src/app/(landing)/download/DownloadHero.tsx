'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CHROME_EXTENSION_URL } from '@hookpost/frontend/components/layout/chrome.extension.url';

type DevicePlatform = 'mac-arm' | 'mac-intel' | 'windows' | 'android' | 'ios' | 'linux' | 'other';

// `offerNote` comes from the server page: this client component cannot read the
// build-time trial switch (trial-offer.ts), so it is passed down.
export function DownloadHero({ offerNote }: { offerNote: string }) {
  const [platform, setPlatform] = useState<DevicePlatform>('mac-arm');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const ua = navigator.userAgent || '';
    const platformStr = (navigator as any).userAgentData?.platform || navigator.platform || '';

    if (/android/i.test(ua)) {
      setPlatform('android');
    } else if (/iphone|ipad|ipod/i.test(ua)) {
      setPlatform('ios');
    } else if (/win/i.test(platformStr) || /windows/i.test(ua)) {
      setPlatform('windows');
    } else if (/mac/i.test(platformStr) || /macintosh/i.test(ua)) {
      // Check for Apple Silicon vs Intel
      const isAppleSilicon = /mac/i.test(platformStr) && (navigator.maxTouchPoints > 0 || !/intel/i.test(ua));
      setPlatform(isAppleSilicon ? 'mac-arm' : 'mac-intel');
    } else if (/linux/i.test(platformStr) || /linux/i.test(ua)) {
      setPlatform('linux');
    } else {
      setPlatform('other');
    }
  }, []);

  const getPrimaryButton = () => {
    switch (platform) {
      case 'mac-arm':
      case 'mac-intel':
        return {
          title: 'Use Hookpost on your Mac',
          subtitle: 'Runs in your browser • Sign up first, nothing to download',
          href: '/auth',
          icon: '🍏',
        };
      case 'windows':
        return {
          title: 'Use Hookpost on Windows',
          subtitle: 'Runs in your browser • Sign up first, nothing to download',
          href: '/auth',
          icon: '🪟',
        };
      case 'android':
        return {
          title: 'Add Hookpost to your Android home screen',
          subtitle: 'Sign up, then Chrome menu → Add to Home screen',
          href: '/auth',
          icon: '🤖',
        };
      case 'ios':
        return {
          title: 'Add to iPhone / iPad Home Screen',
          subtitle: 'Open in Safari → Share → Add to Home Screen',
          href: '/auth',
          icon: '📱',
        };
      default:
        return {
          title: 'Launch Hookpost Web App',
          subtitle: 'Works on any modern browser',
          href: '/auth',
          icon: '⚡',
        };
    }
  };

  const primary = getPrimaryButton();

  return (
    <div className="relative py-16 px-4 sm:px-6 lg:px-8 text-center max-w-5xl mx-auto">
      {/* Background radial glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(600px,100vw)] h-[350px] bg-gradient-to-tr from-hp-primary/20 via-hp-accent/10 to-hp-chart-3/15 rounded-full blur-[100px] pointer-events-none -z-10" />

      {/* Pill badge */}
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-hp-border text-xs font-medium text-hp-primary-text mb-6 backdrop-blur-md">
        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
        {mounted ? (platform.startsWith('mac') ? 'Detected macOS' : platform === 'windows' ? 'Detected Windows' : platform === 'android' ? 'Detected Android' : platform === 'ios' ? 'Detected iOS' : 'Universal Cloud & Desktop') : 'Detecting your device...'}
      </div>

      <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight text-hp-text mb-6 leading-tight">
        Post everywhere from <span className="text-hp-primary-text">your favorite device</span>
      </h1>

      <p className="text-lg sm:text-xl text-hp-text-2 max-w-2xl mx-auto mb-10 leading-relaxed">
        Schedule to LinkedIn, X, YouTube, Instagram, Facebook, and Threads with AI copilot. Runs in the browser on desktop and mobile, with {CHROME_EXTENSION_URL ? 'a Chrome extension and ' : ''}a Model Context Protocol (MCP) server for AI agents.
      </p>

      {/* Primary Auto-Detected CTA Button */}
      <div className="flex flex-col items-center justify-center gap-4 mb-8">
        <Link
          href={primary.href}
          className="group relative inline-flex items-center justify-center gap-3 px-8 py-4 rounded-xl text-lg font-bold text-hp-on-primary bg-hp-primary hover:bg-hp-primary-hover shadow-lg shadow-hp-primary/25 transition-all duration-200 transform hover:-translate-y-0.5 active:translate-y-0"
        >
          <span className="text-2xl">{primary.icon}</span>
          <div className="text-left">
            <div>{primary.title}</div>
            <div className="text-xs text-hp-on-primary/70 font-normal">{primary.subtitle}</div>
          </div>
        </Link>
        <span className="text-xs text-hp-text-2">
          {offerNote} • Zero setup fee • Cancel anytime
        </span>
      </div>
    </div>
  );
}
