import {
  Body,
  Controller,
  HttpException,
  Logger,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';
import { RazorpayClient } from '@hookpost/nestjs-libraries/services/razorpay.client';
import { ApiTags } from '@nestjs/swagger';
import {
  eventService,
  forwardToTablamigo,
} from '@hookpost/nestjs-libraries/services/tablamigo.forward';

@ApiTags('Razorpay')
@Controller('/razorpay')
export class RazorpayController {
  private readonly logger = new Logger(RazorpayController.name);
  private readonly client = new RazorpayClient();

  constructor(private readonly _razorpayService: RazorpayService) {}

  /**
   * Single webhook endpoint. Razorpay posts every subscribed event here, so the
   * service does the branching.
   *
   * The signature is computed over the raw bytes, which is why this reads
   * req.rawBody (enabled via `rawBody: true` in main.ts) rather than the parsed
   * body -- JSON.stringify of the parsed object would not round-trip byte-exact.
   */
  @Post(['/', '/webhook'])
  async webhook(@Req() req: RawBodyRequest<Request>) {
    let event: any;
    try {
      event = this._razorpayService.validateRequest(
        req.rawBody!,
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        req.headers['x-razorpay-signature'],
        process.env.RAZORPAY_WEBHOOK_SECRET!
      );
    } catch (e) {
      // A bad signature is not our bug -- reject it and do not retry.
      this.logger.warn(`Rejected Razorpay webhook: ${e}`);
      throw new HttpException('Invalid signature', 400);
    }

    // Tablamigo shares this Razorpay account but has no webhook of its own:
    // hand its events over. Not awaited, and it never throws, so Tablamigo
    // being slow or down cannot delay or fail this response.
    void forwardToTablamigo(req.rawBody!, event, {
      fetchPayment: (id) => this.client.request('GET', `/payments/${id}`),
      log: (m) => this.logger.warn(m),
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      eventId: req.headers['x-razorpay-event-id'],
    });

    // Ignore events originating from a different product sharing this account.
    // Payment notes count too (a payment.failed carries only a payment).
    const service = eventService(event);
    if (service && service !== 'hookpost') {
      return { ok: true };
    }

    try {
      return await this._razorpayService.handleWebhook(
        event,
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        req.headers['x-razorpay-event-id']
      );
    } catch (e) {
      this.logger.error(`Razorpay webhook handling failed: ${e}`);
      // 500 makes Razorpay retry with backoff, which is what we want for
      // transient database failures.
      throw new HttpException('Webhook handling failed', 500);
    }
  }

  /**
   * Called by the frontend right after the Razorpay Checkout modal succeeds.
   * The webhook is the source of truth for entitlements; this endpoint exists
   * so the UI can confirm the handshake instantly instead of polling.
   */
  @Post('/verify')
  async verify(
    @Body()
    body: {
      razorpay_payment_id: string;
      razorpay_subscription_id: string;
      razorpay_signature: string;
    }
  ) {
    const valid = this.client.verifySubscriptionPayment(
      body.razorpay_subscription_id,
      body.razorpay_payment_id,
      body.razorpay_signature
    );
    if (!valid) {
      throw new HttpException('Invalid payment signature', 400);
    }

    // Immediately provision entitlements so user never gets stuck on trial/billing page
    let trial = false;
    try {
      const synced = await this._razorpayService.syncSubscriptionById(
        body.razorpay_subscription_id
      );
      trial = !!synced?.trial;
    } catch (e) {
      this.logger.error(
        `Error auto-provisioning verified subscription ${body.razorpay_subscription_id}: ${e}`
      );
    }

    // A card issued outside India on a rupee mandate is logged, never refused
    // (refusing would lock out NRIs). Not awaited: one read-only Razorpay GET
    // that must not slow the answer the page is waiting for, and it never
    // throws.
    void this._razorpayService.noteInternationalInrAuth(
      body.razorpay_subscription_id,
      body.razorpay_payment_id
    );

    // `trial`: this checkout started a new trial. The page then goes on to
    // /launches and reports StartTrial with the same event id the server
    // used (trial_<subscription id>). False when unknown, and the page just
    // reloads as before.
    return { ok: true, trial };
  }
}
