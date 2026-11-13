import { Resend } from 'resend';
import { EmailInterface } from '@hookpost/nestjs-libraries/emails/email.interface';

/**
 * Built on the first send, not when this file is imported.
 *
 * The Resend constructor throws "Missing API key" on an empty string, and
 * email.service.ts imports this module unconditionally - to pick between the
 * providers, EmptyProvider included, which is the one that means "do not
 * send". So building it at import time made a blank RESEND_API_KEY crash the
 * process before Nest started, and there was no way to run the backend with
 * email off: selectProvider() never got to choose. Found on 2026-10-29
 * bringing up the billing sandbox (ops/sandbox), which must not be able to
 * email a real customer and so has no key.
 *
 * Deferring it makes a missing key what it should always have been: a send
 * that fails and is caught below, not a dead process.
 */
let client: Resend | undefined;
const resend = () => (client ??= new Resend(process.env.RESEND_API_KEY || ''));

export class ResendProvider implements EmailInterface {
  name = 'resend';
  validateEnvKeys = ['RESEND_API_KEY'];
  async sendEmail(
    to: string,
    subject: string,
    html: string,
    emailFromName: string,
    emailFromAddress: string,
    replyTo?: string,
    text?: string
  ) {
    try {
      const sends = await resend().emails.send({
        from: `${emailFromName} <${emailFromAddress}>`,
        to,
        subject,
        html,
        ...(text && { text }),
        ...(replyTo && { reply_to: replyTo }),
      });
      // Resend answers a refused send with { error } instead of throwing:
      // that is a failure too, not a send (EmailService.sendEmailSync).
      if (!(sends as any)?.error) return sends;
      console.log(`Resend refused the email: ${(sends as any).error?.message}`);
    } catch (err) {
      console.log(err);
    }

    return { sent: false };
  }
}
