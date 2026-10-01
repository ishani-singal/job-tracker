import { Controller, Get, Query } from '@nestjs/common';
import { StoriesService } from './stories.service';
import { StoryEntryType } from '@prisma/client';

@Controller('stories')
export class StoriesController {
  constructor(private readonly stories: StoriesService) {}

  /** Preview endpoint — lets the frontend show what generation would read
   * for a given entry, without actually generating a resume. */
  @Get('narratives')
  getNarrativesForEntry(
    @Query('entryType') entryType: StoryEntryType,
    @Query('entryId') entryId: string,
    @Query('entryLabel') entryLabel: string,
  ) {
    return this.stories.getNarrativesForEntry(entryType, entryId, entryLabel ?? entryId);
  }
}
