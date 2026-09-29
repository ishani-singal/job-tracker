'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useSessionsPanel } from '@/lib/sessions-panel-context';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

export default function CompanyResumesPage() {
  const { data: companies } = useQuery({
    queryKey: ['company-resumes'],
    queryFn: api.listCompanyResumes,
  });
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Company Resumes</h1>
        <p className="text-sm opacity-60">
          One common resume per company, generated only from that company&apos;s own
          applications (applied ones only, once you&apos;ve applied to at least one).
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {companies?.map((c) => (
          <CompanyRow
            key={c.company}
            company={c.company}
            hasResume={c.hasResume}
            updatedAt={c.updatedAt}
            expanded={expanded === c.company}
            onToggleExpand={() =>
              setExpanded(expanded === c.company ? null : c.company)
            }
          />
        ))}
        {companies?.length === 0 && (
          <p className="text-sm opacity-60">
            No applications yet — add one on the Applications tab first.
          </p>
        )}
      </div>
    </div>
  );
}

function CompanyRow({
  company,
  hasResume,
  updatedAt,
  expanded,
  onToggleExpand,
}: {
  company: string;
  hasResume: boolean;
  updatedAt: string | null;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const queryClient = useQueryClient();
  const { openPanel } = useSessionsPanel();

  const { data: resume } = useQuery({
    queryKey: ['company-resume', company],
    queryFn: () => api.getCompanyResume(company),
    enabled: expanded && hasResume,
  });

  const startSession = useMutation({
    mutationFn: () => api.startCompanySession(company),
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      openPanel(session.id);
    },
  });

  return (
    <div className="border rounded">
      <div className="flex items-center justify-between px-4 py-3">
        <button
          className="flex-1 text-left font-medium text-sm hover:underline"
          onClick={onToggleExpand}
          disabled={!hasResume}
        >
          {company}
        </button>
        <div className="flex items-center gap-2">
          {updatedAt && (
            <span className="text-xs opacity-50">
              {new Date(updatedAt).toLocaleDateString()}
            </span>
          )}
          {hasResume && (
            <a
              href={`${API_BASE}/company-resumes/${encodeURIComponent(company)}/resume.pdf`}
              className="px-2 py-1 text-xs rounded border"
            >
              Download PDF
            </a>
          )}
          <button
            className="px-2 py-1 text-xs rounded border"
            onClick={() => startSession.mutate()}
            disabled={startSession.isPending}
          >
            {startSession.isPending
              ? 'Starting...'
              : hasResume
                ? 'Regenerate'
                : 'Generate'}
          </button>
        </div>
      </div>
      {expanded && resume && (
        <pre className="text-sm whitespace-pre-wrap border-t p-3">
          {resume.resumeContent}
        </pre>
      )}
    </div>
  );
}
