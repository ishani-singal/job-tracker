import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import type { StructuredResume } from '@job-tracker/shared-types';
import { measureOverflow } from '../applications/structured-resume-pdf';
import { buildContactLine } from '../applications/contact-line';
import { MultipartValue } from '@fastify/multipart';
import { ProfileFieldsInput, ResumeTemplateInput, ResumesService } from './resumes.service';
import { StoryEntryType } from '@prisma/client';

/** Reads the required "entryType"/"entryId" fields the upload form sends
 * alongside the file — the two-step dropdown the user picks (category, then
 * the specific entry e.g. "Dell" under Work Experience) before uploading.
 * Required: every Stories/Resume file must be pinned to exactly one entry
 * so that entry's "Generate Detailed Document" button knows which raw
 * sources to read (see StoriesService.getRawSourcesForEntry) — there is
 * no separate confirmation step to resolve an untagged upload later. */
function readMultipartField(
  file: { fields: Record<string, unknown> },
  name: string,
): string | undefined {
  const field = file.fields?.[name] as MultipartValue<string> | undefined;
  return field?.value || undefined;
}

function requireEntryFields(file: {
  fields: Record<string, unknown>;
}): { entryType: StoryEntryType; entryId: string } {
  const entryType = readMultipartField(file, 'entryType');
  const entryId = readMultipartField(file, 'entryId');
  if (!entryType || !(entryType in StoryEntryType) || !entryId) {
    throw new BadRequestException(
      'entryType and entryId are required — pick which background entry this file belongs to before uploading',
    );
  }
  return { entryType: entryType as StoryEntryType, entryId };
}

const AGENT_SERVICE_URL = process.env.RESU_AGENT_URL ?? 'http://localhost:8743';

@Controller('resumes')
export class ResumesController {
  constructor(private readonly resumes: ResumesService) {}

  @Post('stories/upload')
  async uploadStory(@Req() req: FastifyRequest) {
    const file = await req.file();
    if (!file) return { error: 'no file provided' };
    const { entryType, entryId } = requireEntryFields(file);
    const buffer = await file.toBuffer();
    const saved = await this.resumes.saveStoryFile(file.filename, file.mimetype, buffer, entryType, entryId);
    return saved;
  }

  @Post('resume/upload')
  async uploadResume(@Req() req: FastifyRequest) {
    const file = await req.file();
    if (!file) return { error: 'no file provided' };
    const { entryType, entryId } = requireEntryFields(file);
    const buffer = await file.toBuffer();
    const saved = await this.resumes.saveResumeFile(file.filename, file.mimetype, buffer, entryType, entryId);
    return saved;
  }

  @Get('stories')
  listStories() {
    return this.resumes.listStoryFiles();
  }

  @Get('files')
  listResumeFiles() {
    return this.resumes.listResumeFiles();
  }

  @Delete('stories/:id')
  async deleteStory(@Param('id') id: string) {
    await this.resumes.deleteStoryFile(id);
  }

  @Delete('files/:id')
  async deleteResumeFile(@Param('id') id: string) {
    await this.resumes.deleteResumeFile(id);
  }

  @Get('files/text')
  getAllResumeFilesText() {
    return this.resumes.getAllResumeFilesText().then((text) => ({ text }));
  }

  @Get('profile')
  getProfile() {
    return this.resumes.getProfile();
  }

  @Patch('profile')
  updateProfile(@Body() body: ProfileFieldsInput) {
    return this.resumes.updateProfile(body);
  }

  @Get('template')
  getResumeTemplate() {
    return this.resumes.getResumeTemplate();
  }

  /** Does this structured resume fit one page under the current template (with
   * every margin/font allowed to shrink to its minimum)? If not, by how many
   * lines does it overflow. Used by the referral pipeline's guideline checks. */
  @Post('fit-check')
  async fitCheck(@Body() body: StructuredResume) {
    const [template, profile] = await Promise.all([this.resumes.getResumeTemplate(), this.resumes.getProfile()]);
    // Measure with the same contact line that will be rendered.
    const content = { ...body, contactLine: buildContactLine(profile) || body.contactLine };
    const { fits, overflowPoints, bulletFont } = measureOverflow(content, template, profile.candidateName);
    return { fits, overflowLines: Math.ceil(overflowPoints / (bulletFont * 1.2)) };
  }

  @Patch('template')
  updateResumeTemplate(@Body() body: ResumeTemplateInput) {
    return this.resumes.updateResumeTemplate(body);
  }

  @Get('prompt-preview')
  async promptPreview() {
    const response = await fetch(`${AGENT_SERVICE_URL}/prompt-preview`);
    if (!response.ok) {
      throw new Error(`Prompt preview request failed: ${response.status}`);
    }
    return response.json();
  }
}
