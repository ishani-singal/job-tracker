import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';

const UPLOAD_DIR = join(process.cwd(), '..', '..', 'data', 'uploads');

export interface ProfileFieldsInput {
  targetRoleArchetype?: string;
  disqualifierKeywords?: string[];
  locationZip?: string;
  maxYearsExperience?: number;
  requiredExperienceEntries?: unknown[];
  requiredProjectEntries?: unknown[];
  templateBody?: string;
}

@Injectable()
export class ResumesService {
  constructor(private readonly prisma: PrismaService) {}

  private async persistFile(filename: string, buffer: Buffer) {
    await mkdir(UPLOAD_DIR, { recursive: true });
    const storedName = `${randomUUID()}-${filename}`;
    await writeFile(join(UPLOAD_DIR, storedName), buffer);
    return storedName;
  }

  async saveStoryFile(filename: string, mimeType: string, buffer: Buffer) {
    const storedPath = await this.persistFile(filename, buffer);
    return this.prisma.storyFile.create({ data: { filename, storedPath, mimeType } });
  }

  async saveResumeFile(filename: string, mimeType: string, buffer: Buffer) {
    const storedPath = await this.persistFile(filename, buffer);
    return this.prisma.resumeFile.create({ data: { filename, storedPath, mimeType } });
  }

  listStoryFiles() {
    return this.prisma.storyFile.findMany({ orderBy: { createdAt: 'desc' } });
  }

  listResumeFiles() {
    return this.prisma.resumeFile.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async getProfile() {
    const existing = await this.prisma.resumePromptTemplate.findFirst();
    if (existing) return existing;
    return this.prisma.resumePromptTemplate.create({
      data: { name: 'default', templateBody: DEFAULT_TEMPLATE_BODY },
    });
  }

  async updateProfile(input: ProfileFieldsInput) {
    const existing = await this.getProfile();
    const data: Prisma.ResumePromptTemplateUpdateInput = {
      ...(input.targetRoleArchetype !== undefined && {
        targetRoleArchetype: input.targetRoleArchetype,
      }),
      ...(input.disqualifierKeywords !== undefined && {
        disqualifierKeywords: input.disqualifierKeywords,
      }),
      ...(input.locationZip !== undefined && { locationZip: input.locationZip }),
      ...(input.maxYearsExperience !== undefined && {
        maxYearsExperience: input.maxYearsExperience,
      }),
      ...(input.requiredExperienceEntries !== undefined && {
        requiredExperienceEntries: input.requiredExperienceEntries as Prisma.InputJsonValue,
      }),
      ...(input.requiredProjectEntries !== undefined && {
        requiredProjectEntries: input.requiredProjectEntries as Prisma.InputJsonValue,
      }),
      ...(input.templateBody !== undefined && { templateBody: input.templateBody }),
    };
    return this.prisma.resumePromptTemplate.update({ where: { id: existing.id }, data });
  }
}

// Fixed skeleton extracted from the user's original prompt — the generic 7-step
// ATS resume-optimization process. Role/candidate-specific facts live in the
// profile fields above and get interpolated in at generation time (see agent/resu).
export const DEFAULT_TEMPLATE_BODY = `
Use "Stories" as primary source & "Resume" strictly as formatting reference.
First, deeply analyze Stories to understand context, responsibilities, impact, outcomes,
scope of ownership, strategic decisions, trade-offs, and systems redesigned. Build a clear
internal model of the candidate's seniority level before generating anything.

You are a professional ATS-friendly Resume Optimization Assistant. Your goal is to tailor
the resume to the job description so it passes ATS scans with at least a 93% match score
and impresses hiring managers.

Steps to follow, in order:

Step 1: Keyword Match Analysis
Scan the JD for the 20 most important keywords/skills/experiences, prioritized by
importance. Identify which are present in the resume and which are missing. Use exact
keyword form/tense for best ATS match. Preserve exact phrasing found in the JD.

Step 2: Expected Projects
List what someone hired for this role would be expected to do in the first 90 days,
based on the JD.

Step 3: Strength of Bullet Points
For each story, identify: system/product/initiative owned; scope (budget, revenue,
regions, stakeholders, users); strategic decisions and trade-offs; measurable business
impact. Replace tactical verbs with ownership verbs. Remove vague phrases like "improved"
or "helped." Make governance, roadmap, or capital influence explicit.

Regenerate each bullet with impactful results with numbers at the beginning, followed by
actions taken, followed by skills used. Bullets must follow STAR structure, be concise, and
end with a measurable outcome. Contextualize every metric (e.g. "reduced time by 30% (10
weeks to 7 weeks)"). Bullets should not exceed 70 words or 2 lines, whichever is shorter.
Each work experience should have 3-5 bullets; recent/longer roles get more.

Step 4: Skills
List the top 5-8 technical skills required by the JD in a Skills section, and the most
important core/competency skills in a separate Core Skills section, each comma-separated
and title-cased.

Step 5: Grammar & Clarity
Check the entire resume for grammar, spelling, conciseness, and clarity. Suggest edits to
improve professionalism and readability.

Step 6: Ask the user any remaining questions needed to finalize the resume.
`.trim();
