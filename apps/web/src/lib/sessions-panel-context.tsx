'use client';

import { createContext, useContext, useState } from 'react';

interface SessionsPanelContextValue {
  open: boolean;
  activeSessionId: string | null;
  openPanel: (sessionId?: string) => void;
  closePanel: () => void;
  setActiveSessionId: (id: string | null) => void;
}

const SessionsPanelContext = createContext<SessionsPanelContextValue | null>(null);

export function SessionsPanelProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  return (
    <SessionsPanelContext.Provider
      value={{
        open,
        activeSessionId,
        openPanel: (sessionId) => {
          if (sessionId) setActiveSessionId(sessionId);
          setOpen(true);
        },
        closePanel: () => setOpen(false),
        setActiveSessionId,
      }}
    >
      {children}
    </SessionsPanelContext.Provider>
  );
}

export function useSessionsPanel() {
  const ctx = useContext(SessionsPanelContext);
  if (!ctx) throw new Error('useSessionsPanel must be used within SessionsPanelProvider');
  return ctx;
}
