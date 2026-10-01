import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { GenerationSessionScope, StoryEntryType } from '@prisma/client';
import { SessionsService } from './sessions.service';

interface StartSessionBody {
  applicationId?: string;
  company?: string;
  scope?: GenerationSessionScope;
  entryType?: StoryEntryType;
  entryId?: string;
  entryLabel?: string;
}

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
  start(@Body() body: StartSessionBody) {
    // Backward compatible: existing frontend calls this with just
    // { applicationId } and no scope, which means scope=APPLICATION.
    const scope = body.scope ?? (body.applicationId ? 'APPLICATION' : undefined);
    if (!scope) throw new Error('scope is required (or pass applicationId for APPLICATION scope)');
    return this.sessions.start(
      scope,
      body.applicationId,
      body.company,
      body.entryType,
      body.entryId,
      body.entryLabel,
    );
  }

  @Post(':id/reply')
  reply(@Param('id') id: string, @Body() body: { message: string }) {
    return this.sessions.reply(id, body.message);
  }

  @Post(':id/accept')
  accept(@Param('id') id: string) {
    return this.sessions.accept(id);
  }

  @Post(':id/stop')
  stop(@Param('id') id: string) {
    return this.sessions.stop(id);
  }

  /** Called by the Python agent mid-run to post a live, one-line progress
   * update into the session's chat (see SessionsService.progress). */
  @Post(':id/progress')
  progress(@Param('id') id: string, @Body() body: { message: string }) {
    return this.sessions.progress(id, body.message);
  }
}
