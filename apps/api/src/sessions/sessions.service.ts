import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';
import { PrismaService } from '../prisma/prisma.service';
import { GenerationSessionScope, MessageRole, Prisma, StoryEntryType } from '@prisma/client';
import type { StructuredResume } from '@job-tracker/shared-types';
import { LlmKillSwitchService } from '../llm-kill-switch/llm-kill-switch.service';
import { StoriesService, sanitizeDocumentHtml } from '../stories/stories.service';

const AGENT_SERVICE_URL = process.env.RESU_AGENT_URL ?? 'http://localhost:8743';

// Node's fetch (built on undici) enforces its OWN internal headersTimeout
// (~300s default) independently of any AbortSignal passed to the call —
// an AbortSignal.timeout() longer than this does NOT raise it, so a call
// that's still legitimately working (retrying through Azure rate limits,
// chunked generation, etc.) past 300s is killed anyway by undici itself,
// surfacing as "TypeError: fetch failed (cause: HeadersTimeoutError)".
// Raising headersTimeout/bodyTimeout on a dedicated dispatcher (below),
// passed explicitly to every agent-service fetch, is what actually extends
// that ceiling — AbortSignal remains the mechanism for the real,
// intentional cutoff (agentCallSignal), comfortably inside the dispatcher's
// much larger window instead of racing against it.
//
// A single flat AbortSignal timeout doesn't scale with how much work a
// call actually has to do, though — a 35-chunk source (a real production
// file: 416K characters) needs roughly 35x a single chunk's time,
// sequentially, since sources are processed one chunk at a time by design
// (see agent/resu/stories/agent.py). So for ENTRY_DOCUMENT calls
// specifically, the AbortSignal's timeout is computed per-call from the
// actual source text (see estimateEntryDocumentTimeoutMs) instead of this
// fixed number; this constant is the FLOOR for that calculation, and also
// what every OTHER scope's call still uses directly (they have no
// chunk-count to scale from).
const AGENT_FETCH_TIMEOUT_FLOOR_MS = 8 * 60 * 1000;
// Generous enough to cover any single call's scaled timeout in practice —
// the dispatcher's headersTimeout/bodyTimeout just need to not be the
// binding constraint; the per-call AbortSignal is what actually cuts a call
// off at its own scaled duration.
const AGENT_DISPATCHER_TIMEOUT_MS = 60 * 60 * 1000;
const agentDispatcher = new UndiciAgent({
  headersTimeout: AGENT_DISPATCHER_TIMEOUT_MS,
  bodyTimeout: AGENT_DISPATCHER_TIMEOUT_MS,
});

// Mirrors agent/resu/stories/agent.py's _CHUNK_SIZE_CHARS — kept in sync so
// this estimate reflects the same chunking the Python side actually does.
const DOCUMENT_CHUNK_SIZE_CHARS = 12000;
// Per the user's own worst-case math: ~30s per chunk, +10% buffer.
const SECONDS_PER_CHUNK = 30 * 1.1;

/**
 * Estimates a generous but scaled timeout for one ENTRY_DOCUMENT run-turn
 * call, based on how many sequential chunks its sources actually need —
 * sources are processed one chunk at a time (see SOURCE_MAX_CONCURRENCY in
 * agent/resu/stories/agent.py), so total chunks across all sources is a
 * reasonable proxy for how long the whole call can legitimately take.
 * Floors at AGENT_FETCH_TIMEOUT_FLOOR_MS so a small entry still gets a
 * comfortable cushion (clarify-check call, retries, network latency) rather
 * than a timeout scaled down to near-zero for a one-paragraph source.
 */
function estimateEntryDocumentTimeoutMs(rawSources: { text: string }[]): number {
  const totalChunks = rawSources.reduce(
    (sum, s) => sum + Math.max(1, Math.ceil(s.text.length / DOCUMENT_CHUNK_SIZE_CHARS)),
    0,
  );
  const scaledMs = totalChunks * SECONDS_PER_CHUNK * 1000;
  return Math.max(AGENT_FETCH_TIMEOUT_FLOOR_MS, scaledMs);
}

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

interface EntryDocumentRunTurnResponse {
  done: boolean;
  content_html: string | null;
  question: string | null;
}

/** ENTRY_DOCUMENT sessions have no real PydanticAI message history (the
 * agent side is a plain two-call orchestration, not a conversational
 * agent run — see agent/resu/stories/agent.py's run_entry_document_turn) —
 * this small JSON blob is round-tripped through messageHistoryJson instead,
 * same storage slot, different (session-local) meaning. */
