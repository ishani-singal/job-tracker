'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useSessionsPanel } from '@/lib/sessions-panel-context';
import type { GenerationSession } from '@job-tracker/shared-types';

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

function sessionLabel(session: GenerationSession): string {
  if (session.scope === 'LINKEDIN') return 'LinkedIn';
  if (session.scope === 'COMPANY') return session.company ?? 'Company';
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

  const activeSession = sessions?.find((s) => s.id === activeSessionId);
  const grouped = useMemo(() => groupByDate(sessions ?? []), [sessions]);

  if (!open) return null;

  return (
    <div className="fixed inset-y-0 right-0 w-[480px] bg-white dark:bg-neutral-900 border-l shadow-xl z-50 flex flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-medium">Resume Generation Sessions</h2>
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
                  <span className="truncate">{sessionLabel(session)}</span>
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

  const replyMutation = useMutation({
    mutationFn: () => api.replyToSession(session.id, reply),
    onSuccess: () => {
      setReply('');
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });

  const acceptMutation = useMutation({
    mutationFn: () => api.acceptSession(session.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      if (session.scope === 'APPLICATION') {
        queryClient.invalidateQueries({ queryKey: ['applications'] });
        queryClient.invalidateQueries({ queryKey: ['applications', session.applicationId] });
      } else if (session.scope === 'LINKEDIN') {
        queryClient.invalidateQueries({ queryKey: ['linkedin-profile'] });
        queryClient.invalidateQueries({ queryKey: ['linkedin-staleness'] });
      } else if (session.scope === 'COMPANY') {
        queryClient.invalidateQueries({ queryKey: ['company-resumes'] });
        queryClient.invalidateQueries({ queryKey: ['company-resume', session.company] });
      }
    },
  });

  const isRunning = session.status === 'RUNNING';
  const isWaitingForInput = session.status === 'WAITING_FOR_INPUT';
  const isDone = session.status === 'DONE';

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {session.messages.map((message) => (
          <div
            key={message.id}
            className={`text-sm rounded p-2 whitespace-pre-wrap ${
              message.role === 'USER'
                ? 'bg-blue-50 dark:bg-blue-950/40 self-end max-w-[85%]'
                : 'bg-black/5 dark:bg-white/5 self-start max-w-[90%]'
            }`}
          >
            {session.scope === 'LINKEDIN' && message.role === 'ASSISTANT'
              ? formatLinkedinMessage(message.content)
              : message.content}
          </div>
        ))}
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
          {session.scope === 'LINKEDIN'
            ? 'Accepted — saved to your LinkedIn profile draft.'
            : session.scope === 'COMPANY'
              ? `Accepted — saved as the common resume for ${session.company}.`
              : 'Accepted — saved to the application.'}
        </div>
      )}
    </div>
  );
}
