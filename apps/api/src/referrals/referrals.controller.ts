import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ContactInput, ReferralsService } from './referrals.service';
import { renderResumeDocx, renderResumePdf } from '../applications/resume-pdf';
import { buildContactLine } from '../applications/contact-line';
import { isStructuredResume } from '../applications/structured-resume-content';
import { ResumesService } from '../resumes/resumes.service';

@Controller()
export class ReferralsController {
  constructor(
    private readonly referrals: ReferralsService,
    private readonly resumes: ResumesService,
  ) {}

  @Get('tracked-companies/:companyId/contacts')
  list(@Param('companyId') companyId: string) {
    return this.referrals.listContacts(companyId);
  }

  @Post('tracked-companies/:companyId/contacts')
  create(@Param('companyId') companyId: string, @Body() body: ContactInput) {
    return this.referrals.createContact(companyId, body);
  }

  @Patch('company-contacts/:id')
  update(@Param('id') id: string, @Body() body: ContactInput) {
    return this.referrals.updateContact(id, body);
  }

  @Delete('company-contacts/:id')
  remove(@Param('id') id: string) {
    return this.referrals.deleteContact(id);
  }

  @Post('company-contacts/:id/referral')
  startReferral(@Param('id') id: string, @Body() body: { tone: string; channel: string; roleIds: string[]; minScore?: number }) {
    return this.referrals.startReferral(id, body.tone, body.channel, body.roleIds, body.minScore);
  }

  @Get('referrals/:id/resume.pdf')
  async downloadPdf(@Param('id') id: string, @Res() res: FastifyReply) {
    const referral = await this.referrals.getReferral(id);
    const template = isStructuredResume(referral.resumeContent) ? await this.resumes.getResumeTemplate() : undefined;
    const profile = await this.resumes.getProfile();
    const company = referral.contact.company.name;
    const pdf = await renderResumePdf(company, await this.resumes.applyResumeRules(referral.resumeContent), template, profile.candidateName, buildContactLine(profile));
    const safeName = company.replace(/[^a-z0-9]+/gi, '-');
    res
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${safeName}-referral-resume.pdf"`)
      .send(pdf);
  }

  @Get('referrals/:id/resume.docx')
  async downloadDocx(@Param('id') id: string, @Res() res: FastifyReply) {
    const referral = await this.referrals.getReferral(id);
    if (!isStructuredResume(referral.resumeContent)) {
      throw new NotFoundException('This referral resume cannot be exported as .docx');
    }
    const template = await this.resumes.getResumeTemplate();
    const profile = await this.resumes.getProfile();
    const docx = await renderResumeDocx(await this.resumes.applyResumeRules(referral.resumeContent), template, profile.candidateName, buildContactLine(profile));
    const safeName = referral.contact.company.name.replace(/[^a-z0-9]+/gi, '-');
    res
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      .header('Content-Disposition', `attachment; filename="${safeName}-referral-resume.docx"`)
      .send(docx);
  }
}
