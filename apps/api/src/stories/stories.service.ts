import { BadRequestException, forwardRef, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ResumesService } from '../resumes/resumes.service';
import { EntriesService } from '../entries/entries.service';
import { GithubService } from '../github/github.service';
import { SessionsService } from '../sessions/sessions.service';
import { StoryEntryType, StorySourceType, StoryStatus } from '@prisma/client';

interface ExtractCandidate {
  entry_type: string | null;
  entry_id: string | null;
  new_entry_label: string | null;
  source_span: string;
  story_text: string;
  confidence: number;
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
  /** The background category the user picked at upload time — a strong hint
   * for the extraction agent. Only meaningful for a single-file trigger. */
  hintEntryType?: StoryEntryType;
  /** The specific entry (e.g. one particular Work Experience row) the user
   * picked, one level more specific than hintEntryType — when set, the
   * document is pinned to exactly this entry, not just its category. */
  hintEntryId?: string;
}

const HINT_ENTRY_TYPE_TO_MATCH_KEY: Record<StoryEntryType, string> = {
  WORK_EXPERIENCE: 'workExperience',
  EDUCATION: 'education',
  INTERNSHIP: 'internship',
  PROJECT: 'project',
  PAPER: 'paper',
};

const HINT_ENTRY_TYPE_LABEL: Record<StoryEntryType, string> = {
  WORK_EXPERIENCE: 'Work Experience',
  EDUCATION: 'Education',
  INTERNSHIP: 'Internship',
  PROJECT: 'Project',
  PAPER: 'Paper',
};

