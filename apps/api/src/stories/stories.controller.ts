import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { StoriesService } from './stories.service';
import { StoryEntryType, StoryStatus } from '@prisma/client';

@Controller('stories')
export class StoriesController {
  constructor(private readonly stories: StoriesService) {}

  @Post('rerun')
  triggerManualRerun() {
    return this.stories.triggerManualRerun();
  }

  @Get('runs')
  listParseRuns() {
    return this.stories.listParseRuns();
  }

  @Get('runs/:id')
  getParseRun(@Param('id') id: string) {
    return this.stories.getParseRun(id);
  }

  @Get('candidates')
  listCandidates(
    @Query('status') status?: StoryStatus,
    @Query('entryType') entryType?: StoryEntryType,
    @Query('entryId') entryId?: string,
  ) {
    return this.stories.listCandidates({ status, entryType, entryId });
  }

  @Post('candidates/:id/confirm')
  confirmCandidate(@Param('id') id: string, @Body() body: { editedText?: string }) {
    return this.stories.confirmCandidate(id, body?.editedText);
  }

  @Post('candidates/:id/reject')
  rejectCandidate(@Param('id') id: string) {
    return this.stories.rejectCandidate(id);
  }

  @Post('candidates/:id/reassign')
  reassignCandidate(
    @Param('id') id: string,
    @Body() body: { entryType: StoryEntryType; entryId: string },
  ) {
    return this.stories.reassignCandidate(id, body.entryType, body.entryId);
  }

  @Post('candidates/:id/create-entry')
  createEntryFromCandidate(
    @Param('id') id: string,
    @Body() body: { entryType: StoryEntryType; entry: Record<string, unknown> },
  ) {
    return this.stories.createEntryFromCandidate(id, body.entryType, body.entry);
  }

  @Get('confirmed')
  listConfirmedStories() {
    return this.stories.listConfirmedStories();
  }
}
