import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { SessionsService } from './sessions.service';

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  listAll() {
    return this.sessions.listAll();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.sessions.get(id);
  }

  @Post()
  start(@Body() body: { applicationId: string }) {
    return this.sessions.start(body.applicationId);
  }

  @Post(':id/reply')
  reply(@Param('id') id: string, @Body() body: { message: string }) {
    return this.sessions.reply(id, body.message);
  }

  @Post(':id/accept')
  accept(@Param('id') id: string) {
    return this.sessions.accept(id);
  }
}
