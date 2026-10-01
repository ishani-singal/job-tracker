import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ResumesService } from '../resumes/resumes.service';
import { GithubService } from '../github/github.service';
import { StoryEntryType } from '@prisma/client';

const AGENT_SERVICE_URL = process.env.RESU_AGENT_URL ?? 'http://localhost:8743';

interface ExtractNarrativeResponse {
  narrative_text: string;
}

/**
 * Live, per-generation narrative extraction. Every uploaded Stories/Resume
 * file and every connected GitHub repo is pinned to exactly one entry at
 * upload/connect time (see resumes.controller.ts / github.controller.ts) —
 * no separate confirmation chat. The first time a resume generation needs a
 * given entry's narrative from a given source, this calls the agent's
 * chunked write-up pipeline live and caches the result (ExtractedNarrative);
 * later generations reuse the cache until that source changes.
 */
@Injectable()
export class StoriesService {
  private readonly logger = new Logger(StoriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resumes: ResumesService,
    private readonly github: GithubService,
  ) {}

  /**
   * Returns every narrative associated with one entry — one string per
   * source tagged to it (a Stories file, a Resume file, and/or a connected
   * repo), not combined into one. The caller (agent/resu) concatenates them
   * itself when inlining into the generation prompt.
   */
  async getNarrativesForEntry(entryType: StoryEntryType, entryId: string, entryLabel: string): Promise<string[]> {
    const [storyFiles, resumeFiles, repos] = await Promise.all([
      this.resumes.listStoryFilesForEntry(entryType, entryId),
      this.resumes.listResumeFilesForEntry(entryType, entryId),
      this.github.listConnectedReposForEntry(entryType, entryId).catch(() => []),
    ]);

    const narratives = await Promise.all([
      ...storyFiles.map((f) =>
        this.getOrExtractNarrative(
          { storyFileId: f.id },
          entryType,
          entryId,
          () => this.resumes.getStoryFileText(f.id),
          entryLabel,
        ),
      ),
      ...resumeFiles.map((f) =>
        this.getOrExtractNarrative(
          { resumeFileId: f.id },
          entryType,
          entryId,
          () => this.resumes.getResumeFileText(f.id),
          entryLabel,
        ),
      ),
      ...repos.map((r) =>
        this.getOrExtractNarrative(
          { repoFullName: r.fullName },
          entryType,
          entryId,
          () => this.getRepoRawText(r.fullName),
          entryLabel,
        ),
      ),
    ]);

    return narratives.filter((n): n is string => !!n && n.trim().length > 0);
  }

  private async getRepoRawText(fullName: string): Promise<string> {
    const detail = await this.github.fetchRepoDetail(fullName);
    if (!detail) return '';
    return [
      `Repository: ${detail.repo}`,
      detail.description ? `Description: ${detail.description}` : '',
      detail.topics.length ? `Topics: ${detail.topics.join(', ')}` : '',
      detail.languages.length ? `Languages: ${detail.languages.join(', ')}` : '',
      detail.rootFiles.length ? `Root files: ${detail.rootFiles.join(', ')}` : '',
      detail.readme ? `README:\n${detail.readme}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * Checks ExtractedNarrative for this exact source first; only calls the
   * agent (and writes the cache) on a miss. A source reference is exactly
   * one of storyFileId/resumeFileId/repoFullName, matching ExtractedNarrative's
   * three nullable-but-individually-unique columns.
   */
  private async getOrExtractNarrative(
    source: { storyFileId?: string; resumeFileId?: string; repoFullName?: string },
    entryType: StoryEntryType,
    entryId: string,
    getRawText: () => Promise<string>,
    entryLabel: string,
  ): Promise<string | null> {
    const cached = await this.prisma.extractedNarrative.findFirst({ where: source });
    if (cached) return cached.narrativeText;

    const rawText = await getRawText();
    if (!rawText.trim()) return null;

    const narrativeText = await this.callExtractNarrative(rawText, entryLabel);

    const sourceType = source.storyFileId
      ? 'STORY_FILE'
      : source.resumeFileId
        ? 'RESUME_FILE'
        : 'GITHUB_REPO';

    await this.prisma.extractedNarrative.create({
      data: { sourceType, entryType, entryId, narrativeText, ...source },
    });

    return narrativeText;
  }

  private async callExtractNarrative(rawText: string, entryLabel: string): Promise<string> {
    const response = await fetch(`${AGENT_SERVICE_URL}/stories/extract-narrative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw_text: rawText, entry_label: entryLabel }),
    });
    if (!response.ok) {
      throw new Error(`Agent /stories/extract-narrative failed: ${response.status}`);
    }
    const result = (await response.json()) as ExtractNarrativeResponse;
    return result.narrative_text;
  }

  /** Called whenever a file/repo is deleted/disconnected — its cached
   * narrative is now for content that no longer exists. */
  async invalidateNarrativeForSource(source: {
    storyFileId?: string;
    resumeFileId?: string;
    repoFullName?: string;
  }) {
    await this.prisma.extractedNarrative.deleteMany({ where: source }).catch((err) => {
      this.logger.warn(`Failed to invalidate narrative cache for ${JSON.stringify(source)}: ${err}`);
    });
  }
}
