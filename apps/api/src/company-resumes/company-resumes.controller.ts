import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { CompanyResumesService } from './company-resumes.service';
import { renderResumePdf } from '../applications/resume-pdf';

@Controller('company-resumes')
export class CompanyResumesController {
  constructor(private readonly companyResumes: CompanyResumesService) {}

  @Get()
  listCompanies() {
    return this.companyResumes.listCompanies();
  }

  @Get(':company')
  async getForCompany(@Param('company') company: string) {
    const resume = await this.companyResumes.getForCompany(decodeURIComponent(company));
    if (!resume) throw new NotFoundException(`No resume generated yet for ${company}`);
    return resume;
  }

  @Get(':company/resume.pdf')
  async downloadPdf(@Param('company') company: string, @Res() res: FastifyReply) {
    const decoded = decodeURIComponent(company);
    const resume = await this.companyResumes.getForCompany(decoded);
    if (!resume) throw new NotFoundException(`No resume generated yet for ${decoded}`);

    const pdf = await renderResumePdf(decoded, resume.resumeContent);
    const safeName = decoded.replace(/[^a-z0-9]+/gi, '-');
    res
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${safeName}-resume.pdf"`)
      .send(pdf);
  }
}
