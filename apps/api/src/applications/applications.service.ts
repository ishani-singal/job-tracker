import {
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ApplicationStatus, Prisma } from '@prisma/client';
import { CompanyRolesService } from '../company-roles/company-roles.service';

export interface CreateApplicationInput {
  company: string;
  role?: string;
  jobUrl?: string;
  jobId?: string;
  jdText?: string;
  postedDate?: string;
  applyByDate?: string;
  salaryRange?: string;
  experienceLevel?: string;
  /** Set true to create anyway even if an Application with the same jobId
   * already exists — the caller (e.g. the "Add Application" dialog or the
   * browser extension) shows the duplicate and asks the user to confirm. */
  allowDuplicate?: boolean;
}

export interface NewContactInput {
  name?: string;
  linkedinUrl?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface UpdateApplicationInput extends Partial<CreateApplicationInput> {
  status?: ApplicationStatus;
  appliedDate?: string | null;
  lastMessageReceivedDate?: string | null;
  rejectedDate?: string | null;
  referredByContactId?: string | null;
}

@Injectable()
export class ApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => CompanyRolesService))
    private readonly companyRoles: CompanyRolesService,
  ) {}

  list() {
    return this.prisma.application.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async get(id: string) {
    const app = await this.prisma.application.findUnique({
      where: { id },
      include: {
        referredByContact: { select: { id: true, name: true } },
        appliedResume: { select: { filename: true, uploadedAt: true } },
      },
    });
    if (!app) throw new NotFoundException(`Application ${id} not found`);
    return app;
  }

  /** Contacts the user already has at this application's company ([] if none yet). */
  async listCompanyContacts(id: string) {
    const app = await this.get(id);
    const tracked = await this.companyRoles.findTrackedCompany(app.company);
    if (!tracked) return [];
    return this.prisma.companyContact.findMany({
      where: { companyId: tracked.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, linkedinUrl: true, email: true, phone: true },
    });
  }

  /** Adds a contact at this application's company, tracking the company first if needed. */
  async addCompanyContact(id: string, input: NewContactInput) {
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('name is required');
    const app = await this.get(id);
    let tracked = await this.companyRoles.findTrackedCompany(app.company);
    if (!tracked) {
      await this.companyRoles.ensureCompanyTracked(app.company, app.jobUrl ?? undefined);
      tracked = await this.companyRoles.findTrackedCompany(app.company);
    }
    if (!tracked) throw new NotFoundException(`Could not track company ${app.company}`);
    const clean = (v: string | null | undefined) => v?.trim() || null;
    return this.prisma.companyContact.create({
      data: {
        companyId: tracked.id,
        name,
        linkedinUrl: clean(input.linkedinUrl),
        email: clean(input.email),
        phone: clean(input.phone),
      },
      select: { id: true, name: true, linkedinUrl: true, email: true, phone: true },
    });
  }

  async saveAppliedResume(id: string, filename: string, mimeType: string, data: Buffer) {
    await this.get(id);
    await this.prisma.applicationAppliedResume.upsert({
      where: { applicationId: id },
      create: { applicationId: id, filename, mimeType, data: new Uint8Array(data) },
      update: { filename, mimeType, data: new Uint8Array(data), uploadedAt: new Date() },
    });
    return { filename };
  }

  async getAppliedResume(id: string) {
    const row = await this.prisma.applicationAppliedResume.findUnique({ where: { applicationId: id } });
    if (!row) throw new NotFoundException('No applied resume uploaded for this application');
    return row;
  }

  async findDuplicateByJobId(jobId: string) {
    return this.prisma.application.findFirst({
      where: { jobId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Falls back to a company+role match (case-insensitive) when jobId is
   * absent — catches the same posting appearing on two different boards
   * (e.g. a company's own careers site and LinkedIn), which never share a
   * jobId and would otherwise dedup as separate Applications. */
  async findDuplicateByCompanyAndRole(company: string, role: string) {
    return this.prisma.application.findFirst({
      where: {
        company: { equals: company, mode: 'insensitive' },
        role: { equals: role, mode: 'insensitive' },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(input: CreateApplicationInput) {
    if (!input.allowDuplicate) {
      const existing = input.jobId
        ? await this.findDuplicateByJobId(input.jobId)
        : input.role
          ? await this.findDuplicateByCompanyAndRole(input.company, input.role)
          : null;
      if (existing) {
        throw new ConflictException({
          message: input.jobId
            ? `An application for this posting (job ID ${input.jobId}) already exists.`
            : `An application for ${input.company} — ${input.role} already exists.`,
          duplicateOf: existing,
        });
      }
    }

    const data: Prisma.ApplicationCreateInput = {
      company: input.company,
      role: input.role,
      jobUrl: input.jobUrl,
      jobId: input.jobId,
      jdText: input.jdText,
      postedDate: input.postedDate ? new Date(input.postedDate) : undefined,
      applyByDate: input.applyByDate ? new Date(input.applyByDate) : undefined,
      salaryRange: input.salaryRange,
      experienceLevel: input.experienceLevel,
    };
    const application = await this.prisma.application.create({ data });

    // Fire-and-forget: every Application's company becomes trackable for
    // open-role discovery automatically, no separate "import" step — this
    // covers manual adds, the browser extension, the Shortcut, and selecting
    // a discovered role (which itself already has a TrackedCompany, so this
    // is a no-op there). Pass the jobUrl so discovery can derive the real
    // career-board root from it instead of guessing blind.
    this.companyRoles.ensureCompanyTracked(input.company, input.jobUrl);

    return application;
  }

  async update(id: string, input: UpdateApplicationInput) {
    await this.get(id);
    const data: Prisma.ApplicationUpdateInput = {
      ...(input.company !== undefined && { company: input.company }),
      ...(input.role !== undefined && { role: input.role }),
      ...(input.jobUrl !== undefined && { jobUrl: input.jobUrl }),
      ...(input.jobId !== undefined && { jobId: input.jobId }),
      ...(input.jdText !== undefined && { jdText: input.jdText }),
      ...(input.salaryRange !== undefined && { salaryRange: input.salaryRange }),
      ...(input.experienceLevel !== undefined && { experienceLevel: input.experienceLevel }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.referredByContactId !== undefined && {
        referredByContact: input.referredByContactId
          ? { connect: { id: input.referredByContactId } }
          : { disconnect: true },
      }),
      ...(input.postedDate !== undefined && {
        postedDate: input.postedDate ? new Date(input.postedDate) : null,
      }),
      ...(input.applyByDate !== undefined && {
        applyByDate: input.applyByDate ? new Date(input.applyByDate) : null,
      }),
      ...(input.appliedDate !== undefined && {
        appliedDate: input.appliedDate ? new Date(input.appliedDate) : null,
      }),
      ...(input.lastMessageReceivedDate !== undefined && {
        lastMessageReceivedDate: input.lastMessageReceivedDate
          ? new Date(input.lastMessageReceivedDate)
          : null,
      }),
      ...(input.rejectedDate !== undefined && {
        rejectedDate: input.rejectedDate ? new Date(input.rejectedDate) : null,
      }),
    };
    return this.prisma.application.update({ where: { id }, data });
  }

  async delete(id: string) {
    await this.get(id);
    return this.prisma.application.delete({ where: { id } });
  }
}
