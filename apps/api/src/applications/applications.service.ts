import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ApplicationStatus, Prisma } from '@prisma/client';

export interface CreateApplicationInput {
  company: string;
  role?: string;
  jobUrl?: string;
  jdText?: string;
  postedDate?: string;
  applyByDate?: string;
  salaryRange?: string;
  experienceLevel?: string;
}

export interface UpdateApplicationInput extends Partial<CreateApplicationInput> {
  status?: ApplicationStatus;
  appliedDate?: string | null;
  lastMessageReceivedDate?: string | null;
  rejectedDate?: string | null;
}

@Injectable()
export class ApplicationsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.application.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async get(id: string) {
    const app = await this.prisma.application.findUnique({ where: { id } });
    if (!app) throw new NotFoundException(`Application ${id} not found`);
    return app;
  }

  create(input: CreateApplicationInput) {
    const data: Prisma.ApplicationCreateInput = {
      company: input.company,
      role: input.role,
      jobUrl: input.jobUrl,
      jdText: input.jdText,
      postedDate: input.postedDate ? new Date(input.postedDate) : undefined,
      applyByDate: input.applyByDate ? new Date(input.applyByDate) : undefined,
      salaryRange: input.salaryRange,
      experienceLevel: input.experienceLevel,
    };
    return this.prisma.application.create({ data });
  }

  async update(id: string, input: UpdateApplicationInput) {
    await this.get(id);
    const data: Prisma.ApplicationUpdateInput = {
      ...(input.company !== undefined && { company: input.company }),
      ...(input.role !== undefined && { role: input.role }),
      ...(input.jobUrl !== undefined && { jobUrl: input.jobUrl }),
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
