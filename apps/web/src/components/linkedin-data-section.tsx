'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

export function LinkedinDataSection() {
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [expandedThread, setExpandedThread] = useState<string | null>(null);

  const { data: summary } = useQuery({
    queryKey: ['linkedin-data-summary'],
    queryFn: api.getLinkedinDataSummary,
  });
  const { data: connections } = useQuery({
    queryKey: ['linkedin-connections', search],
    queryFn: () => api.listLinkedinConnections(search),
    enabled: !!summary,
  });
  const { data: threads } = useQuery({
    queryKey: ['linkedin-message-threads'],
    queryFn: api.listLinkedinMessageThreads,
    enabled: !!summary,
  });

  async function handleUpload(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${API_BASE}/linkedin-data/import`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        setUploadError(`Import failed: ${res.status} ${await res.text()}`);
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['linkedin-data-summary'] });
      queryClient.invalidateQueries({ queryKey: ['linkedin-connections'] });
      queryClient.invalidateQueries({ queryKey: ['linkedin-message-threads'] });
    } finally {
      setUploading(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 border-t pt-6">
      <div>
        <h2 className="text-sm font-medium">Connections & Messages</h2>
        <p className="text-xs opacity-60">
          LinkedIn doesn&apos;t let third-party apps read your connections or messages via
          API — this only works via LinkedIn&apos;s own manual data export. Go to LinkedIn
          → Settings → &quot;Get a copy of your data&quot;, request it, then upload the ZIP
          file it emails you here. Not live, not automatic — re-upload whenever you want an
          updated snapshot.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="file"
          accept=".zip"
          onChange={(e) => e.target.files?.[0] && handleUpload(e.target.files[0])}
          disabled={uploading}
        />
        {uploading && <span className="text-xs opacity-60">Importing...</span>}
      </div>
      {uploadError && <p className="text-xs text-red-600 dark:text-red-400">{uploadError}</p>}

      {summary && (
        <p className="text-xs opacity-60">
          Last imported {new Date(summary.importedAt).toLocaleString()} —{' '}
          {summary.connectionCount} connections, {summary.messageCount} messages.
        </p>
      )}

      {summary && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <input
              className="border rounded px-2 py-1 text-sm bg-transparent"
              placeholder="Search connections by name or company..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="max-h-64 overflow-y-auto flex flex-col gap-1">
              {connections?.map((c) => (
                <div key={c.id} className="border rounded px-3 py-2 text-sm">
                  <div className="font-medium">
                    {c.firstName} {c.lastName}
                  </div>
                  <div className="text-xs opacity-60">
                    {[c.position, c.company].filter(Boolean).join(' at ')}
                    {c.connectedOn &&
                      ` · Connected ${new Date(c.connectedOn).toLocaleDateString()}`}
                  </div>
                </div>
              ))}
              {connections?.length === 0 && (
                <p className="text-xs opacity-50">No connections match.</p>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-medium uppercase opacity-60">Message Threads</h3>
            <div className="flex flex-col gap-1">
              {threads?.map((t) => (
                <ThreadRow
                  key={t.conversationId}
                  thread={t}
                  expanded={expandedThread === t.conversationId}
                  onToggle={() =>
                    setExpandedThread(
                      expandedThread === t.conversationId ? null : t.conversationId,
                    )
                  }
                />
              ))}
              {threads?.length === 0 && (
                <p className="text-xs opacity-50">No message threads imported.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function ThreadRow({
  thread,
  expanded,
  onToggle,
}: {
  thread: { conversationId: string; messageCount: number; lastMessageAt: string | null; participants: string[] };
  expanded: boolean;
  onToggle: () => void;
}) {
  const { data: messages } = useQuery({
    queryKey: ['linkedin-thread-messages', thread.conversationId],
    queryFn: () => api.getLinkedinThreadMessages(thread.conversationId),
    enabled: expanded,
  });

  return (
    <div className="border rounded">
      <button
        className="w-full text-left px-3 py-2 text-sm flex items-center justify-between"
        onClick={onToggle}
      >
        <span>{thread.participants.join(', ') || 'Unknown'}</span>
        <span className="text-xs opacity-50">
          {thread.messageCount} messages
          {thread.lastMessageAt &&
            ` · ${new Date(thread.lastMessageAt).toLocaleDateString()}`}
        </span>
      </button>
      {expanded && messages && (
        <div className="border-t p-3 flex flex-col gap-2 max-h-64 overflow-y-auto">
          {messages.map((m) => (
            <div key={m.id} className="text-xs">
              <span className="font-medium">{m.fromName}:</span> {m.content}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
