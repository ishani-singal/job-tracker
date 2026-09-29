import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface WorkExperienceInput {
  company: string;
  title?: string;
  yearIn?: number;
  yearOut?: number;
  required?: boolean;
  sortOrder?: number;
}

export interface EducationInput {
  school: string;
  degree?: string;
  year?: number;
  required?: boolean;
  sortOrder?: number;
}

export interface InternshipInput {
  company: string;
  year?: number;
  required?: boolean;
  sortOrder?: number;
}

export interface ProjectInput {
  name: string;
  repoUrl?: string;
  liveUrl?: string;
  year?: number;
  required?: boolean;
  sortOrder?: number;
}

@Injectable()
export class EntriesService {
  constructor(private readonly prisma: PrismaService) {}

  listWorkExperience() {
    return this.prisma.workExperienceEntry.findMany({ orderBy: { sortOrder: 'asc' } });
  }
  createWorkExperience(input: WorkExperienceInput) {
    return this.prisma.workExperienceEntry.create({ data: input });
  }
  updateWorkExperience(id: string, input: Partial<WorkExperienceInput>) {
    return this.prisma.workExperienceEntry.update({ where: { id }, data: input });
  }
  deleteWorkExperience(id: string) {
    return this.prisma.workExperienceEntry.delete({ where: { id } });
  }

  listEducation() {
    return this.prisma.educationEntry.findMany({ orderBy: { sortOrder: 'asc' } });
  }
  createEducation(input: EducationInput) {
    return this.prisma.educationEntry.create({ data: input });
  }
  updateEducation(id: string, input: Partial<EducationInput>) {
    return this.prisma.educationEntry.update({ where: { id }, data: input });
  }
  deleteEducation(id: string) {
    return this.prisma.educationEntry.delete({ where: { id } });
  }

  listInternships() {
    return this.prisma.internshipEntry.findMany({ orderBy: { sortOrder: 'asc' } });
  }
  createInternship(input: InternshipInput) {
    return this.prisma.internshipEntry.create({ data: input });
  }
  updateInternship(id: string, input: Partial<InternshipInput>) {
    return this.prisma.internshipEntry.update({ where: { id }, data: input });
  }
  deleteInternship(id: string) {
    return this.prisma.internshipEntry.delete({ where: { id } });
  }

  listProjects() {
    return this.prisma.projectEntry.findMany({ orderBy: { sortOrder: 'asc' } });
  }
  createProject(input: ProjectInput) {
    return this.prisma.projectEntry.create({ data: input });
  }
  updateProject(id: string, input: Partial<ProjectInput>) {
    return this.prisma.projectEntry.update({ where: { id }, data: input });
  }
  deleteProject(id: string) {
    return this.prisma.projectEntry.delete({ where: { id } });
  }

  /** All four lists together — what the resu agent actually consumes. */
  async getAll() {
    const [workExperience, education, internships, projects] = await Promise.all([
      this.listWorkExperience(),
      this.listEducation(),
      this.listInternships(),
      this.listProjects(),
    ]);
    return { workExperience, education, internships, projects };
  }
}
