'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useSessionsPanel } from '@/lib/sessions-panel-context';
import { ScoreChips } from '@/components/company-contacts';
import type { Application, GenerationSession, ReferralRoleScore } from '@job-tracker/shared-types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

function statusDotClass(status: GenerationSession['status']): string {
  switch (status) {
    case 'RUNNING':
    case 'WAITING_FOR_INPUT':
      return 'bg-orange-300';
    case 'DONE':
      return 'bg-green-500';
    case 'ERROR':
      return 'bg-red-500';
    case 'ACCEPTED':
    default:
      return 'bg-transparent';
  }
}

function acceptLabel(scope: GenerationSession['scope']): string {
  switch (scope) {
    case 'LINKEDIN':
      return 'Accept LinkedIn Draft';
    case 'COMPANY':
      return 'Accept Company Resume';
    case 'ENTRY_DOCUMENT':
      return 'Accept Document';
    default:
      return 'Accept Resume for This Application';
  }
}

function formatLinkedinMessage(content: string): string {
  // Done-turn messages are JSON-encoded {headline, about, entry_bullets} (see
  // SessionsService.runLinkedinTurn on the backend); a question is plain text
  // and won't parse as that shape, so just fall back to showing it as-is.
  try {
    const parsed = JSON.parse(content) as {
      headline?: string;
      about?: string;
      entry_bullets?: { entry_type: string; bullets: string[] }[];
    };
    if (!parsed.headline && !parsed.about) return content;
    const sections = [
      parsed.headline ? `Headline:\n${parsed.headline}` : '',
      parsed.about ? `About:\n${parsed.about}` : '',
      ...(parsed.entry_bullets ?? []).map(
        (eb) => `${eb.entry_type}:\n${eb.bullets.map((b) => `• ${b}`).join('\n')}`,
      ),
    ].filter(Boolean);
    return sections.join('\n\n');
  } catch {
    return content;
  }
}

function formatResumeMessage(content: string): string {
  // Done-turn messages are JSON-encoded StructuredResume ({contactLine,
  // sections}) (see SessionsService.runApplicationTurn/runCompanyTurn on the
  // backend); a question is plain text and won't parse as that shape, so
  // just fall back to showing it as-is.
  try {
    const parsed = JSON.parse(content) as {
      contactLine?: string;
      sections?: {
        heading: string;
        entries: { name: string; subtitle?: string | null; location?: string | null; dateRange?: string | null; bullets: string[] }[];
      }[];
    };
    if (!parsed.contactLine && !parsed.sections) return content;
    const sections = (parsed.sections ?? []).map((section) => {
      const entryLines = section.entries
        .map((entry) => {
          const trailing = [entry.dateRange, entry.location].filter(Boolean).join(' | ');
          const header = [entry.name, trailing].filter(Boolean).join(' — ');
          const bullets = entry.bullets.map((b) => `  • ${b}`).join('\n');
          return [header, entry.subtitle, bullets].filter(Boolean).join('\n');
        })
        .join('\n\n');
      return `${section.heading.toUpperCase()}\n${entryLines}`;
    });
    return [parsed.contactLine, ...sections].filter(Boolean).join('\n\n');
  } catch {
    return content;
  }
}

