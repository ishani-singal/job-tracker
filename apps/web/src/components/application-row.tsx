'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Application } from '@job-tracker/shared-types';
import { api } from '@/lib/api';

export function ApplicationRow({ application }: { application: Application }) {
  const queryClient = useQueryClient();
  const [generating, setGenerating] = useState(false);

  const markApplied = useMutation({
    mutationFn: () =>
      api.updateApplication(application.id, {
        status: 'APPLIED',
        appliedDate: new Date().toISOString().slice(0, 10),
      } as Partial<Application>),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['applications'] }),
  });

  async function handleGenerateResume() {
    setGenerating(true);
    try {
      await api.generateResume(application.id);
      queryClient.invalidateQueries({ queryKey: ['applications'] });
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="flex items-center justify-between border rounded px-4 py-3 text-sm">
      <div className="flex flex-col gap-0.5">
        <Link href={`/applications/${application.id}`} className="font-medium hover:underline">
          {application.company}
        </Link>
        <span className="text-xs opacity-60">
          {application.status === 'APPLIED' ? 'Applied' : 'Not applied'}
          {application.rejectedDate ? ' · Rejected' : ''}
        </span>
      </div>
      <div className="flex gap-2">
        {application.status !== 'APPLIED' && (
          <button
            className="px-2 py-1 text-xs rounded border"
            onClick={() => markApplied.mutate()}
          >
            Mark Applied
          </button>
        )}
        <button
          className="px-2 py-1 text-xs rounded border"
          onClick={handleGenerateResume}
          disabled={generating}
        >
          {generating ? 'Generating...' : 'Generate Resume'}
        </button>
      </div>
    </div>
  );
}
