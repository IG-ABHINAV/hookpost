import { Body, Controller, Get, HttpException, Param, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@hookpost/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@hookpost/nestjs-libraries/user/user.from.request';
import { AffiliateService } from '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.service';
import {
  AffiliateActiveDto,
  AffiliateMarkPaidDto,
  AffiliateNoteDto,
  AffiliatePayoutDto,
  AffiliateTermsDto,
} from '@hookpost/nestjs-libraries/dtos/affiliates/affiliate.dto';
import { assertJsonRequest } from '@hookpost/backend/services/auth/json.only';

@ApiTags('Affiliates')
@Controller('/affiliates')
export class AffiliatesController {
  constructor(private _affiliateService: AffiliateService) {}

  private assertAdmin(user: User) {
    if (!user.isSuperAdmin) {
      throw new HttpException('Unauthorized', 403);
    }
  }

  @Get('/me')
  async me(@GetUserFromRequest() user: User) {
    return { affiliate: await this._affiliateService.getMine(user.id) };
  }

  @Post('/join')
  async join(
    @GetUserFromRequest() user: User,
    @GetOrgFromRequest() org: Organization,
    @Body() body: AffiliatePayoutDto
  ) {
    await this._affiliateService.join(user, org, body.payoutDetails);
    return { affiliate: await this._affiliateService.getMine(user.id) };
  }

  @Post('/me/payout')
  async payout(
    @GetUserFromRequest() user: User,
    @Body() body: AffiliatePayoutDto
  ) {
    await this._affiliateService.updatePayout(user.id, body.payoutDetails || '');
    return { affiliate: await this._affiliateService.getMine(user.id) };
  }

  @Get('/admin')
  async admin(@GetUserFromRequest() user: User) {
    this.assertAdmin(user);
    return this._affiliateService.adminOverview();
  }

  @Post('/admin/commissions/paid')
  async markPaid(
    @GetUserFromRequest() user: User,
    @Body() body: AffiliateMarkPaidDto,
    @Req() req: Request
  ) {
    this.assertAdmin(user);
    // Commissions are money owed: never from another *.hookstep.in page's form.
    assertJsonRequest(req);
    return this._affiliateService.markPaid(body.ids, body.note);
  }

  @Post('/admin/commissions/:id/void')
  async voidCommission(
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: AffiliateNoteDto,
    @Req() req: Request
  ) {
    this.assertAdmin(user);
    assertJsonRequest(req);
    return this._affiliateService.voidCommission(id, body.note);
  }

  @Post('/admin/:id/terms')
  async setTerms(
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: AffiliateTermsDto,
    @Req() req: Request
  ) {
    this.assertAdmin(user);
    // What an affiliate is paid: never from another *.hookstep.in page's form.
    assertJsonRequest(req);
    return this._affiliateService.setTerms(id, {
      commissionPercent: body.commissionPercent,
      commissionMonths: body.commissionMonths,
    });
  }

  @Post('/admin/:id/active')
  async setActive(
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: AffiliateActiveDto,
    @Req() req: Request
  ) {
    this.assertAdmin(user);
    assertJsonRequest(req);
    return this._affiliateService.setActive(id, body.active);
  }
}
