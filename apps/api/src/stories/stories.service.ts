import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ResumesService } from '../resumes/resumes.service';
import { EntriesService } from '../entries/entries.service';
import { GithubService } from '../github/github.service';
import { StoryEntryType, StorySourceType, StoryStatus } from '@prisma/client';

const AGENT_SERVICE_URL = process.env.RESU_AGENT_URL ?? 'http://localhost:8743';

interface ExtractCandidate {
  entry_type: string | null;
  entry_id: string | null;
  new_entry_label: string | null;
  source_span: string;
  story_text: string;
  confidence: number;
}

interface ExtractResponse {
  candidates: ExtractCandidate[];
}

const ENTRY_TYPE_TO_PRISMA: Record<string, StoryEntryType> = {
  workExperience: StoryEntryType.WORK_EXPERIENCE,
  education: StoryEntryType.EDUCATION,
  internship: StoryEntryType.INTERNSHIP,
  project: StoryEntryType.PROJECT,
  paper: StoryEntryType.PAPER,
};

export interface RerunTrigger {
  sourceType?: StorySourceType;
  storyFileId?: string;
  resumeFileId?: string;
  repoFullName?: string;
}

@Injectable()
export class StoriesService {
  private readonly logger = new Logger(StoriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resumes: ResumesService,
    private readonly entries: EntriesService,
    private readonly github: GithubService,
  ) {}

  // ---- Parse runs ----------------------------------------------------

  listParseRuns() {
    return this.prisma.storyParseRun.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
  }

  async getParseRun(id: string) {
    const run = await this.prisma.storyParseRun.findUnique({
      where: { id },
      include: { candidates: true },
    });
    if (!run) throw new NotFoundException(`Parse run ${id} not found`);
    return run;
  }

  /** Triggered by a Stories/Resume upload — parses only the new file. */
  async createParseRunForUpload(trigger: RerunTrigger) {
    const run = await this.prisma.storyParseRun.create({
      data: {
        status: 'PENDING',
        triggerSourceType: trigger.sourceType,
        triggerStoryFileId: trigger.storyFileId,
        triggerResumeFileId: trigger.resumeFileId,
        triggerRepoFullName: trigger.repoFullName,
      },
    });
    this.runParseInBackground(run.id, trigger);
    return run;
  }

  /** Manual rerun — re-examines every currently uploaded file + connected repo. */
  async triggerManualRerun() {
    const run = await this.prisma.storyParseRun.create({ data: { status: 'PENDING' } });
    this.runParseInBackground(run.id, {});
    return run;
  }

  private async runParseInBackground(runId: string, trigger: RerunTrigger) {
    try {
      await this.prisma.storyParseRun.update({ where: { id: runId }, data: { status: 'PARSING' } });

      const sources = await this.gatherSources(trigger);
      const entries = await this.entries.getAll();
      const papers = await this.prisma.paperEntry.findMany({ orderBy: { sortOrder: 'asc' } });
      const entriesForMatching = { ...entries, papers };

      let anyCandidates = false;
      for (const source of sources) {
        if (!source.text.trim()) continue;
        const response = await this.callExtract(source.text, source.sourceType, source.label, entriesForMatching);
        const created = await this.reconcileCandidates(runId, source, response.candidates);
        anyCandidates = anyCandidates || created > 0;
      }

      await this.prisma.storyParseRun.update({
        where: { id: runId },
        data: { status: anyCandidates ? 'AWAITING_REVIEW' : 'DONE' },
      });
    } catch (err) {
      this.logger.error(`Parse run ${runId} failed: ${err}`);
      await this.prisma.storyParseRun.update({
        where: { id: runId },
        data: { status: 'ERROR', errorMessage: String(err) },
      });
    }
  }

