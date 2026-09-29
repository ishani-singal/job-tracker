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

      <TrackCompaniesSection />

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

function TrackCompaniesSection() {
  const queryClient = useQueryClient();
  const [input, setInput] = useState('');
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  const { data: tracked } = useQuery({
    queryKey: ['tracked-companies'],
    queryFn: api.listTrackedCompanies,
    refetchInterval: (query) => {
      const anyDiscovering = query.state.data?.some((c) => c.discoveryStatus === 'DISCOVERING');
      return anyDiscovering ? 3000 : false;
    },
  });

  const addCompanies = useMutation({
    mutationFn: (companies: string) => api.addTrackedCompanies(companies),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['tracked-companies'] });
      const parts: string[] = [];
      if (result.created.length) parts.push(`Added ${result.created.length}, discovering roles...`);
      if (result.skipped.length) parts.push(`${result.skipped.length} already tracked`);
      setResultMsg(parts.join(' — ') || 'Nothing to add.');
      setInput('');
    },
  });

  const rediscover = useMutation({
    mutationFn: (id: string) => api.rediscoverCompany(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tracked-companies'] }),
  });

  const removeCompany = useMutation({
    mutationFn: (id: string) => api.deleteTrackedCompany(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tracked-companies'] });
      queryClient.invalidateQueries({ queryKey: ['discovered-roles'] });
    },
  });

  const importFromApplications = useMutation({
    mutationFn: () => api.importCompaniesFromApplications(),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['tracked-companies'] });
      const parts: string[] = [];
      if (result.created.length) parts.push(`Imported ${result.created.length}, discovering roles...`);
      if (result.skipped.length) parts.push(`${result.skipped.length} already tracked`);
      setResultMsg(parts.join(' — ') || 'No new companies to import.');
    },
  });

  return (
    <div className="border rounded p-4 flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-medium">Track Companies for Open Roles</h2>
        <p className="text-xs opacity-60">
          Enter one or more companies (comma or newline separated) — job-tracker will find each
          company&apos;s career page and pull open roles into the Applications tab for you to
          review and select.
        </p>
      </div>
      <textarea
        className="border rounded px-2 py-1.5 text-sm h-20 bg-transparent"
        placeholder={'Amazon, Salesforce, Stripe\nor one per line'}
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <button
          className="px-3 py-1.5 text-sm rounded bg-black text-white dark:bg-white dark:text-black w-fit"
          onClick={() => input.trim() && addCompanies.mutate(input)}
          disabled={addCompanies.isPending || !input.trim()}
        >
          {addCompanies.isPending ? 'Adding...' : 'Track Companies'}
        </button>
        <button
          className="px-3 py-1.5 text-sm rounded border w-fit"
          onClick={() => importFromApplications.mutate()}
          disabled={importFromApplications.isPending}
        >
          {importFromApplications.isPending
            ? 'Importing...'
            : 'Import from Applications'}
        </button>
        {resultMsg && <span className="text-xs opacity-60">{resultMsg}</span>}
      </div>

      {tracked && tracked.length > 0 && (
        <div className="flex flex-col gap-1 mt-1">
          {tracked.map((c) => (
            <div key={c.id} className="flex items-center justify-between text-xs border rounded px-3 py-1.5">
              <span className="font-medium">{c.name}</span>
              <div className="flex items-center gap-2 opacity-70">
                <StatusBadge status={c.discoveryStatus} />
                <span>{c._count?.roles ?? 0} roles</span>
                <button
                  className="underline"
                  onClick={() => rediscover.mutate(c.id)}
                  disabled={c.discoveryStatus === 'DISCOVERING'}
                >
                  Re-scan
                </button>
                <button
                  className="underline text-red-600 dark:text-red-400"
                  onClick={() => {
                    if (confirm(`Stop tracking ${c.name}? Its unselected open roles will be removed.`)) {
                      removeCompany.mutate(c.id);
                    }
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    PENDING: 'text-gray-500',
    DISCOVERING: 'text-blue-600',
    DONE: 'text-green-600',
    FAILED: 'text-red-600',
  };
  return <span className={colors[status] ?? ''}>{status.toLowerCase()}</span>;
}