interface EntryDocumentSessionState {
  entryType: StoryEntryType;
  entryId: string;
  entryLabel: string;
  existingDocumentHtml: string;
  rawSources: { label: string; text: string }[];
  alreadyAsked: boolean;
}

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  // Per-session abort controllers — lets a single session be cancelled (via
  // stop(sessionId)) without aborting every OTHER in-flight call the way
  // the global LlmKillSwitchService does. Entries are removed once a
  // session's turn finishes (success, error, or stop) so this map never
  // grows unbounded; a session not present here simply has no in-flight
  // call to cancel (already finished, or hasn't started its fetch yet).
  private readonly sessionControllers = new Map<string, AbortController>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly killSwitch: LlmKillSwitchService,
    private readonly stories: StoriesService,
  ) {}

  /** Combines the manual global kill-switch signal, a per-session abort
   * (so stop(sessionId) only cancels THIS session's call), and a per-call
   * timeout — without the timeout, a hung/slow agent call relies entirely
   * on undici's internal default which gives no clear signal that it was a
   * timeout. `timeoutMs` defaults to the flat floor (APPLICATION/COMPANY/
   * LINKEDIN calls, which don't have a chunk-count to scale from) but
   * ENTRY_DOCUMENT calls pass a scaled value (see
   * estimateEntryDocumentTimeoutMs). */
  private agentCallSignal(sessionId: string, timeoutMs: number = AGENT_FETCH_TIMEOUT_FLOOR_MS): AbortSignal {
    const controller = new AbortController();
    this.sessionControllers.set(sessionId, controller);
    return AbortSignal.any([this.killSwitch.signal, controller.signal, AbortSignal.timeout(timeoutMs)]);
  }

  /** Cancels whatever this session's current turn is doing — the in-flight
   * fetch to the agent service aborts, runTurnInBackground's catch block
   * marks the session ERROR, same as any other failure. No-op (not an
   * error) if the session has no in-flight call right now (already
   * finished, or between turns) — the user clicking Stop on a session
   * that's already done shouldn't be treated as a problem. */
  async stop(sessionId: string) {
    const session = await this.get(sessionId);
    const controller = this.sessionControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.sessionControllers.delete(sessionId);
    }
    if (session.status === 'RUNNING') {
      await this.prisma.generationSession.update({
        where: { id: sessionId },
        data: { status: 'ERROR', errorMessage: 'Stopped by user' },
      });
    }
    return this.get(sessionId);
  }

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
  async start(
    scope: GenerationSessionScope,
    applicationId?: string,
    company?: string,
    entryType?: StoryEntryType,
    entryId?: string,
    entryLabel?: string,
  ) {
    if (scope === 'APPLICATION' && !applicationId) {
      throw new Error('applicationId is required for scope=APPLICATION');
    }
    if (scope === 'COMPANY' && !company) {
      throw new Error('company is required for scope=COMPANY');
    }
    if (scope === 'ENTRY_DOCUMENT' && (!entryType || !entryId)) {
      throw new Error('entryType and entryId are required for scope=ENTRY_DOCUMENT');
    }

    const session = await this.prisma.generationSession.create({
      data: { scope, applicationId, company, entryType, entryId, status: 'RUNNING' },
    });
    this.runTurnInBackground(session, null, null, entryLabel);
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
   * Appends a one-line, in-progress status update to the session's chat —
   * called by the Python agent mid-run (see agent/resu/stories/agent.py)
   * so the chat shows live "evaluating file X... done" / "merging..." lines
   * while a long generation is still in flight, not just the final result.
   * Stored as a TOOL-role message so the chat panel can render it as a
   * compact status line rather than a full chat bubble.
   */
  async progress(sessionId: string, message: string) {
    await this.prisma.sessionMessage.create({
      data: { sessionId, role: MessageRole.TOOL, content: message },
    });
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
    } else if (session.scope === 'ENTRY_DOCUMENT') {
      // lastAssistantMessage.content is the sanitized document HTML itself
      // (not JSON-wrapped, unlike the other scopes) — see runEntryDocumentTurn.
      await this.stories.saveDocumentForEntry(session.entryType!, session.entryId!, lastAssistantMessage.content);
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
    session: {
      id: string;
      scope: GenerationSessionScope;
      applicationId: string | null;
      company: string | null;
      entryType: StoryEntryType | null;
      entryId: string | null;
    },
    priorHistoryJson: string | null,
    userReply: string | null,
    entryLabel?: string,
  ) {
    try {
      if (session.scope === 'LINKEDIN') {
        await this.runLinkedinTurn(session.id, priorHistoryJson, userReply);
      } else if (session.scope === 'COMPANY') {
        await this.runCompanyTurn(session.id, session.company!, priorHistoryJson, userReply);
      } else if (session.scope === 'ENTRY_DOCUMENT') {
        await this.runEntryDocumentTurn(
          session.id,
          session.entryType!,
          session.entryId!,
          priorHistoryJson,
          userReply,
          entryLabel,
        );
      } else {
        await this.runApplicationTurn(session.id, session.applicationId!, priorHistoryJson, userReply);
      }
    } catch (err) {
      // Node's fetch wraps the real underlying failure (a timeout, a
      // connection reset, etc.) in `.cause` and raises a generic
      // "TypeError: fetch failed" at the top level — logging err alone
      // (or String(err)) discards that cause and makes every fetch
      // failure look identical and undiagnosable. Surface it explicitly.
      const cause = err instanceof Error && err.cause ? ` (cause: ${err.cause})` : '';
      this.logger.error(`Session ${session.id} turn failed: ${err}${cause}`);
      // A stop(sessionId) call already marks the session ERROR itself —
      // don't overwrite its "Stopped by user" message with the generic
      // abort error this catch block would otherwise write (the fetch
      // rejects with an AbortError once its signal fires, landing here).
      const current = await this.prisma.generationSession.findUnique({ where: { id: session.id } });
      if (current?.status !== 'ERROR') {
        await this.prisma.generationSession.update({
          where: { id: session.id },
          data: { status: 'ERROR', errorMessage: `${err}${cause}` },
        });
      }
    } finally {
      this.sessionControllers.delete(session.id);
    }
  }

  private async runApplicationTurn(
    sessionId: string,
    applicationId: string,
    priorHistoryJson: string | null,
    userReply: string | null,
  ) {
    const response = await undiciFetch(`${AGENT_SERVICE_URL}/sessions/run-turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        application_id: applicationId,
        message_history_json: priorHistoryJson,
        user_reply: userReply,
      }),
      signal: this.agentCallSignal(sessionId),
      dispatcher: agentDispatcher,
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
    const response = await undiciFetch(`${AGENT_SERVICE_URL}/sessions/run-company-turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company,
        message_history_json: priorHistoryJson,
        user_reply: userReply,
      }),
      signal: this.agentCallSignal(sessionId),
      dispatcher: agentDispatcher,
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

  /**
   * ENTRY_DOCUMENT scope: generates/revises one entry's detailed document.
   * First turn (priorHistoryJson is null) gathers the entry's current
   * document + raw tagged sources once and stashes them in
   * messageHistoryJson (see EntryDocumentSessionState) — later turns (a
   * reply answering a clarifying question) reuse that stashed state rather
   * than re-gathering, since the raw sources don't change mid-session.
   */
  private async runEntryDocumentTurn(
    sessionId: string,
    entryType: StoryEntryType,
    entryId: string,
    priorHistoryJson: string | null,
    userReply: string | null,
    entryLabel?: string,
  ) {
    let state: EntryDocumentSessionState;
    if (priorHistoryJson) {
      state = JSON.parse(priorHistoryJson) as EntryDocumentSessionState;
    } else {
      const existing = await this.stories.getDocumentForEntry(entryType, entryId);
      const rawSources = await this.stories.getRawSourcesForEntry(entryType, entryId);
      state = {
        entryType,
        entryId,
        entryLabel: entryLabel ?? entryId,
        existingDocumentHtml: existing?.contentHtml ?? '',
        rawSources,
        alreadyAsked: false,
      };
    }

    const timeoutMs = estimateEntryDocumentTimeoutMs(state.rawSources);
    this.logger.log(
      `Session ${sessionId}: estimated run-turn timeout ${Math.round(timeoutMs / 1000)}s ` +
        `for ${state.rawSources.length} source(s)`,
    );

    const response = await undiciFetch(`${AGENT_SERVICE_URL}/stories/run-turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        existing_document_html: state.existingDocumentHtml,
        raw_sources: state.rawSources,
        entry_label: state.entryLabel,
        user_reply: userReply,
        already_asked: state.alreadyAsked,
      }),
      signal: this.agentCallSignal(sessionId, timeoutMs),
      dispatcher: agentDispatcher,
    });
    if (!response.ok) throw new Error(`Agent /stories/run-turn failed: ${response.status}`);
    const result = (await response.json()) as EntryDocumentRunTurnResponse;

    await this.prisma.sessionMessage.create({
      data: {
        sessionId,
        role: MessageRole.ASSISTANT,
        content: (result.done ? sanitizeDocumentHtml(result.content_html ?? '') : result.question) ?? '(no output)',
      },
    });

    const nextState: EntryDocumentSessionState = { ...state, alreadyAsked: !result.done || state.alreadyAsked };
    await this.prisma.generationSession.update({
      where: { id: sessionId },
      data: {
        status: result.done ? 'DONE' : 'WAITING_FOR_INPUT',
        messageHistoryJson: JSON.stringify(nextState),
      },
    });
  }

  private async runLinkedinTurn(
    sessionId: string,
    priorHistoryJson: string | null,
    userReply: string | null,
  ) {
    const response = await undiciFetch(`${AGENT_SERVICE_URL}/linkedin/run-turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message_history_json: priorHistoryJson,
        user_reply: userReply,
      }),
      signal: this.agentCallSignal(sessionId),
      dispatcher: agentDispatcher,
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
