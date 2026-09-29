import { BadRequestException, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { LinkedinDataService } from './linkedin-data.service';

@Controller('linkedin-data')
export class LinkedinDataController {
  constructor(private readonly linkedinData: LinkedinDataService) {}

  @Post('import')
  async importZip(@Req() req: FastifyRequest) {
    const file = await req.file();
    if (!file) throw new BadRequestException('No file provided');
    const buffer = await file.toBuffer();
    return this.linkedinData.importZip(buffer);
  }

  @Get('summary')
  getSummary() {
    return this.linkedinData.getLatestSummary();
  }

  @Get('connections')
  listConnections(@Query('search') search?: string) {
    return this.linkedinData.listConnections(search);
  }

  @Get('message-threads')
  listMessageThreads() {
    return this.linkedinData.listMessageThreads();
  }

  @Get('message-threads/:conversationId')
  getThreadMessages(@Param('conversationId') conversationId: string) {
    return this.linkedinData.getThreadMessages(conversationId);
  }
}
