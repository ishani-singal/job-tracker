import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  ApplicationsService,
  CreateApplicationInput,
  UpdateApplicationInput,
} from './applications.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { renderResumePdf } from './resume-pdf';
import { isStructuredResume } from './structured-resume-content';
import { ResumesService } from '../resumes/resumes.service';

@Controller('applications')
export class ApplicationsController {
  constructor(
    private readonly applications: ApplicationsService,
    private readonly analytics: AnalyticsService,
    private readonly resumes: ResumesService,
  ) {}

  @Get()
  async list() {
    const derived = await this.analytics.deriveAll();
    return derived.map((d) => ({ ...d.application, derivedStatus: d.status }));
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.applications.get(id);
  }

  @Post()
  create(@Body() body: CreateApplicationInput) {
    return this.applications.create(body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateApplicationInput) {
    return this.applications.update(id, body);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.applications.delete(id);
  }

  @Get(':id/resume.pdf')
  async downloadResumePdf(@Param('id') id: string, @Res() res: FastifyReply) {
    const application = await this.applications.get(id);
    if (!application.resumeContent) {
      throw new NotFoundException('No resume has been generated for this application yet');
    }

    const title = [application.company, application.role].filter(Boolean).join(' — ');
    const template = isStructuredResume(application.resumeContent)
      ? await this.resumes.getResumeTemplate()
      : undefined;
    const pdf = await renderResumePdf(title || 'Resume', application.resumeContent, template);

    const safeName = (application.company || 'resume').replace(/[^a-z0-9]+/gi, '-');
    res
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${safeName}-resume.pdf"`)
      .send(pdf);
  }
}
