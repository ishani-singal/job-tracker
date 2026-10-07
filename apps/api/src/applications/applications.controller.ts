import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  ApplicationsService,
  CreateApplicationInput,
  UpdateApplicationInput,
} from './applications.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { renderResumeDocx, renderResumePdf } from './resume-pdf';
import { buildContactLine } from './contact-line';
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
  async downloadResumePdf(
    @Param('id') id: string,
    @Res() res: FastifyReply,
    @Query('inline') inline?: string,
  ) {
    const application = await this.applications.get(id);
    if (!application.resumeContent) {
      throw new NotFoundException('No resume has been generated for this application yet');
    }

    const title = [application.company, application.role].filter(Boolean).join(' — ');
    const template = isStructuredResume(application.resumeContent)
      ? await this.resumes.getResumeTemplate()
      : undefined;
    const profile = await this.resumes.getProfile();
    const pdf = await renderResumePdf(title || 'Resume', await this.resumes.applyResumeRules(application.resumeContent), template, profile.candidateName, buildContactLine(profile));

    const safeName = (application.company || 'resume').replace(/[^a-z0-9]+/gi, '-');
    // `inline=1` is used by the in-chat preview dialog, which embeds this in
    // an <iframe> — that only works with `inline`, since `attachment`
    // forces a download instead of rendering in the browser. The plain
    // download links elsewhere keep using `attachment` (the default, no
    // query param) so clicking them still saves a file as expected.
    const disposition = inline ? 'inline' : 'attachment';
    res
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `${disposition}; filename="${safeName}-resume.pdf"`)
      .send(pdf);
  }

  @Get(':id/resume.docx')
  async downloadResumeDocx(@Param('id') id: string, @Res() res: FastifyReply) {
    const application = await this.applications.get(id);
    if (!application.resumeContent) {
      throw new NotFoundException('No resume has been generated for this application yet');
    }
    if (!isStructuredResume(application.resumeContent)) {
      throw new NotFoundException('This resume predates Word export and must be regenerated to download as .docx');
    }

    const template = await this.resumes.getResumeTemplate();
    const profile = await this.resumes.getProfile();
    const docx = await renderResumeDocx(await this.resumes.applyResumeRules(application.resumeContent), template, profile.candidateName, buildContactLine(profile));

    const safeName = (application.company || 'resume').replace(/[^a-z0-9]+/gi, '-');
    res
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      .header('Content-Disposition', `attachment; filename="${safeName}-resume.docx"`)
      .send(docx);
  }
}
