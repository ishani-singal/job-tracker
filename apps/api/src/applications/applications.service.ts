import {
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

export interface UpdateApplicationInput extends Partial<CreateApplicationInput> {
  status?: ApplicationStatus;
  appliedDate?: string | null;
  lastMessageReceivedDate?: string | null;
  rejectedDate?: string | null;
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
    const app = await this.prisma.application.findUnique({ where: { id } });
    if (!app) throw new NotFoundException(`Application ${id} not found`);
    return app;
  }

  async findDuplicateByJobId(jobId: string) {
    return this.prisma.application.findFirst({
      where: { jobId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(input: CreateApplicationInput) {
    if (input.jobId && !input.allowDuplicate) {
      const existing = await this.findDuplicateByJobId(input.jobId);
      if (existing) {
        throw new ConflictException({
          message: `An application for this posting (job ID ${input.jobId}) already exists.`,
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
    // is a no-op there).
    this.companyRoles.ensureCompanyTracked(input.company);

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
