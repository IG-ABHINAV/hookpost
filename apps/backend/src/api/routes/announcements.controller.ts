import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { GetUserFromRequest } from '@hookpost/nestjs-libraries/user/user.from.request';
import { User } from '@prisma/client';
import { ApiTags } from '@nestjs/swagger';
import { AnnouncementsService } from '@hookpost/nestjs-libraries/database/prisma/announcements/announcements.service';
import { AnnouncementDto } from '@hookpost/nestjs-libraries/dtos/announcements/announcements.dto';
import { assertJsonRequest } from '@hookpost/backend/services/auth/json.only';

@ApiTags('Announcements')
@Controller('/announcements')
export class AnnouncementsController {
  constructor(private _announcementsService: AnnouncementsService) {}

  @Get('/')
  async getAnnouncements() {
    return this._announcementsService.getAnnouncements();
  }

  @Post('/')
  async createAnnouncement(
    @GetUserFromRequest() user: User,
    @Body() body: AnnouncementDto,
    @Req() req: Request
  ) {
    if (!user.isSuperAdmin) {
      throw new HttpException('Unauthorized', 400);
    }
    // Shown to every user: never from another *.hookstep.in page's form.
    assertJsonRequest(req);
    return this._announcementsService.createAnnouncement(body);
  }

  @Delete('/:id')
  async deleteAnnouncement(
    @GetUserFromRequest() user: User,
    @Param('id') id: string
  ) {
    if (!user.isSuperAdmin) {
      throw new HttpException('Unauthorized', 400);
    }
    return this._announcementsService.deleteAnnouncement(id);
  }
}
