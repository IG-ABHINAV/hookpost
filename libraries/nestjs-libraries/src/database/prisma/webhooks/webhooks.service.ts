import { Injectable, NotFoundException } from '@nestjs/common';
import { WebhooksRepository } from '@hookpost/nestjs-libraries/database/prisma/webhooks/webhooks.repository';
import { WebhooksDto } from '@hookpost/nestjs-libraries/dtos/webhooks/webhooks.dto';

@Injectable()
export class WebhooksService {
  constructor(private _webhooksRepository: WebhooksRepository) {}

  getTotal(orgId: string) {
    return this._webhooksRepository.getTotal(orgId);
  }

  getWebhooks(orgId: string) {
    return this._webhooksRepository.getWebhooks(orgId);
  }

  createWebhook(orgId: string, body: WebhooksDto) {
    return this._webhooksRepository.createWebhook(orgId, body);
  }

  /**
   * PUT /webhooks: changes an existing webhook only. createWebhook upserts,
   * so passing it an unknown id would add a webhook without the plan check
   * POST /webhooks makes.
   */
  async updateWebhook(orgId: string, body: WebhooksDto) {
    if (!body.id || !(await this._webhooksRepository.findWebhook(orgId, body.id))) {
      throw new NotFoundException('Webhook not found');
    }
    return this._webhooksRepository.createWebhook(orgId, body);
  }

  deleteWebhook(orgId: string, id: string) {
    return this._webhooksRepository.deleteWebhook(orgId, id);
  }
}
