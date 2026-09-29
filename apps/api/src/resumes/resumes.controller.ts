import { Body, Controller, Get, Patch, Post, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { ProfileFieldsInput, ResumesService } from './resumes.service';

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

  @Get('profile')
  getProfile() {
    return this.resumes.getProfile();
  }

  @Patch('profile')
  updateProfile(@Body() body: ProfileFieldsInput) {
    return this.resumes.updateProfile(body);
  }
}
