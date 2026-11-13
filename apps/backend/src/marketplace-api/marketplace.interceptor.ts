import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Response } from 'express';
import { from, Observable, of, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import {
  MarketplaceRequest,
  MktError,
} from '@hookpost/backend/marketplace-api/marketplace.context';
import { ledgerKeys, MarketplaceLedger } from '@hookpost/backend/marketplace-api/marketplace.ledger';

/** How long a POST or DELETE answer is kept for a repeat of the same call. */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 3600;

interface Stored {
  body: unknown;
  credits: number;
}

/**
 * Billing and repeats for every marketplace route.
 *
 * Billing: a handler sets req.mkt.credits for what it accepted; this writes
 * it in the marketplace's billing header on the 200 (api.market:
 * `X-Magicapi-Billing: API=<credits>;`; the middleware already set 0 for
 * everything else). Only a 200 is billed, which is why every
 * route answers 200 (@HttpCode(200) on POST and DELETE).
 *
 * Repeats (POST and DELETE): api.market's x-request-id (the adapter's
 * requestId; RapidAPI sets none), and a client's own Idempotency-Key, both
 * scoped to the subscriber on its marketplace (subscriberKey). The first call holds a
 * marker; a repeat while it runs gets 409, a repeat after it gets the same
 * answer and nothing is done again, so a gateway retry can never post one X
 * thread twice. A repeat of the same x-request-id is billed what the first
 * was (api.market retried because it saw no answer, so it billed nothing);
 * a new call that reuses an Idempotency-Key is billed 0, because api.market
 * already billed the first.
 */
@Injectable()
export class MarketplaceInterceptor implements NestInterceptor {
  constructor(private _ledger: MarketplaceLedger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<MarketplaceRequest>();
    const res = http.getResponse<Response>();
    const ctx = req.mkt;
    // The usage report in the call's marketplace's own header (api.market:
    // X-Magicapi-Billing: API=N;, RapidAPI: X-RapidAPI-Billing: Credits=N).
    const bill = (credits: number) => {
      if (!ctx) return;
      for (const [name, value] of Object.entries(ctx.adapter.billingHeaders(credits))) {
        res.setHeader(name, value);
      }
      ctx.billed = credits;
    };

    if (!ctx || !['POST', 'DELETE', 'PUT'].includes(req.method)) {
      return next.handle().pipe(
        mergeMap((body) => {
          bill(ctx?.credits || 0);
          return of(body);
        })
      );
    }

    const keys: { key: string; billedAgain: boolean }[] = [];
    if (ctx.requestId) {
      keys.push({
        key: ledgerKeys.idemRequest(ctx.product, ctx.subscriberKey, ctx.requestId),
        billedAgain: true,
      });
    }
    if (ctx.idempotencyKey) {
      keys.push({
        key: ledgerKeys.idemKey(ctx.product, ctx.subscriberKey, ctx.idempotencyKey),
        billedAgain: false,
      });
    }

    return from(this.claimAll(keys)).pipe(
      mergeMap((claim) => {
        if (claim.kind === 'replay') {
          bill(claim.billedAgain ? claim.stored.credits : 0);
          res.setHeader('Idempotent-Replay', 'true');
          return of(claim.stored.body);
        }
        if (claim.kind === 'busy') {
          return throwError(
            () =>
              new MktError(
                409,
                'request_in_progress',
                'The same call is still running. Retry in a few seconds.'
              )
          );
        }
        const held = claim.held;
        return next.handle().pipe(
          mergeMap((body) =>
            from(
              (async () => {
                const stored: Stored = { body, credits: ctx.credits || 0 };
                await Promise.all(
                  held.map((k) =>
                    this._ledger
                      .store(k, JSON.stringify(stored), IDEMPOTENCY_TTL_SECONDS)
                      .catch(() => undefined)
                  )
                );
                bill(stored.credits);
                return body;
              })()
            )
          ),
          catchError((err) =>
            from(
              Promise.all(held.map((k) => this._ledger.release(k).catch(() => undefined)))
            ).pipe(mergeMap(() => throwError(() => err)))
          )
        );
      })
    );
  }

  private async claimAll(
    keys: { key: string; billedAgain: boolean }[]
  ): Promise<
    | { kind: 'go'; held: string[] }
    | { kind: 'replay'; stored: Stored; billedAgain: boolean }
    | { kind: 'busy' }
  > {
    const held: string[] = [];
    for (const { key, billedAgain } of keys) {
      if (await this._ledger.claim(key, IDEMPOTENCY_TTL_SECONDS)) {
        held.push(key);
        continue;
      }
      // Someone has it: give back what this call took and answer as they did.
      await Promise.all(held.map((k) => this._ledger.release(k).catch(() => undefined)));
      const value = await this._ledger.read(key);
      if (!value || value === 'pending') return { kind: 'busy' };
      try {
        return { kind: 'replay', stored: JSON.parse(value), billedAgain };
      } catch {
        return { kind: 'busy' };
      }
    }
    return { kind: 'go', held };
  }
}
