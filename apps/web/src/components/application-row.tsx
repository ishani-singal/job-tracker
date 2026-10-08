'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Application } from '@job-tracker/shared-types';
import { api } from '@/lib/api';
import { AddApplicationDialog } from './add-application-dialog';
import { MarkAppliedDialog } from './mark-applied-dialog';
import { useSessionsPanel } from '@/lib/sessions-panel-context';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

function rowBackgroundClass(application: Application): string {
  if (application.derivedStatus === 'rejected' || application.derivedStatus === 'inactive') {
    return 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900';
  }
  if (application.status === 'APPLIED') {
    return 'bg-green-50 dark:bg-green-950/40 border-green-200 dark:border-green-900';
  }
  return '';
}

export function ApplicationRow({
  application,
  onUnselect,
  unselecting,
}: {
  application: Application;
  onUnselect?: () => void;
  unselecting?: boolean;
}) {
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const { openPanel } = useSessionsPanel();

  const [markAppliedOpen, setMarkAppliedOpen] = useState(false);

  const deleteApplication = useMutation({
    mutationFn: () => api.deleteApplication(application.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['applications'] }),
  });

  const startSession = useMutation({
    mutationFn: () => api.startSession(application.id),
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      openPanel(session.id);
    },
  });

  function handleDelete() {
    if (confirm(`Delete application at ${application.company}? This can't be undone.`)) {
      deleteApplication.mutate();
    }
  }

  return (
    <div
      className={`flex items-center justify-between border rounded px-4 py-3 text-sm ${rowBackgroundClass(application)}`}
    >
      <div className="flex flex-col gap-0.5">
        <Link href={`/applications/${application.id}`} className="font-medium hover:underline">
          {application.company}
          {application.role ? ` — ${application.role}` : ''}
        </Link>
        <span className="text-xs opacity-60">
          {application.status === 'APPLIED'
            ? `Applied${application.appliedDate ? ` ${application.appliedDate.slice(0, 10)}` : ''}`
            : 'Not applied'}
          {application.rejectedDate
            ? ' · Rejected'
            : application.derivedStatus === 'inactive'
              ? ' · Inactive'
              : application.derivedStatus === 'stale'
                ? ' · Stale'
                : ''}
        </span>
      </div>
      <div className="flex gap-2">
        {application.status !== 'APPLIED' && (
          <button
            className="px-2 py-1 text-xs rounded border"
            onClick={() => setMarkAppliedOpen(true)}
          >
            Mark Applied
          </button>
        )}
        <button
          className="px-2 py-1 text-xs rounded border"
          onClick={() => startSession.mutate()}
          disabled={startSession.isPending}
        >
          {startSession.isPending ? 'Starting...' : application.resumeContent ? 'Regenerate' : 'Generate Resume'}
        </button>
        {application.resumeContent && (
          <>
            <a
              href={`${API_BASE}/applications/${application.id}/resume.pdf`}
              className="px-2 py-1 text-xs rounded border"
            >
              Download PDF
            </a>
            <a
              href={`${API_BASE}/applications/${application.id}/resume.docx`}
              className="px-2 py-1 text-xs rounded border"
            >
              Download Word
            </a>
          </>
        )}
        <button className="px-2 py-1 text-xs rounded border" onClick={() => setEditOpen(true)}>
          Edit
        </button>
        {onUnselect && (
          <button
            className="px-2 py-1 text-xs rounded border"
            onClick={onUnselect}
            disabled={unselecting}
          >
            {unselecting ? 'Unselecting...' : 'Unselect'}
          </button>
        )}
        <button
          className="px-2 py-1 text-xs rounded border text-red-600 dark:text-red-400"
          onClick={handleDelete}
          disabled={deleteApplication.isPending}
        >
          Delete
        </button>
      </div>

      <MarkAppliedDialog
        application={application}
        open={markAppliedOpen}
        onOpenChange={setMarkAppliedOpen}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ['applications'] })}
      />
      <AddApplicationDialog
        editApplication={application}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ['applications'] })}
      />
    </div>
  );
}
