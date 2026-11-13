import * as Sentry from '@sentry/nextjs';
import { initializeSentryBasic } from '@hookpost/react/sentry/initialize.sentry.next.basic';
import { scrubSentryEvent } from '@hookpost/react/helpers/secret.url.params';

export const setSentryUser = (
  user?: { id: string; email?: string; orgId: string } | null
) => {
  try {
    if (user?.id) {
      Sentry.setUser({
        id: user.id,
        ...(user.email ? { email: user.email } : {}),
      });
      Sentry.setTag('organization.id', user.orgId);
    } else {
      Sentry.setUser(null);
      Sentry.setTag('organization.id', undefined);
    }
  } catch (err) {
    /* never let telemetry break the app */
  }
};

export const initializeSentryClient = (environment: string, dsn: string) =>
  initializeSentryBasic(environment, dsn, {
    integrations: [
      // Add default integrations back
      Sentry.browserTracingIntegration(),
      Sentry.browserProfilingIntegration(),
      Sentry.replayIntegration({
        maskAllText: false,
        maskAllInputs: false,
        blockAllMedia: false,
        // Replay's page-load entry carries the URL the page was opened with
        // (see scrubSentryEvent). Replay hands this hook its custom events
        // only, never the DOM snapshots.
        beforeAddRecordingEvent: (event: any) => scrubSentryEvent(event),
      }),
      Sentry.feedbackIntegration({
        // Disable the injection of the default widget
        autoInject: false,
        showEmail: false,
      }),
      Sentry.replayCanvasIntegration(),
    ],
    replaysSessionSampleRate: 1.0,
    replaysOnErrorSampleRate: 1.0,

    profilesSampleRate: environment === 'development' ? 1.0 : 0.75,
  });
