'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useSessionsPanel } from '@/lib/sessions-panel-context';

export function NavChatButton() {
  const { open, openPanel, closePanel } = useSessionsPanel();

  // Light polling even while closed so the badge reflects reality when you
  // switch tabs — much slower than the panel's own 2s refresh since this is
  // just for the dot, not live chat content.
  const { data: sessions } = useQuery({
    queryKey: ['sessions'],
    queryFn: api.listSessions,
    refetchInterval: 10000,
  });

  const hasRunning = sessions?.some(
    (s) => s.status === 'RUNNING' || s.status === 'WAITING_FOR_INPUT',
  );

  return (
    <button
      onClick={() => (open ? closePanel() : openPanel())}
      className="relative ml-auto flex items-center gap-1.5 px-3 py-1.5 text-sm rounded border hover:bg-black/5 dark:hover:bg-white/5"
      title="Generation sessions"
    >
      Chat
      {hasRunning && (
        <span className="inline-block w-2 h-2 rounded-full bg-orange-400 animate-pulse" />
      )}
    </button>
  );
}
