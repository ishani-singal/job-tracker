'use client';

import { use, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Application } from '@job-tracker/shared-types';

export default function ApplicationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const queryClient = useQueryClient();
  const { data: application } = useQuery({
    queryKey: ['applications', id],
    queryFn: () => api.getApplication(id),
  });
  const [generating, setGenerating] = useState(false);

  if (!application) return <p className="text-sm opacity-60">Loading...</p>;

  async function update(patch: Partial<Application>) {
    await api.updateApplication(id, patch);
    queryClient.invalidateQueries({ queryKey: ['applications', id] });
    queryClient.invalidateQueries({ queryKey: ['applications'] });
  }

  async function handleGenerateResume() {
    setGenerating(true);
    try {
      await api.generateResume(id);
      queryClient.invalidateQueries({ queryKey: ['applications', id] });
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">{application.company}</h1>
        {application.jobUrl && (
          <a
            href={application.jobUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs opacity-60 hover:underline"
          >
            {application.jobUrl}
          </a>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4 text-sm">
        <DateField
          label="Applied Date"
          value={application.appliedDate}
          onChange={(v) => update({ appliedDate: v, status: v ? 'APPLIED' : 'NOT_APPLIED' })}
        />
        <DateField
          label="Last Message Received"
          value={application.lastMessageReceivedDate}
          onChange={(v) => update({ lastMessageReceivedDate: v })}
        />
        <DateField
          label="Rejected Date"
          value={application.rejectedDate}
          onChange={(v) => update({ rejectedDate: v })}
        />
        <DateField
          label="Apply By"
          value={application.applyByDate}
          onChange={(v) => update({ applyByDate: v })}
        />
      </div>

      <div>
        <h2 className="text-sm font-medium mb-1">Job Description</h2>
        <p className="text-sm whitespace-pre-wrap opacity-80">
          {application.jdText || 'No JD recorded.'}
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-medium">Generated Resume</h2>
          <button
            className="px-2 py-1 text-xs rounded border"
            onClick={handleGenerateResume}
            disabled={generating}
          >
            {generating
              ? 'Generating...'
              : application.resumeContent
                ? 'Regenerate Resume'
                : 'Generate Resume'}
          </button>
        </div>
        {application.resumeContent ? (
          <pre className="text-sm whitespace-pre-wrap border rounded p-3">
            {application.resumeContent}
          </pre>
        ) : (
          <p className="text-sm opacity-60">No resume generated yet.</p>
        )}
      </div>
    </div>
  );
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs opacity-80">
      {label}
      <input
        type="date"
        className="border rounded px-2 py-1 text-sm bg-transparent"
        value={value ? value.slice(0, 10) : ''}
        onChange={(e) => onChange(e.target.value || null)}
      />
    </label>
  );
}
