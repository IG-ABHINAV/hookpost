'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { mutate } from 'swr';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { afterCheckout } from '@hookpost/frontend/components/billing/razorpay.billing';
import {
  checkoutOpenInThisPage,
  forgetPendingCheckout,
  PENDING_CHECKOUT_LEAVE_AFTER_MS,
  readPendingCheckout,
  waitForPendingCheckout,
} from '@hookpost/frontend/components/billing/pending.checkout';

export type PendingCheckoutView = 'none' | 'confirming' | 'timeout';

/**
 * For the paywall: when this tab opened a checkout whose result it never saw
 * (pending.checkout.ts), wait for the webhook to create the plan instead of
 * offering the checkout again. Runs when the paywall mounts and whenever the
 * tab becomes visible, e.g. on coming back from PhonePe or GPay.
 *
 * It only reads GET /billing/check/:id, which answers with the workspace's
 * Subscription row for that Razorpay id once the webhook has written it, so
 * it can never create a second subscription.
 *
 * A remembered checkout does not mean the customer approved anything: the tab
 * may have reloaded after they cancelled in their UPI app. So "Back to plans"
 * (canStartOver) shows after PENDING_CHECKOUT_LEAVE_AFTER_MS, and using it
 * stops the wait.
 */
export function usePendingCheckout() {
  const fetch = useFetch();
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  const [view, setView] = useState<PendingCheckoutView>('none');
  const [trial, setTrial] = useState(true);
  const [canStartOver, setCanStartOver] = useState(false);
  const running = useRef(false);
  const unmounted = useRef(false);
  // Bumped by "Back to plans": the wait in flight sees it and stops quietly.
  const generation = useRef(0);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearLeaveTimer = useCallback(() => {
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  }, []);

  const confirm = useCallback(async () => {
    // The modal is open in this page: its own handler finishes the job.
    if (running.current || checkoutOpenInThisPage()) return;
    const pending = readPendingCheckout();
    if (!pending) {
      setView('none');
      return;
    }
    running.current = true;
    const run = ++generation.current;
    const stale = () => unmounted.current || run !== generation.current;
    setTrial(pending.trial);
    setView('confirming');
    if (!leaveTimer.current) {
      leaveTimer.current = setTimeout(() => {
        leaveTimer.current = null;
        if (!stale()) setCanStartOver(true);
      }, PENDING_CHECKOUT_LEAVE_AFTER_MS);
    }
    const outcome = await waitForPendingCheckout({
      check: async () => {
        const res = await fetchRef.current(
          `/billing/check/${encodeURIComponent(pending.id)}`
        );
        if (!res.ok) return false;
        const body = await res.json().catch(() => null);
        return !!body?.status;
      },
      stopped: stale,
    });
    // "Back to plans" was used meanwhile: it already reset everything, and a
    // newer wait may own `running` by now.
    if (run !== generation.current) return;
    running.current = false;

    if (outcome === 'confirmed') {
      clearLeaveTimer();
      forgetPendingCheckout();
      void mutate('/user/self');
      // A trial goes on to connect channels (and its StartTrial), anything
      // else reloads, exactly as when the modal's handler runs.
      afterCheckout(pending.trial ? pending.id : null);
      return;
    }
    if (outcome === 'timeout') {
      clearLeaveTimer();
      setCanStartOver(true);
      setView('timeout');
    }
  }, [clearLeaveTimer]);

  useEffect(() => {
    unmounted.current = false;
    confirm();
    const onVisible = () => {
      if (document.visibilityState === 'visible') confirm();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      // The leave timer is not cleared here: it checks `unmounted` itself, and
      // a dev StrictMode remount keeps the wait (and so the timer) going.
      unmounted.current = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [confirm]);

  /**
   * The customer did not finish (or cancelled) in their payment app: stop
   * waiting and show the plans again.
   */
  const startOver = useCallback(() => {
    generation.current++;
    running.current = false;
    clearLeaveTimer();
    forgetPendingCheckout();
    setCanStartOver(false);
    setView('none');
  }, [clearLeaveTimer]);

  return { view, trial, canStartOver, checkAgain: confirm, startOver };
}
