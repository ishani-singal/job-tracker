import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MessageRole } from '@prisma/client';

const AGENT_SERVICE_URL = process.env.RESU_AGENT_URL ?? 'http://localhost:8743';

interface RunTurnResponse {
  done: boolean;
  resume: string | null;
  question: string | null;
  message_history_json: string;
}

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Sessions grouped by application, newest first — what the side panel lists. */
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
  async start(applicationId: string) {
    const session = await this.prisma.generationSession.create({
      data: { applicationId, status: 'RUNNING' },
    });
    this.runTurnInBackground(session.id, applicationId, null, null);
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

    this.runTurnInBackground(
      sessionId,
      session.applicationId,
      session.messageHistoryJson,
      userReply,
    );
    return this.get(sessionId);
  }

  /** Saves the session's finished resume onto the application and marks it accepted. */
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

    await this.prisma.application.update({
      where: { id: session.applicationId },
      data: {
        resumeContent: lastAssistantMessage.content,
        resumeGeneratedAt: new Date(),
      },
    });
    return this.prisma.generationSession.update({
      where: { id: sessionId },
      data: { status: 'ACCEPTED' },
    });
  }

  private async runTurnInBackground(
    sessionId: string,
    applicationId: string,
    priorHistoryJson: string | null,
    userReply: string | null,
  ) {
    try {
      const response = await fetch(`${AGENT_SERVICE_URL}/sessions/run-turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          application_id: applicationId,
          message_history_json: priorHistoryJson,
          user_reply: userReply,
        }),
      });
      if (!response.ok) {
        throw new Error(`Agent run-turn failed: ${response.status}`);
      }
      const result = (await response.json()) as RunTurnResponse;

      const content = result.done ? result.resume : result.question;
      await this.prisma.sessionMessage.create({
        data: {
          sessionId,
          role: MessageRole.ASSISTANT,
          content: content ?? '(no output)',
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
      this.logger.error(`Session ${sessionId} turn failed: ${err}`);
      await this.prisma.generationSession.update({
        where: { id: sessionId },
        data: { status: 'ERROR', errorMessage: String(err) },
      });
    }
  }
}
