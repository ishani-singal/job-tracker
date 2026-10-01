import { Body, Controller, Delete, forwardRef, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { MultipartValue } from '@fastify/multipart';
import { ProfileFieldsInput, ResumeTemplateInput, ResumesService } from './resumes.service';
import { StoriesService } from '../stories/stories.service';
import { StoryEntryType } from '@prisma/client';

/** Reads the optional "backgroundType"/"backgroundEntryId" fields the upload
 * form sends alongside the file — the two-step dropdown the user picks
 * (category, then the specific entry e.g. "Dell" under Work Experience)
 * before uploading, so the extraction agent knows which entry this whole
 * document is about up front, not just its category. */
function readMultipartField(
  file: { fields: Record<string, unknown> },
  name: string,
): string | undefined {
  const field = file.fields?.[name] as MultipartValue<string> | undefined;
  return field?.value || undefined;
}

function readBackgroundTypeField(file: { fields: Record<string, unknown> }): StoryEntryType | undefined {
  const value = readMultipartField(file, 'backgroundType');
  return value && value in StoryEntryType ? (value as StoryEntryType) : undefined;
}

function readBackgroundEntryIdField(file: { fields: Record<string, unknown> }): string | undefined {
  return readMultipartField(file, 'backgroundEntryId');
}

const AGENT_SERVICE_URL = process.env.RESU_AGENT_URL ?? 'http://localhost:8743';

@Controller('resumes')
export class ResumesController {
  constructor(
    private readonly resumes: ResumesService,
    @Inject(forwardRef(() => StoriesService))
    private readonly stories: StoriesService,
  ) {}

  @Post('stories/upload')
  async uploadStory(@Req() req: FastifyRequest) {
    const file = await req.file();
    if (!file) return { error: 'no file provided' };
    const buffer = await file.toBuffer();
    const saved = await this.resumes.saveStoryFile(file.filename, file.mimetype, buffer);
    // Auto-rerun parsing on every new upload — see StoriesService.
    this.stories.createParseRunForUpload({
      sourceType: 'STORY_FILE',
      storyFileId: saved.id,
      hintEntryType: readBackgroundTypeField(file),
      hintEntryId: readBackgroundEntryIdField(file),
    });
    return saved;
  }

  @Post('resume/upload')
  async uploadResume(@Req() req: FastifyRequest) {
    const file = await req.file();
    if (!file) return { error: 'no file provided' };
    const buffer = await file.toBuffer();
    const saved = await this.resumes.saveResumeFile(file.filename, file.mimetype, buffer);
    this.stories.createParseRunForUpload({
      sourceType: 'RESUME_FILE',
      resumeFileId: saved.id,
      hintEntryType: readBackgroundTypeField(file),
      hintEntryId: readBackgroundEntryIdField(file),
    });
    return saved;
  }

  @Get('stories')
  listStories() {
    return this.resumes.listStoryFiles();
  }

  @Get('files')
  listResumeFiles() {
    return this.resumes.listResumeFiles();
  }

  @Delete('stories/:id')
  deleteStory(@Param('id') id: string) {
    return this.resumes.deleteStoryFile(id);
  }

  @Delete('files/:id')
  deleteResumeFile(@Param('id') id: string) {
    return this.resumes.deleteResumeFile(id);
  }

  @Get('stories/text')
  getAllStoriesText() {
    return this.resumes.getAllStoriesText().then((text) => ({ text }));
  }

  @Get('files/text')
  getAllResumeFilesText() {
    return this.resumes.getAllResumeFilesText().then((text) => ({ text }));
  }

  @Get('profile')
  getProfile() {
    return this.resumes.getProfile();
  }

  @Patch('profile')
  updateProfile(@Body() body: ProfileFieldsInput) {
    return this.resumes.updateProfile(body);
  }

  @Get('template')
  getResumeTemplate() {
    return this.resumes.getResumeTemplate();
  }

  @Patch('template')
  updateResumeTemplate(@Body() body: ResumeTemplateInput) {
    return this.resumes.updateResumeTemplate(body);
  }

  @Get('prompt-preview')
  async promptPreview() {
    const response = await fetch(`${AGENT_SERVICE_URL}/prompt-preview`);
    if (!response.ok) {
      throw new Error(`Prompt preview request failed: ${response.status}`);
    }
    return response.json();
  }
}
