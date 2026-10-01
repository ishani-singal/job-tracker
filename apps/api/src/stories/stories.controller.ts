import { BadRequestException, Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { StoriesService } from './stories.service';
import { StoryEntryType } from '@prisma/client';

function validateEntryType(entryType: string): StoryEntryType {
  if (!entryType || !(entryType in StoryEntryType)) {
    throw new BadRequestException(
      `entryType must be one of ${Object.values(StoryEntryType).join(', ')} — got "${entryType}"`,
    );
  }
  return entryType as StoryEntryType;
}

@Controller('stories')
export class StoriesController {
  constructor(private readonly stories: StoriesService) {}

  /** Also called directly by the resu/linkedin agents, so entryType is
   * validated here (a plain Nest route param gives no runtime checking)
   * rather than surfacing as an opaque 500 from an invalid Prisma enum
   * value. */
  @Get('document')
  getDocumentForEntry(@Query('entryType') entryType: string, @Query('entryId') entryId: string) {
    const validated = validateEntryType(entryType);
    if (!entryId) throw new BadRequestException('entryId is required');
    return this.stories.getDocumentForEntry(validated, entryId);
  }

  @Post('document/generate')
  generateDocumentForEntry(@Body() body: { entryType: string; entryId: string; entryLabel: string }) {
    const entryType = validateEntryType(body.entryType);
    if (!body.entryId) throw new BadRequestException('entryId is required');
    return this.stories.generateDocumentForEntry(entryType, body.entryId, body.entryLabel ?? body.entryId);
  }

  @Put('document')
  saveDocumentForEntry(@Body() body: { entryType: string; entryId: string; contentHtml: string }) {
    const entryType = validateEntryType(body.entryType);
    if (!body.entryId) throw new BadRequestException('entryId is required');
    return this.stories.saveDocumentForEntry(entryType, body.entryId, body.contentHtml ?? '');
  }
}
