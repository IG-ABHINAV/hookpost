'use client';
import NextError from 'next/error';
import { useEffect } from 'react';
import { useVariables } from '@hookpost/react/helpers/variable.context';
import { reportClientEvent } from '@hookpost/frontend/components/layout/client.event';

// @sentry/nextjs is imported inside the effect, not at the top of the file.
// Next loads this boundary's module on EVERY page (it is the "G" entry of each
// page's RSC payload), so a static import put the Sentry SDK (~20KB gzipped)
// on every marketing page, where nothing ever initialises Sentry. It only
// loads now if an error actually reaches this boundary with a DSN set.
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  const { sentryDsn } = useVariables();

  // Production has no Sentry DSN, so this beacon is the only record that
  // someone saw this page.
  useEffect(() => {
    reportClientEvent('page_error', {
      reason: error?.digest
        ? `digest ${error.digest}`
        : String(error?.message || 'unknown'),
    });
  }, [error]);

  useEffect(() => {
    if (!sentryDsn) {
      return;
    }
    import('@sentry/nextjs')
      .then((Sentry) => {
        const eventId = Sentry.captureException(error);
        Sentry.showReportDialog({
          eventId,
          title: 'Something broke!',
          subtitle: 'Please help us fix the issue by providing some details.',
          labelComments: 'What happened?',
          labelName: 'Your name',
          labelEmail: 'Your email',
          labelSubmit: 'Send Report',
          lang: 'en',
        });
      })
      .catch(() => {});
  }, [error]);
  return (
    <html>
      <body>
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