@Injectable()
export class StoriesService {
  private readonly logger = new Logger(StoriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resumes: ResumesService,
    private readonly entries: EntriesService,
    private readonly github: GithubService,
    @Inject(forwardRef(() => SessionsService))
    private readonly sessions: SessionsService,
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

  /** Triggered by a Stories/Resume upload — starts a chat for only the new file. */
  async createParseRunForUpload(trigger: RerunTrigger) {
    const run = await this.prisma.storyParseRun.create({
      data: {
        status: 'PENDING',
        triggerSourceType: trigger.sourceType,
        triggerStoryFileId: trigger.storyFileId,
        triggerResumeFileId: trigger.resumeFileId,
        triggerRepoFullName: trigger.repoFullName,
        hintEntryType: trigger.hintEntryType,
        hintEntryId: trigger.hintEntryId,
      },
    });
    this.startSessionsInBackground(run.id, trigger);
    return run;
  }

  /** Manual rerun — starts a chat for every currently uploaded file + connected repo. */
  async triggerManualRerun() {
    const run = await this.prisma.storyParseRun.create({ data: { status: 'PENDING' } });
    this.startSessionsInBackground(run.id, {});
    return run;
  }

  /**
   * Starts one STORY_EXTRACTION chat session per source (document or repo) —
   * each session is the per-document chat the user sees in the Sessions
   * panel, labeled by that source's filename/repo name. Candidates only land
   * in the review queue once each session's chat is accepted (see
   * persistCandidatesFromSession, called from SessionsService.accept).
   */
  private async startSessionsInBackground(runId: string, trigger: RerunTrigger) {
    try {
      await this.prisma.storyParseRun.update({ where: { id: runId }, data: { status: 'PARSING' } });

      const sources = await this.gatherSources(trigger);
      const entries = await this.entries.getAll();
      const papers = await this.prisma.paperEntry.findMany({ orderBy: { sortOrder: 'asc' } });
      const entriesForMatching = { ...entries, papers };

      // A user-picked background hint narrows which category of entries the
      // extraction agent even considers for this document, rather than just
      // being advisory — this is the "ask the user to pick a background"
      // step: it removes the chance of a document tagged "Education" ever
      // getting matched against a Work Experience entry. Picking a specific
      // entry (e.g. "Dell" under Work Experience) narrows it one level
      // further, to that one entry only — the document is pinned to it.
      const narrowedEntries = trigger.hintEntryType
        ? this.narrowEntriesToHint(entriesForMatching, trigger.hintEntryType, trigger.hintEntryId)
        : entriesForMatching;

      const backgroundSuffix = this.describeBackgroundHint(
        narrowedEntries,
        trigger.hintEntryType,
        trigger.hintEntryId,
      );

      const sourcesWithText = sources.filter((s) => s.text.trim());
      for (const source of sourcesWithText) {
        await this.sessions.startStoryExtraction(runId, {
          rawText: source.text,
          sourceType: source.sourceType,
          sourceLabel: backgroundSuffix ? `${source.label} (${backgroundSuffix})` : source.label,
          storyFileId: source.storyFileId,
          resumeFileId: source.resumeFileId,
          repoFullName: source.repoFullName,
          entries: narrowedEntries,
          hintEntryType: trigger.hintEntryType
            ? HINT_ENTRY_TYPE_TO_MATCH_KEY[trigger.hintEntryType]
            : null,
          hintEntryId: trigger.hintEntryId ?? null,
        });
      }

      await this.prisma.storyParseRun.update({
        where: { id: runId },
        data: { status: sourcesWithText.length > 0 ? 'AWAITING_REVIEW' : 'DONE' },
      });
    } catch (err) {
      this.logger.error(`Parse run ${runId} failed: ${err}`);
      await this.prisma.storyParseRun.update({
        where: { id: runId },
        data: { status: 'ERROR', errorMessage: String(err) },
      });
    }
  }

  /** Restricts the entries dict to only the hinted category — e.g. a
   * document tagged "Education" is matched only against EducationEntry rows,
   * so the model can never attribute it to a Work Experience/Project/etc.
   * entry even if it mentions one in passing. When a specific entryId is
   * also given (e.g. "Dell" under Work Experience), narrows further to just
   * that one entry — the document is pinned to it, not merely its category. */
  private narrowEntriesToHint(
    entries: Record<string, unknown[]>,
    hint: StoryEntryType,
    entryId?: string,
  ): Record<string, unknown[]> {
    const key = HINT_ENTRY_TYPE_TO_MATCH_KEY[hint];
    const narrowed: Record<string, unknown[]> = {
      workExperience: [],
      education: [],
      internships: [],
      projects: [],
      papers: [],
    };
    const sourceKey = key === 'internship' ? 'internships' : key === 'project' ? 'projects' : key;
    const categoryEntries = (entries[sourceKey] ?? []) as { id: string }[];
    narrowed[sourceKey] = entryId
      ? categoryEntries.filter((e) => e.id === entryId)
      : categoryEntries;
    return narrowed;
  }

  /** Builds a human-readable "(Work Experience: Dell)" / "(Work
   * Experience)" suffix from the user's upload-time background pick, so the
   * Chat panel's session list shows what was picked, not just the filename.
   * Reads the display name straight out of the already-narrowed entries
   * dict rather than hitting the DB again. */
  private describeBackgroundHint(
    narrowedEntries: Record<string, unknown[]>,
    hintEntryType?: StoryEntryType,
    hintEntryId?: string,
  ): string | null {
    if (!hintEntryType) return null;
    const categoryLabel = HINT_ENTRY_TYPE_LABEL[hintEntryType];
    if (!hintEntryId) return categoryLabel;

    const key = HINT_ENTRY_TYPE_TO_MATCH_KEY[hintEntryType];
    const sourceKey = key === 'internship' ? 'internships' : key === 'project' ? 'projects' : key;
    const entry = (narrowedEntries[sourceKey] ?? [])[0] as Record<string, unknown> | undefined;
    if (!entry) return categoryLabel;

    const entryName =
      (entry.company as string | undefined) ??
      (entry.school as string | undefined) ??
      (entry.name as string | undefined) ??
      (entry.title as string | undefined);
    return entryName ? `${categoryLabel}: ${entryName}` : categoryLabel;
  }

  /**
   * Called by SessionsService.accept() once a per-document chat is accepted
   * — applies the same diff/rerun reconciliation algorithm the old one-shot
   * flow used, now keyed by the finished session's candidates instead of an
   * inline extract-call response. Provenance (sourceType/storyFileId/etc.)
   * is read from the session itself, not the shared StoryParseRun — a run
   * can cover many sources (a manual rerun), but each session is always
   * exactly one source, set when that session was started (see
   * startSessionsInBackground).
   */
  async persistCandidatesFromSession(
    parseRunId: string,
    sessionId: string,
    candidates: ExtractCandidate[],
  ) {
    const run = await this.prisma.storyParseRun.findUnique({ where: { id: parseRunId } });
    const session = await this.prisma.generationSession.findUniqueOrThrow({ where: { id: sessionId } });
    const source = {
      sourceType: session.sourceType ?? StorySourceType.STORY_FILE,
      storyFileId: session.storyFileId ?? undefined,
      resumeFileId: session.resumeFileId ?? undefined,
      repoFullName: session.repoFullName ?? undefined,
    };
    await this.reconcileCandidates(
      parseRunId,
      source,
      candidates,
      run?.hintEntryType ?? undefined,
      run?.hintEntryId ?? undefined,
    );
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
    source: {
      sourceType: StorySourceType;
      storyFileId?: string;
      resumeFileId?: string;
      repoFullName?: string;
    },
    candidates: ExtractCandidate[],
    hintEntryType?: StoryEntryType,
    hintEntryId?: string,
  ): Promise<number> {
    let created = 0;
    for (const c of candidates) {
      // When the document was pre-tagged with a background hint, every
      // candidate it produces belongs to that category by construction (the
      // entries dict was narrowed to only that category) — fall back to the
      // hint if the agent didn't echo entry_type for a new-entry proposal.
      // Likewise, if the document was pinned to one specific entry, fall
      // back to that exact entry id when the agent omits entry_id — the
      // entries dict only ever contained that one entry, so there's nothing
      // else it could have matched.
      const entryType = c.entry_type ? ENTRY_TYPE_TO_PRISMA[c.entry_type] : (hintEntryType ?? null);
      const entryId = c.entry_id ?? (hintEntryId && entryType === hintEntryType ? hintEntryId : null);

      if (entryType && entryId) {
        const existing = await this.prisma.candidateStory.findUnique({
          where: { entryType_entryId: { entryType, entryId } },
        });
        if (existing && existing.status === 'CONFIRMED' && existing.storyText.trim() === c.story_text.trim()) {
          continue; // no-op: nothing changed, don't pester the user
        }
        await this.prisma.storyCandidate.create({
          data: {
            parseRunId: runId,
            sourceType: source.sourceType,
            storyFileId: source.storyFileId,
            resumeFileId: source.resumeFileId,
            repoFullName: source.repoFullName,
            entryType,
            entryId,
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
          sourceType: source.sourceType,
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
