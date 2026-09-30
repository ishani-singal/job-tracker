import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { ProfileFieldsInput, ResumeTemplateInput, ResumesService } from './resumes.service';

const AGENT_SERVICE_URL = process.env.RESU_AGENT_URL ?? 'http://localhost:8743';

@Controller('resumes')
export class ResumesController {
  constructor(private readonly resumes: ResumesService) {}

  @Post('stories/upload')
  async uploadStory(@Req() req: FastifyRequest) {
    const file = await req.file();
    if (!file) return { error: 'no file provided' };
    const buffer = await file.toBuffer();
    return this.resumes.saveStoryFile(file.filename, file.mimetype, buffer);
  }

  @Post('resume/upload')
  async uploadResume(@Req() req: FastifyRequest) {
    const file = await req.file();
    if (!file) return { error: 'no file provided' };
    const buffer = await file.toBuffer();
    return this.resumes.saveResumeFile(file.filename, file.mimetype, buffer);
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
