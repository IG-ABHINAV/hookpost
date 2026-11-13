/**
 * MarketplaceService.when(): schedule_at within each plan's horizon (7 days
 * on a trial, 35 on a paid plan, so a cancelled subscriber's last posts
 * publish within days of their paid month). Posting itself runs against the
 * database in tests/integration/marketplace.int.spec.ts.
 *   pnpm exec jest -c apps/backend/jest.config.ts marketplace.service
 */
jest.mock('@hookpost/nestjs-libraries/integrations/integration.manager', () => ({ IntegrationManager: class {} }));
jest.mock('@hookpost/nestjs-libraries/database/prisma/posts/posts.service', () => ({ PostsService: class {} }));
jest.mock('@hookpost/nestjs-libraries/database/prisma/integrations/integration.service', () => ({ IntegrationService: class {} }));
jest.mock('@hookpost/nestjs-libraries/database/prisma/notifications/notification.service', () => ({ NotificationService: class {} }));
jest.mock('@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.account.repository', () => ({
  MarketplaceAccountRepository: class {},
}));
jest.mock('@hookpost/nestjs-libraries/upload/upload.factory', () => ({ UploadFactory: { createStorage: () => ({}) } }));
jest.mock('@hookpost/nestjs-libraries/chat/validation.schemas.helper', () => ({ getValidationSchemas: () => ({}) }));
jest.mock('@hookpost/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher', () => ({ ssrfSafeDispatcher: {} }));
jest.mock('file-type', () => ({ fileTypeFromBuffer: jest.fn() }));
jest.mock('@hookpost/backend/api/routes/posts.validation.exception', () => ({ PostValidationException: class extends Error {} }));

import { MarketplaceService } from '@hookpost/backend/marketplace-api/marketplace.service';
import { marketplacePlan } from '@hookpost/nestjs-libraries/marketplace/marketplace.plans';

const service = new MarketplaceService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
const ctx = (product: string, plan: string) => ({ plan: marketplacePlan(product, plan)! }) as any;
const NOW = new Date('2026-10-25T10:00:00Z');
const DAY = 86_400_000;

describe('when (schedule_at)', () => {
  it('takes "now" and "draft"', () => {
    expect(service.when(ctx('social', 'trial'), 'now', NOW)).toEqual({ type: 'now', date: NOW });
    expect(service.when(ctx('social', 'trial'), 'draft', NOW).type).toBe('draft');
  });

  it('takes an ISO time with a zone within the horizon', () => {
    const at = new Date(NOW.getTime() + 6 * DAY).toISOString();
    expect(service.when(ctx('social', 'trial'), at, NOW)).toEqual({ type: 'schedule', date: new Date(at) });
    expect(service.when(ctx('x', 'basic'), '2026-11-28T09:00:00+05:30', NOW).type).toBe('schedule');
  });

  it('refuses 8 days ahead on a trial and 36 on a paid plan', () => {
    const at = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();
    expect(() => service.when(ctx('social', 'trial'), at(8), NOW)).toThrow(/up to 7 days/);
    expect(() => service.when(ctx('social', 'standard'), at(34), NOW)).not.toThrow();
    expect(() => service.when(ctx('social', 'standard'), at(36), NOW)).toThrow(/up to 35 days/);
  });

  it('refuses the past (beyond a minute of clock skew), a time without a zone, and nonsense', () => {
    expect(() => service.when(ctx('social', 'pro'), '2026-10-25T09:58:00Z', NOW)).toThrow(/in the past/);
    expect(() => service.when(ctx('social', 'pro'), '2026-10-25T09:59:30Z', NOW)).not.toThrow();
    expect(() => service.when(ctx('social', 'pro'), '2026-10-26T09:00:00', NOW)).toThrow(/with a zone/);
    expect(() => service.when(ctx('social', 'pro'), 'tomorrow', NOW)).toThrow(/with a zone/);
  });
});
