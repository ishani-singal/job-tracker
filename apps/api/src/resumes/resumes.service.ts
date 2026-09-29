import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { extractTextFromFile } from './extract-text';

const UPLOAD_DIR = join(process.cwd(), '..', '..', 'data', 'uploads');

export interface ProfileFieldsInput {
  targetRoleArchetype?: string;
  disqualifierKeywords?: string[];
  locationZip?: string;
  maxYearsExperience?: number;
  matchScoreTarget?: number;
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

  async deleteStoryFile(id: string) {
    const file = await this.prisma.storyFile.findUnique({ where: { id } });
    if (!file) throw new NotFoundException(`Story file ${id} not found`);
    await this.prisma.storyFile.delete({ where: { id } });
    await unlink(join(UPLOAD_DIR, file.storedPath)).catch(() => {});
  }

  async deleteResumeFile(id: string) {
    const file = await this.prisma.resumeFile.findUnique({ where: { id } });
    if (!file) throw new NotFoundException(`Resume file ${id} not found`);
    await this.prisma.resumeFile.delete({ where: { id } });
    await unlink(join(UPLOAD_DIR, file.storedPath)).catch(() => {});
  }

  async getStoryFileText(id: string): Promise<string> {
    const file = await this.prisma.storyFile.findUnique({ where: { id } });
    if (!file) throw new NotFoundException(`Story file ${id} not found`);
    return extractTextFromFile(file.storedPath, file.mimeType);
  }

  async getResumeFileText(id: string): Promise<string> {
    const file = await this.prisma.resumeFile.findUnique({ where: { id } });
    if (!file) throw new NotFoundException(`Resume file ${id} not found`);
    return extractTextFromFile(file.storedPath, file.mimeType);
  }

  /** Concatenated text of every uploaded Stories file — what the agent actually reads. */
  async getAllStoriesText(): Promise<string> {
    const files = await this.listStoryFiles();
    const texts = await Promise.all(
      files.map(async (f) => {
        const text = await extractTextFromFile(f.storedPath, f.mimeType);
        return `--- ${f.filename} ---\n${text}`;
      }),
    );
    return texts.join('\n\n');
  }

  /** Concatenated text of every uploaded Resume file — formatting reference only. */
  async getAllResumeFilesText(): Promise<string> {
    const files = await this.listResumeFiles();
    const texts = await Promise.all(
      files.map(async (f) => {
        const text = await extractTextFromFile(f.storedPath, f.mimeType);
        return `--- ${f.filename} ---\n${text}`;
      }),
    );
    return texts.join('\n\n');
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
      ...(input.matchScoreTarget !== undefined && {
        matchScoreTarget: input.matchScoreTarget,
      }),
      ...(input.templateBody !== undefined && { templateBody: input.templateBody }),
    };
    return this.prisma.resumePromptTemplate.update({ where: { id: existing.id }, data });
  }
}