function formatEntryDocumentMessage(content: string): string {
  // A done-turn message is the generated document's sanitized HTML itself
  // (see SessionsService.runEntryDocumentTurn) — the chat panel shows a
  // plain-text preview here rather than rendering it as rich text (that
  // happens in the actual entry-document-editor.tsx once accepted); a
  // question is already plain text and passes through unchanged (no tags
  // to strip).
  return content
    .replace(/<\/(p|h[1-3]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sessionLabel(
  session: GenerationSession,
  applicationsById: Map<string, Application>,
): string {
  if (session.scope === 'LINKEDIN') return 'LinkedIn';
  if (session.scope === 'COMPANY') return session.company ?? 'Company';
  if (session.scope === 'REFERRAL') return `Referral — ${session.company ?? ''}`;
  if (session.scope === 'ENTRY_DOCUMENT') {
    const typeLabel = session.entryType
      ? session.entryType.toLowerCase().replace(/_/g, ' ')
      : 'entry';
    return `Document — ${typeLabel}`;
  }
  // APPLICATION scope — label by "Company - Job Title" when we have the
  // application on hand, falling back to a timestamp for an application
  // that's since been deleted (or hasn't loaded yet).
  const application = session.applicationId ? applicationsById.get(session.applicationId) : undefined;
  if (application) {
    return [application.company, application.role].filter(Boolean).join(' - ');
  }
  return new Date(session.createdAt).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function groupByDate(sessions: GenerationSession[]): [string, GenerationSession[]][] {
  const groups = new Map<string, GenerationSession[]>();
  for (const session of sessions) {
    const key = session.createdAt.slice(0, 10);
    const group = groups.get(key) ?? [];
    group.push(session);
    groups.set(key, group);
  }
  return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
}

export function SessionsPanel() {
  const { open, activeSessionId, closePanel, setActiveSessionId } = useSessionsPanel();

  const { data: sessions } = useQuery({
    queryKey: ['sessions'],
    queryFn: api.listSessions,
    enabled: open,
    refetchInterval: open ? 2000 : false,
  });
  // Needed only to label APPLICATION-scope sessions by "Company - Job Title"
  // instead of a bare timestamp — already fetched/cached elsewhere in the
  // app under the same query key, so this just reuses that cache entry.
  const { data: applications } = useQuery({
    queryKey: ['applications'],
    queryFn: api.listApplications,
    enabled: open,
  });
  const applicationsById = useMemo(
    () => new Map((applications ?? []).map((a) => [a.id, a])),
    [applications],
  );

  const activeSession = sessions?.find((s) => s.id === activeSessionId);
  const grouped = useMemo(() => groupByDate(sessions ?? []), [sessions]);

  if (!open) return null;

  return (
    <div className="fixed inset-y-0 right-0 w-[480px] bg-white dark:bg-neutral-900 border-l shadow-xl z-50 flex flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-medium">Generation Sessions</h2>
        <button className="text-xs opacity-60 hover:opacity-100" onClick={closePanel}>
          Close
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-40 border-r overflow-y-auto flex flex-col">
          {grouped.map(([date, dateSessions]) => (
            <div key={date} className="flex flex-col">
              <div className="text-[10px] uppercase opacity-50 px-3 pt-3 pb-1">
                {new Date(date).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                })}
              </div>
              {dateSessions.map((session) => (
                <button
                  key={session.id}
                  onClick={() => setActiveSessionId(session.id)}
                  className={`flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-black/5 dark:hover:bg-white/5 ${
                    session.id === activeSessionId ? 'bg-black/5 dark:bg-white/10' : ''
                  }`}
                >
                  <span
                    className={`inline-block w-2 h-2 rounded-full shrink-0 ${statusDotClass(session.status)}`}
                  />
                  <span className="truncate">{sessionLabel(session, applicationsById)}</span>
                </button>
              ))}
            </div>
          ))}
          {sessions?.length === 0 && (
            <p className="text-xs opacity-50 px-3 py-3">No sessions yet.</p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {activeSession ? (
            <SessionChat session={activeSession} />
          ) : (
            <p className="text-xs opacity-50 p-4">Select a session on the left.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function SessionChat({ session }: { session: GenerationSession }) {
  const queryClient = useQueryClient();
  const [reply, setReply] = useState('');
  const [previewApplicationId, setPreviewApplicationId] = useState<string | null>(null);

  const replyMutation = useMutation({
    mutationFn: () => api.replyToSession(session.id, reply),
    onSuccess: () => {
      setReply('');
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });

  const acceptMutation = useMutation({
    mutationFn: () => api.acceptSession(session.id),
    onSuccess: (updatedSession) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      if (session.scope === 'APPLICATION') {
        queryClient.invalidateQueries({ queryKey: ['applications'] });
        queryClient.invalidateQueries({ queryKey: ['applications', session.applicationId] });
        if (updatedSession.applicationId) {
          setPreviewApplicationId(updatedSession.applicationId);
        }
      } else if (session.scope === 'LINKEDIN') {
        queryClient.invalidateQueries({ queryKey: ['linkedin-profile'] });
        queryClient.invalidateQueries({ queryKey: ['linkedin-staleness'] });
      } else if (session.scope === 'COMPANY') {
        queryClient.invalidateQueries({ queryKey: ['company-resumes'] });
        queryClient.invalidateQueries({ queryKey: ['company-resume', session.company] });
      } else if (session.scope === 'ENTRY_DOCUMENT') {
        queryClient.invalidateQueries({
          queryKey: ['entry-document', session.entryType, session.entryId],
        });
      }
    },
  });

  const isRunning = session.status === 'RUNNING';
  const isWaitingForInput = session.status === 'WAITING_FOR_INPUT';
  const isDone = session.status === 'DONE';

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {session.messages.map((message) =>
          message.role === 'TOOL' ? (
            // Live one-line progress update (e.g. "Evaluating X..." / "X
            // done" / "Merging..." ), posted by the agent mid-run — a
            // compact status line, not a full chat bubble, so a long
            // generation's progress stays scannable at a glance.
            <div key={message.id} className="text-xs opacity-50 self-start">
              {message.content}
            </div>
          ) : (
            <div
              key={message.id}
              className={`text-sm rounded p-2 whitespace-pre-wrap ${
                message.role === 'USER'
                  ? 'bg-blue-50 dark:bg-blue-950/40 self-end max-w-[85%]'
                  : 'bg-black/5 dark:bg-white/5 self-start max-w-[90%]'
              }`}
            >
              {message.role !== 'ASSISTANT'
                ? message.content
                : session.scope === 'REFERRAL'
                  ? <ReferralResult content={message.content} />
                  : session.scope === 'LINKEDIN'
                  ? formatLinkedinMessage(message.content)
                  : session.scope === 'ENTRY_DOCUMENT'
                    ? formatEntryDocumentMessage(message.content)
                    : formatResumeMessage(message.content)}
            </div>
          ),
        )}
        {isRunning && (
          <div className="text-xs opacity-50 self-start flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-orange-300 animate-pulse" />
            Working...
          </div>
        )}
        {session.status === 'ERROR' && (
          <div className="text-xs text-red-600 dark:text-red-400 self-start">
            {session.errorMessage ?? 'Something went wrong.'}
          </div>
        )}
      </div>

      {isWaitingForInput && (
        <div className="border-t p-3 flex gap-2">
          <input
            className="flex-1 border rounded px-2 py-1 text-sm bg-transparent"
            placeholder="Type your answer..."
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && reply && replyMutation.mutate()}
          />
          <button
            className="px-3 py-1 text-sm rounded border"
            onClick={() => replyMutation.mutate()}
            disabled={!reply || replyMutation.isPending}
          >
            Send
          </button>
        </div>
      )}

      {isDone && (
        <div className="border-t p-3">
          <button
            className="w-full px-3 py-1.5 text-sm rounded bg-black text-white dark:bg-white dark:text-black"
            onClick={() => acceptMutation.mutate()}
            disabled={acceptMutation.isPending}
          >
            {acceptMutation.isPending ? 'Saving...' : acceptLabel(session.scope)}
          </button>
        </div>
      )}

      {session.status === 'ACCEPTED' && (
        <div className="border-t p-3 text-xs text-center opacity-60">
          {session.scope === 'REFERRAL'
            ? 'Saved to the contact’s referral history on the Company Resumes page.'
            : session.scope === 'LINKEDIN'
            ? 'Accepted — saved to your LinkedIn profile draft.'
            : session.scope === 'COMPANY'
              ? `Accepted — saved as the common resume for ${session.company}.`
              : session.scope === 'ENTRY_DOCUMENT'
                ? 'Accepted — saved as this entry’s detailed document.'
                : 'Accepted — saved to the application.'}
        </div>
      )}

      {previewApplicationId && (
        <ResumePreviewDialog
          applicationId={previewApplicationId}
          onClose={() => setPreviewApplicationId(null)}
        />
      )}
    </div>
  );
}

/** Final message of a REFERRAL session: the drafted message, how the single
 * resume scored against each role's JD (with a warning if 90% wasn't
 * reachable), and downloads for that resume. */
function ReferralResult({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  let parsed: {
    referralId: string;
    message: string;
    scores: ReferralRoleScore[];
    targetMet: boolean;
    note: string | null;
  };
  try {
    parsed = JSON.parse(content);
  } catch {
    return <>{content}</>;
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium uppercase opacity-60">Referral message</div>
      <div>{parsed.message}</div>
      <button
        className="px-2 py-1 text-xs rounded border w-fit"
        onClick={() => {
          navigator.clipboard?.writeText(parsed.message).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? 'Copied' : 'Copy message'}
      </button>
      <div className="text-xs font-medium uppercase opacity-60 mt-1">ATS match of the attached resume</div>
      <ScoreChips scores={parsed.scores} />
      {parsed.targetMet && (
        <div className="text-xs text-green-700 dark:text-green-400">Every linked role is at or above 90%.</div>
      )}
      {parsed.note && (
        <div
          className={`text-xs ${parsed.targetMet ? 'opacity-70' : 'text-amber-700 dark:text-amber-400'}`}
        >
          {parsed.note}
        </div>
      )}
      <div className="flex items-center gap-2">
        <a href={`${API_BASE}/referrals/${parsed.referralId}/resume.pdf`} className="px-2 py-1 text-xs rounded border">
          Resume PDF
        </a>
        <a href={`${API_BASE}/referrals/${parsed.referralId}/resume.docx`} className="px-2 py-1 text-xs rounded border">
          Resume Word
        </a>
      </div>
    </div>
  );
}

/**
 * Shown right after accepting an APPLICATION-scope session — embeds the PDF
 * inline (the resume.pdf endpoint's `inline=1` disposition makes that
 * possible; the plain download links elsewhere keep forcing a download) and
 * offers a one-click Word download alongside it, since .docx has no
 * practical in-browser preview.
 */
function ResumePreviewDialog({
  applicationId,
  onClose,
}: {
  applicationId: string;
  onClose: () => void;
}) {
  const pdfUrl = `${API_BASE}/applications/${applicationId}/resume.pdf?inline=1`;
  const pdfDownloadUrl = `${API_BASE}/applications/${applicationId}/resume.pdf`;
  const docxDownloadUrl = `${API_BASE}/applications/${applicationId}/resume.docx`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white dark:bg-neutral-900 rounded-lg shadow-xl w-full max-w-3xl h-[90vh] flex flex-col">
        <div className="flex items-center justify-between border-b p-3">
          <h2 className="text-sm font-medium">Resume Preview</h2>
          <div className="flex items-center gap-2">
            <a href={pdfDownloadUrl} className="px-2 py-1 text-xs rounded border">
              Download PDF
            </a>
            <a href={docxDownloadUrl} className="px-2 py-1 text-xs rounded border">
              Download Word
            </a>
            <button className="px-2 py-1 text-xs rounded border" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        <iframe src={pdfUrl} title="Resume PDF preview" className="flex-1 w-full" />
      </div>
    </div>
  );
}
