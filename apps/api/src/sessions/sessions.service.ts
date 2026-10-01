import { forwardRef, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GenerationSessionScope, MessageRole, Prisma, StorySourceType } from '@prisma/client';
import type { StructuredResume } from '@job-tracker/shared-types';
import { StoriesService } from '../stories/stories.service';

const SOURCE_TYPE_TO_PRISMA: Record<string, StorySourceType> = {
  story_file: StorySourceType.STORY_FILE,
  resume_file: StorySourceType.RESUME_FILE,
  github_repo: StorySourceType.GITHUB_REPO,
};

const AGENT_SERVICE_URL = process.env.RESU_AGENT_URL ?? 'http://localhost:8743';

interface RunTurnResponse {
  done: boolean;
  resume: StructuredResume | null;
  question: string | null;
  message_history_json: string;
}

interface LinkedinRunTurnResponse {
  done: boolean;
  headline: string | null;
  about: string | null;
  entry_bullets: { entry_type: string; entry_id: string; bullets: string[] }[] | null;
  question: string | null;
  message_history_json: string;
}

interface StoryCandidateOut {
  entry_type: string | null;
  entry_id: string | null;
  new_entry_label: string | null;
  source_span: string;
  story_text: string;
  confidence: number;
}

interface StoriesRunTurnResponse {
  done: boolean;
  candidates: StoryCandidateOut[] | null;
  question: string | null;
  message_history_json: string;
}

/** First-turn-only context for a STORY_EXTRACTION session — not persisted on
 * the session row (it's only needed to kick off turn 1; the agent's own
 * message_history carries it forward from there), passed straight through
 * from StoriesService.createParseRunForUpload/triggerManualRerun. */
