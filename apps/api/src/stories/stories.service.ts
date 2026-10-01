import { Injectable } from '@nestjs/common';
import sanitizeHtml from 'sanitize-html';
import { PrismaService } from '../prisma/prisma.service';
import { ResumesService } from '../resumes/resumes.service';
import { GithubService } from '../github/github.service';
import { StoryEntryType } from '@prisma/client';

// Matches the tag vocabulary the document-generation agent is instructed to
// use (agent/resu/stories/definition.py) and Tiptap StarterKit's schema —
// kept in sync with both so a sanitize pass never strips content the editor
// or the model actually produced.
const ALLOWED_TAGS = ['h1', 'h2', 'h3', 'p', 'ul', 'ol', 'li', 'strong', 'em', 'br'];

export function sanitizeDocumentHtml(html: string): string {
  return sanitizeHtml(html, { allowedTags: ALLOWED_TAGS, allowedAttributes: {} });
}

/**
 * Per-entry detailed documents — one user-visible, user-editable HTML
 * document per entry (WorkExperience/Education/Internship/Project),
 * generated via a chat-style session (ENTRY_DOCUMENT scope, see
 * sessions.service.ts's runEntryDocumentTurn) from that entry's tagged raw
 * sources (Stories/Resume files, connected GitHub repo), editable afterward
 * in the browser (see entry-document-editor.tsx). This document is the sole
 * content source fed into resume/LinkedIn/company-resume generation —
 * replaces the old per-source, invisible ExtractedNarrative cache, which
 * triggered an LLM call implicitly on every generation; here the LLM call
 * only ever happens inside an explicit Generate session, and the result is
 * only persisted once the user Accepts it.
 */
@Injectable()
export class StoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resumes: ResumesService,
    private readonly github: GithubService,
  ) {}

  async getDocumentForEntry(entryType: StoryEntryType, entryId: string): Promise<{ contentHtml: string } | null> {
    const doc = await this.prisma.entryDocument.findUnique({
      where: { entryType_entryId: { entryType, entryId } },
    });
    return doc ? { contentHtml: doc.contentHtml } : null;
  }

  async saveDocumentForEntry(
    entryType: StoryEntryType,
    entryId: string,
    contentHtml: string,
  ): Promise<{ contentHtml: string }> {
    const sanitized = sanitizeDocumentHtml(contentHtml);
    const doc = await this.prisma.entryDocument.upsert({
      where: { entryType_entryId: { entryType, entryId } },
      create: { entryType, entryId, contentHtml: sanitized },
      update: { contentHtml: sanitized },
    });
    return { contentHtml: doc.contentHtml };
  }

  /** Every raw source tagged to one entry — a Stories file, a Resume file,
   * and/or a connected GitHub repo — paired with a short label (filename or
   * repo name) for progress reporting, not combined, not LLM-processed; the
   * document-generation agent does its own reading/combining. Called by
   * SessionsService.runEntryDocumentTurn at the start of a Generate session. */
  async getRawSourcesForEntry(
    entryType: StoryEntryType,
    entryId: string,
  ): Promise<{ label: string; text: string }[]> {
    const [storyFiles, resumeFiles, repos] = await Promise.all([
      this.resumes.listStoryFilesForEntry(entryType, entryId),
      this.resumes.listResumeFilesForEntry(entryType, entryId),
      this.github.listConnectedReposForEntry(entryType, entryId).catch(() => []),
    ]);

    const sources = await Promise.all([
      ...storyFiles.map(async (f) => ({ label: f.filename, text: await this.resumes.getStoryFileText(f.id) })),
      ...resumeFiles.map(async (f) => ({ label: f.filename, text: await this.resumes.getResumeFileText(f.id) })),
      ...repos.map(async (r) => ({ label: r.fullName, text: await this.getRepoRawText(r.fullName) })),
    ]);

    return sources.filter((s) => s.text.trim().length > 0);
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
}
