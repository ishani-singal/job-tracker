import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { StoriesService } from './stories.service';
import { StoryEntryType } from '@prisma/client';

@Controller('stories')
export class StoriesController {
  constructor(private readonly stories: StoriesService) {}

  /** Preview endpoint — lets the frontend show what generation would read
   * for a given entry, without actually generating a resume. Also called
   * directly by the resu/linkedin agents' tools, so entryType is validated
   * here (a plain Nest route param gives no runtime checking) rather than
   * surfacing as an opaque 500 from an invalid Prisma enum value — e.g. the
   * model guessing camelCase ("workExperience") instead of the Prisma
   * SCREAMING_SNAKE_CASE value. */
  @Get('narratives')
  getNarrativesForEntry(
    @Query('entryType') entryType: string,
    @Query('entryId') entryId: string,
    @Query('entryLabel') entryLabel: string,
  ) {
    if (!entryType || !(entryType in StoryEntryType)) {
      throw new BadRequestException(
        `entryType must be one of ${Object.values(StoryEntryType).join(', ')} — got "${entryType}"`,
      );
    }
    if (!entryId) {
      throw new BadRequestException('entryId is required');
    }
    return this.stories.getNarrativesForEntry(
      entryType as StoryEntryType,
      entryId,
      entryLabel ?? entryId,
    );
  }
}