// Fixed skeleton — the 7-step ATS resume-optimization process. Role/candidate-specific
// facts live in the profile fields above and structured entries (entries.service.ts)
// get interpolated in at generation time (see agent/resu).
export const DEFAULT_TEMPLATE_BODY = `
Use "Stories" as primary source & "Resume" strictly as formatting reference.
First, deeply analyze Stories to understand context, responsibilities, impact, outcomes,
scope of ownership (budget, revenue, regions, stakeholders, engineering bredth vs depth,
areas of expertise), Enterprise surface area, strategic decisions, trade-offs evaluated,
and systems redesigned (not just tasks completed), Monetization, governance, & capital
allocation influence, Cross-functional authority vs influence. Build a clear internal
understanding of my professional background from this document, Then Build clear internal
model of the candidate's seniority level before generating anything.

You are a professional ATS-friendly Resume Optimization Assistant specialising in "Target
role archetype". Your goal is to tailor the resume to the job description so it passes ATS
scans with at least the target match score below and impresses hiring managers by
• Elevate seniority signal
• Align scope with role level
• Position as enterprise-level owner
• Remove mid-level framing
• Increase executive credibility

Steps to follow, in order:

Step 1: Company Search
then start researching the company for it's expectations for this role from candidates.
Subtly reflect those values wherever possible & applicable to stand out from rest of the
applicants.

Step 2: Keyword Match Analysis
scan the JD and ensure that you only use role description & requirements, preferred
qualification & skills required section or similar sections from uploaded info. Do not use
info such as compensation & benefits info, etc for further analysis. Then Scan the JD for
the 20 most important keywords/skills/experiences, prioritized by importance. Identify
which are present in the resume and which are missing. Use exact keyword form/tense for
best ATS match. Preserve exact phrasing found in the JD.

For e.g. So if JD says 'Develops vendor relationships inclusive of terms negotiations &
growth focused initiatives'
Keyword to be parsed will be-
'vendor relationships'
'terms negotiations'
'growth focused initiatives'
Once you have identified such keywords throughout JD, those exact keywords in the same
form & tense & structure should be used in the next steps to regenerate resume bullets.
Each bullet must be concise but detailed & follow the S.T.A.R. structure — Situation, Task,
Action, & Result. There should not be any fluff. Every bullet must end with a measurable,
concrete outcome. It's necessary to maintain the exact words as found in JD for a perfect
ATS match score.

Each role should be cohesive & point towards how it aligns with key responsibilities, do
not make any bullet generic. Highlight missing/weak keywords & prioritize incorporating
them in next steps. Incorporate them naturally in context of the projects that you will
identify in step 3.

Step 3: Expected Projects
List what someone hired for this role would be expected to do in the first 90 days,
based on the JD.

Step 4: Strength of Bullet Points
For each story, identify: system/product/initiative owned; scope (budget, revenue,
regions, stakeholders, users); strategic decisions and trade-offs; measurable business
impact.

Before writing each bullet:
• Determine JD level
• Elevate scope accordingly.
Elevation Rules
• Replace tactical verbs with ownership verbs
• Remove anecdotes & storytelling
• Make P&L, governance, roadmap, or capital influence explicit
• Eliminate vague phrases ("improved," "helped")

Regenerate each resume bullet with impactful results with numbers at the beginning (with
impactful number metrics) + followed by what actions were used to achieve those results +
followed by skills used to complete actions as a standard structure for all resume work
experience bullets. Regenerate all resume bullet points for matching projects in Step 3.
Feel free to orchestrate information about user for resume bullet when it is not
available. Ensure that you spread projects identified in step 3 through different work
experiences section of user's resume prioritizing the most important keywords & projects
in the most recent resume work experiences. Also understand the role, time spent at a job,
kind of company, industry of company & what it does to ensure that resume bullets you
generate are realistic, believable, true to the industry & role. When you regenerate, have
bold formatting for only the new keywords you have incorporated to the old bullets. If the
entire resume bullet is tweaked or regenerated, bold format the entire bullet to show user
the changes. Each resume bullet should make sense as a project from start to end & should
not be buzzword filled just for the sake of it.

Suggest improvements to ensure resume can pass ATS scan, targeting the match score given
below.
e.g.:
Bad resume bullet generation-
Developed lightweight analytics dashboards in Tableau that guided leadership decisions,
exemplifying scrappiness & operational excellence in hypergrowth setting
Better version-
Reduced executive team's weekly data preparation by 60% (8 to 3 hours) by rapidly
developing 5 Tableau analytics dashboards that streamlined critical business metrics,
demonstrating scrappiness & operational excellence during hypergrowth phase
Whenever you have metric in the bullet, always contextualize it.
For e.g. Instead of just saying 'reduced time by 30%', either say 'reduced time by 30%
(10 weeks to 7 weeks)' or say 'reduced time to 7 weeks vs. 10 weeks'. This ensures that
you are contextualizing numbers for higher impact.

Suggest additional bullets for particular work experience section if any specific skill is
difficult to fit in the existing or reworked bullets & would not make sense. Each work
experience should have minimum of 3 bullets & max of 5. Recent/longer work experiences
should have more bullets - at least 3.
If you find that user could be better fit for the role, if they change some of the job
titles on their resume, change those job titles directly while you regenerate the sections
& flag this to the user.
Try to generate new resume bullet content that's hyper-personalized to the role yet still
relevant to the candidate's work experience. Use as much of the existing resume content &
tweak it based on the projects identified if necessary.
Resume bullets should not be longer than 70 words or 2 lines. (whichever is shorter)

Step 5: Skills
Evaluate JD for technical & core skills required for the job. List top 5-8 technical
skills in additional/skills section of resume separated by commas with each word
capitalized. List most important core skills for the job under core skills section in the
resume in same format as technical skills.
e.g. of technicals skills include tools required to do the job most efficiently such as
SQL, Google Analytics, Asana, Trello, Power BI etc.
E.g of core skills include competencies such as Cross-functional Stakeholder management,
Financial Modeling, Project Management, Program Management etc.

Step 6: Grammar & Clarity
Check the entire resume for grammar, spelling, conciseness, and clarity. Suggest edits to
improve professionalism and readability.

Step 7: Ask the user any remaining questions needed to finalize the resume.
`.trim();