export interface StoryExtractionStartContext {
  rawText: string;
  sourceType: 'story_file' | 'resume_file' | 'github_repo';
  sourceLabel: string;
  storyFileId?: string;
  resumeFileId?: string;
  repoFullName?: string;
  entries: Record<string, unknown>;
  hintEntryType: string | null;
}

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => StoriesService))
    private readonly stories: StoriesService,
  ) {}

  /** All sessions across all scopes, newest first — what the side panel lists. */
  listAll() {
    return this.prisma.generationSession.findMany({
      orderBy: { createdAt: 'desc' },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
  }

  async get(id: string) {
    const session = await this.prisma.generationSession.findUnique({
      where: { id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) throw new NotFoundException(`Session ${id} not found`);
    return session;
  }

  /**
   * Creates a session and kicks off the first agent turn in the background
   * (doesn't block the HTTP response — the frontend polls get() for status).
   */
  async start(scope: GenerationSessionScope, applicationId?: string, company?: string) {
    if (scope === 'APPLICATION' && !applicationId) {
      throw new Error('applicationId is required for scope=APPLICATION');
    }
    if (scope === 'COMPANY' && !company) {
      throw new Error('company is required for scope=COMPANY');
    }

    const session = await this.prisma.generationSession.create({
      data: { scope, applicationId, company, status: 'RUNNING' },
    });
    this.runTurnInBackground(session, null, null);
    return session;
  }

  /**
   * Creates a STORY_EXTRACTION session for one uploaded document/repo and
   * kicks off its first turn in the background — one session per source,
   * labeled by sourceLabel (filename/repo name) in the UI. Called by
   * StoriesService, not exposed directly on SessionsController, since the
   * caller needs to also link the resulting session to a StoryParseRun.
   */
  async startStoryExtraction(storyParseRunId: string, context: StoryExtractionStartContext) {
    const session = await this.prisma.generationSession.create({
      data: {
        scope: 'STORY_EXTRACTION',
        storyParseRunId,
        sourceLabel: context.sourceLabel,
        sourceType: SOURCE_TYPE_TO_PRISMA[context.sourceType],
        storyFileId: context.storyFileId,
        resumeFileId: context.resumeFileId,
        repoFullName: context.repoFullName,
        status: 'RUNNING',
      },
    });
    this.runStoryExtractionTurn(session.id, null, null, context);
    return session;
  }

  /** User answering a question the agent asked — resumes the same conversation. */
  async reply(sessionId: string, userReply: string) {
    const session = await this.get(sessionId);
    if (session.status !== 'WAITING_FOR_INPUT') {
      throw new Error(`Session ${sessionId} is not waiting for input (status: ${session.status})`);
    }

    await this.prisma.sessionMessage.create({
      data: { sessionId, role: MessageRole.USER, content: userReply },
    });
    await this.prisma.generationSession.update({
      where: { id: sessionId },
      data: { status: 'RUNNING' },
    });

    if (session.scope === 'STORY_EXTRACTION') {
      this.runStoryExtractionTurn(sessionId, session.messageHistoryJson, userReply, null);
    } else {
      this.runTurnInBackground(session, session.messageHistoryJson, userReply);
    }
    return this.get(sessionId);
  }

  /**
   * Saves the session's finished output to the right place depending on scope,
   * and marks the session accepted.
   */
  async accept(sessionId: string) {
    const session = await this.get(sessionId);
    if (session.status !== 'DONE') {
      throw new Error(`Session ${sessionId} is not done yet (status: ${session.status})`);
    }
    const lastAssistantMessage = [...session.messages]
      .reverse()
      .find((m) => m.role === MessageRole.ASSISTANT);
    if (!lastAssistantMessage) {
      throw new Error(`Session ${sessionId} has no assistant output to accept`);
    }

    if (session.scope === 'APPLICATION') {
      const resumeContent = this.parseStructuredResume(lastAssistantMessage.content);
      await this.prisma.application.update({
        where: { id: session.applicationId! },
        data: {
          resumeContent: (resumeContent ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
          resumeGeneratedAt: new Date(),
        },
      });
    } else if (session.scope === 'COMPANY') {
      const resumeContent = (this.parseStructuredResume(lastAssistantMessage.content) ??
        {}) as Prisma.InputJsonValue;
      await this.prisma.companyResume.upsert({
        where: { company: session.company! },
        create: { company: session.company!, resumeContent },
        update: { resumeContent },
      });
    } else if (session.scope === 'STORY_EXTRACTION') {
      const candidates = this.parseStoryCandidates(lastAssistantMessage.content);
      await this.stories.persistCandidatesFromSession(session.storyParseRunId!, session.id, candidates);
    } else if (session.scope === 'LINKEDIN') {
      const parsed = this.parseLinkedinContent(lastAssistantMessage.content);
      const existing = await this.prisma.linkedinProfile.findFirst();
      if (existing) {
        await this.prisma.linkedinProfile.update({ where: { id: existing.id }, data: parsed });
      } else {
        await this.prisma.linkedinProfile.create({ data: parsed });
      }
    }

    return this.prisma.generationSession.update({
      where: { id: sessionId },
      data: { status: 'ACCEPTED' },
    });
  }

  /**
   * A finished resume turn's message is stored as JSON-encoded StructuredResume
   * (see runApplicationTurn/runCompanyTurn) so it can be parsed back out on
   * accept. A question-turn message is plain text and won't parse as JSON —
   * accept() is only ever called once status is DONE, so that case shouldn't
   * reach here, but null is returned defensively rather than throwing.
   */
  private parseStructuredResume(content: string): StructuredResume | null {
    try {
      const parsed = JSON.parse(content) as Partial<StructuredResume>;
      if (typeof parsed.contactLine === 'string' && Array.isArray(parsed.sections)) {
        return parsed as StructuredResume;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * The LinkedIn chat message is stored as JSON-encoded LinkedinTurnOutput
   * fields (see runTurnInBackground) so it can be parsed back out on accept.
   */
  private parseLinkedinContent(content: string) {
    try {
      const parsed = JSON.parse(content) as {
        headline: string | null;
        about: string | null;
        entry_bullets: unknown;
      };
      return {
        headline: parsed.headline,
        about: parsed.about,
        entryBullets: parsed.entry_bullets ?? [],
      };
    } catch {
      return { headline: null, about: null, entryBullets: [] };
    }
  }

  /**
   * A finished story-extraction turn's message is stored as JSON-encoded
   * `{candidates: [...]}` (see runStoryExtractionTurn) so it can be parsed
   * back out on accept.
   */
  private parseStoryCandidates(content: string): StoryCandidateOut[] {
    try {
      const parsed = JSON.parse(content) as { candidates?: StoryCandidateOut[] };
      return parsed.candidates ?? [];
    } catch {
      return [];
    }
  }

  private async runStoryExtractionTurn(
    sessionId: string,
    priorHistoryJson: string | null,
    userReply: string | null,
    startContext: StoryExtractionStartContext | null,
  ) {
    try {
      const response = await fetch(`${AGENT_SERVICE_URL}/stories/run-turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          raw_text: startContext?.rawText,
          source_type: startContext?.sourceType,
          source_label: startContext?.sourceLabel,
          entries: startContext?.entries,
          hint_entry_type: startContext?.hintEntryType,
          message_history_json: priorHistoryJson,
          user_reply: userReply,
        }),
      });
      if (!response.ok) throw new Error(`Agent stories run-turn failed: ${response.status}`);
      const result = (await response.json()) as StoriesRunTurnResponse;

      await this.prisma.sessionMessage.create({
        data: {
          sessionId,
          role: MessageRole.ASSISTANT,
          content: (result.done ? JSON.stringify({ candidates: result.candidates }) : result.question) ??
            '(no output)',
        },
      });
      await this.prisma.generationSession.update({
        where: { id: sessionId },
        data: {
          status: result.done ? 'DONE' : 'WAITING_FOR_INPUT',
          messageHistoryJson: result.message_history_json,
        },
      });
    } catch (err) {
      this.logger.error(`Story extraction session ${sessionId} turn failed: ${err}`);
      await this.prisma.generationSession.update({
        where: { id: sessionId },
        data: { status: 'ERROR', errorMessage: String(err) },
      });
    }
  }

  private async runTurnInBackground(
    session: { id: string; scope: GenerationSessionScope; applicationId: string | null; company: string | null },
    priorHistoryJson: string | null,
    userReply: string | null,
  ) {
    try {
      if (session.scope === 'LINKEDIN') {
        await this.runLinkedinTurn(session.id, priorHistoryJson, userReply);
      } else if (session.scope === 'COMPANY') {
        await this.runCompanyTurn(session.id, session.company!, priorHistoryJson, userReply);
      } else {
        await this.runApplicationTurn(session.id, session.applicationId!, priorHistoryJson, userReply);
      }
    } catch (err) {
      this.logger.error(`Session ${session.id} turn failed: ${err}`);
      await this.prisma.generationSession.update({
        where: { id: session.id },
        data: { status: 'ERROR', errorMessage: String(err) },
      });
    }
  }

  private async runApplicationTurn(
    sessionId: string,
    applicationId: string,
    priorHistoryJson: string | null,
    userReply: string | null,
  ) {
    const response = await fetch(`${AGENT_SERVICE_URL}/sessions/run-turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        application_id: applicationId,
        message_history_json: priorHistoryJson,
        user_reply: userReply,
      }),
    });
    if (!response.ok) throw new Error(`Agent run-turn failed: ${response.status}`);
    const result = (await response.json()) as RunTurnResponse;

    await this.prisma.sessionMessage.create({
      data: {
        sessionId,
        role: MessageRole.ASSISTANT,
        content: (result.done ? JSON.stringify(result.resume) : result.question) ?? '(no output)',
      },
    });
    await this.prisma.generationSession.update({
      where: { id: sessionId },
      data: {
        status: result.done ? 'DONE' : 'WAITING_FOR_INPUT',
        messageHistoryJson: result.message_history_json,
      },
    });
  }

  private async runCompanyTurn(
    sessionId: string,
    company: string,
    priorHistoryJson: string | null,
    userReply: string | null,
  ) {
    const response = await fetch(`${AGENT_SERVICE_URL}/sessions/run-company-turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company,
        message_history_json: priorHistoryJson,
        user_reply: userReply,
      }),
    });
    if (!response.ok) throw new Error(`Agent run-company-turn failed: ${response.status}`);
    const result = (await response.json()) as RunTurnResponse;

    await this.prisma.sessionMessage.create({
      data: {
        sessionId,
        role: MessageRole.ASSISTANT,
        content: (result.done ? JSON.stringify(result.resume) : result.question) ?? '(no output)',
      },
    });
    await this.prisma.generationSession.update({
      where: { id: sessionId },
      data: {
        status: result.done ? 'DONE' : 'WAITING_FOR_INPUT',
        messageHistoryJson: result.message_history_json,
      },
    });
  }

  private async runLinkedinTurn(
    sessionId: string,
    priorHistoryJson: string | null,
    userReply: string | null,
  ) {
    const response = await fetch(`${AGENT_SERVICE_URL}/linkedin/run-turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message_history_json: priorHistoryJson,
        user_reply: userReply,
      }),
    });
    if (!response.ok) throw new Error(`Agent linkedin run-turn failed: ${response.status}`);
    const result = (await response.json()) as LinkedinRunTurnResponse;

    // Store the structured fields as JSON so accept() can parse them back out
    // and so the chat log has something readable to render in the meantime.
    const content = result.done
      ? JSON.stringify({
          headline: result.headline,
          about: result.about,
          entry_bullets: result.entry_bullets,
        })
      : (result.question ?? '(no output)');

    await this.prisma.sessionMessage.create({
      data: { sessionId, role: MessageRole.ASSISTANT, content },
    });
    await this.prisma.generationSession.update({
      where: { id: sessionId },
      data: {
        status: result.done ? 'DONE' : 'WAITING_FOR_INPUT',
        messageHistoryJson: result.message_history_json,
      },
    });
  }
}
