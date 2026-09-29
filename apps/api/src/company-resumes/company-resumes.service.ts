import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CompanyResumesService {
  constructor(private readonly prisma: PrismaService) {}

  /** One row per distinct company that has at least one application, plus
   * whether a CompanyResume already exists and its updatedAt. */
  async listCompanies() {
    const applications = await this.prisma.application.findMany({
      select: { company: true },
    });
    const companies = [...new Set(applications.map((a) => a.company))].sort();

    const resumes = await this.prisma.companyResume.findMany();
    const resumeByCompany = new Map(resumes.map((r) => [r.company, r]));

    return companies.map((company) => ({
      company,
      hasResume: resumeByCompany.has(company),
      updatedAt: resumeByCompany.get(company)?.updatedAt ?? null,
    }));
  }

  getForCompany(company: string) {
    return this.prisma.companyResume.findUnique({ where: { company } });
  }
}
