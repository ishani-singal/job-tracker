import { Body, Controller, Delete, forwardRef, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { MultipartValue } from '@fastify/multipart';
import { ProfileFieldsInput, ResumeTemplateInput, ResumesService } from './resumes.service';
import { StoriesService } from '../stories/stories.service';
import { StoryEntryType } from '@prisma/client';

/** Reads the optional "backgroundType" field the upload form sends alongside
 * the file — the dropdown the user picks (Work Experience/Education/
 * Internship/Project/Paper) before uploading, so the extraction agent knows
 * which category of entries this whole document is about up front. */
function readBackgroundTypeField(file: { fields: Record<string, unknown> }): StoryEntryType | undefined {
  const field = file.fields?.backgroundType as MultipartValue<string> | undefined;
  const value = field?.value;
  return value && value in StoryEntryType ? (value as StoryEntryType) : undefined;
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
