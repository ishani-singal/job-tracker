import { Injectable } from '@nestjs/common';
import sanitizeHtml from 'sanitize-html';
import { PrismaService } from '../prisma/prisma.service';
import { ResumesService } from '../resumes/resumes.service';
import { GithubService } from '../github/github.service';
import { StoryEntryType } from '@prisma/client';

const AGENT_SERVICE_URL = process.env.RESU_AGENT_URL ?? 'http://localhost:8743';

interface GenerateDocumentResponse {
  content_html: string;
}

// Matches the tag vocabulary the document-generation agent is instructed to
// use (agent/resu/stories/definition.py) and Tiptap StarterKit's schema —
// kept in sync with both so a sanitize pass never strips content the editor
// or the model actually produced.
const ALLOWED_TAGS = ['h1', 'h2', 'h3', 'p', 'ul', 'ol', 'li', 'strong', 'em', 'br'];

function sanitizeDocumentHtml(html: string): string {
  return sanitizeHtml(html, { allowedTags: ALLOWED_TAGS, allowedAttributes: {} });
}

/**
 * Per-entry detailed documents — one user-visible, user-editable HTML
 * document per entry (WorkExperience/Education/Internship/Project/Paper),
 * generated on explicit user request from that entry's tagged raw sources
 * (Stories/Resume files, connected GitHub repo) and editable afterward in
 * the browser (see entry-document-editor.tsx). This document is the sole
 * content source fed into resume/LinkedIn/company-resume generation —
 * replaces the old per-source, invisible ExtractedNarrative cache, which
 * triggered an LLM call implicitly on every generation; here the LLM call
 * only happens when the user clicks Generate.
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

  /**
   * Generates (or revises) the entry's document: feeds the agent the
   * current document content (empty string if none yet) plus every raw
   * source tagged to the entry, and persists whatever comes back. A
   * revision, not a blind overwrite — the agent is instructed to preserve
   * existing content/edits except where new source material supersedes it.
   */
  async generateDocumentForEntry(
    entryType: StoryEntryType,
    entryId: string,
    entryLabel: string,
  ): Promise<{ contentHtml: string }> {
    const existing = await this.getDocumentForEntry(entryType, entryId);
    const rawSources = await this.getRawSourcesForEntry(entryType, entryId);

    const response = await fetch(`${AGENT_SERVICE_URL}/stories/generate-document`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        existing_document_html: existing?.contentHtml ?? '',
        raw_sources: rawSources,
        entry_label: entryLabel,
      }),
    });
    if (!response.ok) {
      throw new Error(`Agent /stories/generate-document failed: ${response.status}`);
    }
    const result = (await response.json()) as GenerateDocumentResponse;

    return this.saveDocumentForEntry(entryType, entryId, result.content_html);
  }

  /** Every raw source's text tagged to one entry — a Stories file, a Resume
   * file, and/or a connected GitHub repo — not combined, not LLM-processed;
   * the document-generation agent does its own reading/combining. */
  private async getRawSourcesForEntry(entryType: StoryEntryType, entryId: string): Promise<string[]> {
    const [storyFiles, resumeFiles, repos] = await Promise.all([
      this.resumes.listStoryFilesForEntry(entryType, entryId),
      this.resumes.listResumeFilesForEntry(entryType, entryId),
      this.github.listConnectedReposForEntry(entryType, entryId).catch(() => []),
    ]);

    const texts = await Promise.all([
      ...storyFiles.map((f) => this.resumes.getStoryFileText(f.id)),
      ...resumeFiles.map((f) => this.resumes.getResumeFileText(f.id)),
      ...repos.map((r) => this.getRepoRawText(r.fullName)),
    ]);

    return texts.filter((t) => t.trim().length > 0);
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