  private async callExtract(
    rawText: string,
    sourceType: 'story_file' | 'resume_file' | 'github_repo',
    sourceLabel: string,
    entries: Record<string, unknown>,
  ): Promise<ExtractResponse> {
    const response = await fetch(`${AGENT_SERVICE_URL}/stories/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        raw_text: rawText,
        source_type: sourceType,
        source_label: sourceLabel,
        entries,
      }),
    });
    if (!response.ok) {
      throw new Error(`Agent /stories/extract failed: ${response.status}`);
    }
    return response.json();
  }

  /**
   * Gathers raw text per source — one entry per file/repo, never
   * concatenated — so each /stories/extract call's provenance stays clean.
   * An empty trigger (manual rerun) re-examines everything currently
   * uploaded/connected; a specific trigger parses only that one new source.
   */
  private async gatherSources(trigger: RerunTrigger): Promise<
    {
      sourceType: 'story_file' | 'resume_file' | 'github_repo';
      storyFileId?: string;
      resumeFileId?: string;
      repoFullName?: string;
      label: string;
      text: string;
    }[]
  > {
    const isManualRerun = !trigger.sourceType;

    const sources: {
      sourceType: 'story_file' | 'resume_file' | 'github_repo';
      storyFileId?: string;
      resumeFileId?: string;
      repoFullName?: string;
      label: string;
      text: string;
    }[] = [];

    if (isManualRerun || trigger.sourceType === 'STORY_FILE') {
      const files = trigger.storyFileId
        ? (await this.resumes.listStoryFiles()).filter((f) => f.id === trigger.storyFileId)
        : await this.resumes.listStoryFiles();
      for (const f of files) {
        const text = await this.resumes.getStoryFileText(f.id);
        sources.push({ sourceType: 'story_file', storyFileId: f.id, label: f.filename, text });
      }
    }

    if (isManualRerun || trigger.sourceType === 'RESUME_FILE') {
      const files = trigger.resumeFileId
        ? (await this.resumes.listResumeFiles()).filter((f) => f.id === trigger.resumeFileId)
        : await this.resumes.listResumeFiles();
      for (const f of files) {
        const text = await this.resumes.getResumeFileText(f.id);
        sources.push({ sourceType: 'resume_file', resumeFileId: f.id, label: f.filename, text });
      }
    }

    if (isManualRerun || trigger.sourceType === 'GITHUB_REPO') {
      try {
        const repos = await this.github.fetchConnectedRepoDetails();
        const filtered = trigger.repoFullName
          ? repos.filter((r) => r.repo === trigger.repoFullName)
          : repos;
        for (const r of filtered) {
          const text = [
            `Repository: ${r.repo}`,
            r.description ? `Description: ${r.description}` : '',
            r.topics.length ? `Topics: ${r.topics.join(', ')}` : '',
            r.languages.length ? `Languages: ${r.languages.join(', ')}` : '',
            r.rootFiles.length ? `Root files: ${r.rootFiles.join(', ')}` : '',
            r.readme ? `README:\n${r.readme}` : '',
          ]
            .filter(Boolean)
            .join('\n');
          sources.push({ sourceType: 'github_repo', repoFullName: r.repo, label: r.repo, text });
        }
      } catch {
        // GitHub not connected — not an error, just nothing extra here.
      }
    }

    return sources;
  }

  /** Applies the diff/rerun reconciliation algorithm — see plan §"Diff/rerun". */
  private async reconcileCandidates(
    runId: string,
    source: { sourceType: string; storyFileId?: string; resumeFileId?: string; repoFullName?: string },
    candidates: ExtractCandidate[],
  ): Promise<number> {
    let created = 0;
    for (const c of candidates) {
      const entryType = c.entry_type ? ENTRY_TYPE_TO_PRISMA[c.entry_type] : null;

      if (entryType && c.entry_id) {
        const existing = await this.prisma.candidateStory.findUnique({
          where: { entryType_entryId: { entryType, entryId: c.entry_id } },
        });
        if (existing && existing.status === 'CONFIRMED' && existing.storyText.trim() === c.story_text.trim()) {
          continue; // no-op: nothing changed, don't pester the user
        }
        await this.prisma.storyCandidate.create({
          data: {
            parseRunId: runId,
            sourceType: source.sourceType as StorySourceType,
            storyFileId: source.storyFileId,
            resumeFileId: source.resumeFileId,
            repoFullName: source.repoFullName,
            entryType,
            entryId: c.entry_id,
            sourceSpanText: c.source_span,
            proposedStoryText: c.story_text,
            confidence: c.confidence,
            status: existing && existing.status === 'CONFIRMED' ? 'PROPOSED_UPDATE' : 'PROPOSED',
          },
        });
        created += 1;
        continue;
      }

      // New-entry proposal — always inserted, nothing to diff against.
      await this.prisma.storyCandidate.create({
        data: {
          parseRunId: runId,
          sourceType: source.sourceType as StorySourceType,
          storyFileId: source.storyFileId,
          resumeFileId: source.resumeFileId,
          repoFullName: source.repoFullName,
          entryType,
          newEntryLabel: c.new_entry_label,
          sourceSpanText: c.source_span,
          proposedStoryText: c.story_text,
          confidence: c.confidence,
          status: 'PROPOSED',
        },
      });
      created += 1;
    }
    return created;
  }

  // ---- Candidate review ------------------------------------------------

  listCandidates(filter?: { status?: StoryStatus; entryType?: StoryEntryType; entryId?: string }) {
    return this.prisma.storyCandidate.findMany({
      where: {
        status: filter?.status,
        entryType: filter?.entryType,
        entryId: filter?.entryId,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async getCandidateOrThrow(id: string) {
    const candidate = await this.prisma.storyCandidate.findUnique({ where: { id } });
    if (!candidate) throw new NotFoundException(`Story candidate ${id} not found`);
    return candidate;
  }

  async confirmCandidate(id: string, editedText?: string) {
    const candidate = await this.getCandidateOrThrow(id);
    if (!candidate.entryType || !candidate.entryId) {
      throw new BadRequestException(
        'Candidate has no assigned entry yet — reassign or create an entry first',
      );
    }
    const storyText = editedText ?? candidate.proposedStoryText;
    const userEdited = editedText !== undefined && editedText.trim() !== candidate.proposedStoryText.trim();

    const story = await this.prisma.candidateStory.upsert({
      where: { entryType_entryId: { entryType: candidate.entryType, entryId: candidate.entryId } },
      create: {
        entryType: candidate.entryType,
        entryId: candidate.entryId,
        storyText,
        userEdited,
        status: 'CONFIRMED',
        sourceCandidateId: candidate.id,
        confirmedAt: new Date(),
      },
      update: {
        storyText,
        userEdited,
        status: 'CONFIRMED',
        sourceCandidateId: candidate.id,
        confirmedAt: new Date(),
      },
    });

    await this.prisma.storyCandidate.update({
      where: { id },
      data: { status: 'CONFIRMED', resultingStoryId: story.id },
    });

    return story;
  }

  async rejectCandidate(id: string) {
    await this.getCandidateOrThrow(id);
    return this.prisma.storyCandidate.update({ where: { id }, data: { status: 'REJECTED' } });
  }

  async reassignCandidate(id: string, entryType: StoryEntryType, entryId: string) {
    await this.getCandidateOrThrow(id);
    return this.prisma.storyCandidate.update({
      where: { id },
      data: { entryType, entryId, newEntryLabel: null, newEntryDates: undefined },
    });
  }

  /** Resolves a "propose a new entry" candidate by actually creating that entry. */
  async createEntryFromCandidate(id: string, entryType: StoryEntryType, entryPayload: Record<string, unknown>) {
    const candidate = await this.getCandidateOrThrow(id);

    let entryId: string;
    if (entryType === 'WORK_EXPERIENCE') {
      entryId = (await this.entries.createWorkExperience(entryPayload as never)).id;
    } else if (entryType === 'EDUCATION') {
      entryId = (await this.entries.createEducation(entryPayload as never)).id;
    } else if (entryType === 'INTERNSHIP') {
      entryId = (await this.entries.createInternship(entryPayload as never)).id;
    } else if (entryType === 'PROJECT') {
      entryId = (await this.entries.createProject(entryPayload as never)).id;
    } else {
      throw new BadRequestException(
        'Creating a new Paper entry from a story candidate is not supported yet — no Paper CRUD exists in this app',
      );
    }

    await this.prisma.storyCandidate.update({
      where: { id: candidate.id },
      data: { entryType, entryId, newEntryLabel: null },
    });

    return this.confirmCandidate(id);
  }

  // ---- Confirmed stories (generation read path) ------------------------

  listConfirmedStories() {
    return this.prisma.candidateStory.findMany({ where: { status: 'CONFIRMED' } });
  }

  async getConfirmedStory(entryType: StoryEntryType, entryId: string) {
    return this.prisma.candidateStory.findUnique({
      where: { entryType_entryId: { entryType, entryId } },
    });
  }
}
