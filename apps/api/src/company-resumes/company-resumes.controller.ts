import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { CompanyResumesService } from './company-resumes.service';
import { renderResumeDocx, renderResumePdf } from '../applications/resume-pdf';
import { isStructuredResume } from '../applications/structured-resume-content';
import { ResumesService } from '../resumes/resumes.service';

@Controller('company-resumes')
export class CompanyResumesController {
  constructor(
    private readonly companyResumes: CompanyResumesService,
    private readonly resumes: ResumesService,
  ) {}

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

    const template = isStructuredResume(resume.resumeContent)
      ? await this.resumes.getResumeTemplate()
      : undefined;
    const profile = await this.resumes.getProfile();
    const pdf = await renderResumePdf(decoded, resume.resumeContent, template, profile.candidateName);
    const safeName = decoded.replace(/[^a-z0-9]+/gi, '-');
    res
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${safeName}-resume.pdf"`)
      .send(pdf);
  }

  @Get(':company/resume.docx')
  async downloadDocx(@Param('company') company: string, @Res() res: FastifyReply) {
    const decoded = decodeURIComponent(company);
    const resume = await this.companyResumes.getForCompany(decoded);
    if (!resume) throw new NotFoundException(`No resume generated yet for ${decoded}`);
    if (!isStructuredResume(resume.resumeContent)) {
      throw new NotFoundException('This resume predates Word export and must be regenerated to download as .docx');
    }

    const template = await this.resumes.getResumeTemplate();
    const profile = await this.resumes.getProfile();
    const docx = await renderResumeDocx(resume.resumeContent, template, profile.candidateName);
    const safeName = decoded.replace(/[^a-z0-9]+/gi, '-');
    res
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      .header('Content-Disposition', `attachment; filename="${safeName}-resume.docx"`)
      .send(docx);
  }
}
