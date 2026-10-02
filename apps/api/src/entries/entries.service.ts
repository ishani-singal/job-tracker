import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface DateRangeFields {
  location?: string;
  startMonth?: number;
  startYear?: number;
  endMonth?: number;
  endYear?: number;
  isPresent?: boolean;
}

interface BulletBoundsFields {
  minBullets?: number | null;
  maxBullets?: number | null;
}

export interface WorkExperienceInput extends DateRangeFields, BulletBoundsFields {
  company: string;
  title?: string;
  isFamilyBusiness?: boolean;
  required?: boolean;
  sortOrder?: number;
  allowRetitle?: boolean;
}

export interface EducationInput extends DateRangeFields {
  school: string;
  degree?: string;
  field?: string;
  required?: boolean;
  sortOrder?: number;
}

export interface InternshipInput extends DateRangeFields, BulletBoundsFields {
  company: string;
  title?: string;
  isClassProject?: boolean;
  isFamilyBusiness?: boolean;
  required?: boolean;
  sortOrder?: number;
}

export interface ProjectInput extends DateRangeFields, BulletBoundsFields {
  name: string;
  repoUrl?: string;
  liveUrl?: string;
  demoUrl?: string;
  required?: boolean;
  sortOrder?: number;
}

@Injectable()
export class EntriesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves whether a GitHub repo URL is public via an unauthenticated API
   * call — deliberately not the user's connected GitHub OAuth token, since
   * a project's repoUrl is a free-text field that need not even belong to
   * the connected account, and an unauthenticated 200 vs. 404/anything-else
   * is a direct, token-independent answer to "can a reviewer actually open
   * this link." Resolved once here, when repoUrl is set/changed, rather
   * than at resume-generation time, since visibility essentially never
   * changes once a repo exists and a live check on every generation would
   * just add latency for no benefit. Any failure (malformed URL, network
   * error, rate limit) resolves to false, so the renderer falls back to a
   * demo/live link rather than risk linking a reviewer to something they
   * can't open.
   */
  private async resolveRepoVisibility(repoUrl: string | undefined): Promise<boolean | null> {
    if (!repoUrl) return null;
    const match = repoUrl.match(/github\.com\/([^/]+\/[^/?#]+)/);
    if (!match) return false;
    const fullName = match[1].replace(/\.git$/, '');
    try {
      const response = await fetch(`https://api.github.com/repos/${fullName}`, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

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
  async createProject(input: ProjectInput) {
    const isRepoPublic = await this.resolveRepoVisibility(input.repoUrl);
    return this.prisma.projectEntry.create({ data: { ...input, isRepoPublic } });
  }
  async updateProject(id: string, input: Partial<ProjectInput>) {
    // Only re-resolve visibility when repoUrl is actually part of this
    // update — an edit to, say, just the title shouldn't trigger a GitHub
    // call or risk clobbering a previously-resolved value with nothing to
    // base it on.
    const isRepoPublic =
      input.repoUrl !== undefined ? await this.resolveRepoVisibility(input.repoUrl) : undefined;
    return this.prisma.projectEntry.update({
      where: { id },
      data: { ...input, ...(isRepoPublic !== undefined && { isRepoPublic }) },
    });
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
