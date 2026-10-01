import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GenerationSessionScope, MessageRole, Prisma } from '@prisma/client';
import type { StructuredResume } from '@job-tracker/shared-types';
import { LlmKillSwitchService } from '../llm-kill-switch/llm-kill-switch.service';

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

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly killSwitch: LlmKillSwitchService,
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

    this.runTurnInBackground(session, session.messageHistoryJson, userReply);
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
      signal: this.killSwitch.signal,
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
      signal: this.killSwitch.signal,
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
      signal: this.killSwitch.signal,
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
