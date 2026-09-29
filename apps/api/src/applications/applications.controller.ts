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

const AGENT_SERVICE_URL = process.env.RESU_AGENT_URL ?? 'http://localhost:8743';

@Controller('applications')
export class ApplicationsController {
  constructor(
    private readonly applications: ApplicationsService,
    private readonly analytics: AnalyticsService,
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

  @Post(':id/generate-resume')
  async generateResume(@Param('id') id: string) {
    await this.applications.get(id);
    const response = await fetch(`${AGENT_SERVICE_URL}/generate-resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ application_id: id }),
    });
    if (!response.ok) {
      throw new Error(`Resume agent request failed: ${response.status}`);
    }
    const { resume } = (await response.json()) as { resume: string };
    return this.applications.saveGeneratedResume(id, resume);
  }

  @Get(':id/resume.pdf')
  async downloadResumePdf(@Param('id') id: string, @Res() res: FastifyReply) {
    const application = await this.applications.get(id);
    if (!application.resumeContent) {
      throw new NotFoundException('No resume has been generated for this application yet');
    }

    const title = [application.company, application.role].filter(Boolean).join(' — ');
    const pdf = await renderResumePdf(title || 'Resume', application.resumeContent);

    const safeName = (application.company || 'resume').replace(/[^a-z0-9]+/gi, '-');
    res
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${safeName}-resume.pdf"`)
      .send(pdf);
  }
}
