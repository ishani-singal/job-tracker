'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useSessionsPanel } from '@/lib/sessions-panel-context';
import type { TrackedCompany } from '@job-tracker/shared-types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

type CompanyRow = TrackedCompany & {
  hasResume: boolean;
  resumeCompanyKey: string;
  resumeUpdatedAt: string | null;
};

export default function CompanyResumesPage() {
  const queryClient = useQueryClient();
  const [input, setInput] = useState('');
  const [resultMsg, setResultMsg] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualName, setManualName] = useState('');
  const [manualUrl, setManualUrl] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: companies } = useQuery({
    queryKey: ['tracked-companies'],
    queryFn: api.listTrackedCompanies as () => Promise<CompanyRow[]>,
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

  const addWithCareerUrl = useMutation({
    mutationFn: () => api.addCompanyWithCareerUrl(manualName, manualUrl),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['tracked-companies'] });
      setResultMsg(`Added ${result.name} with your career page — discovering roles...`);
      setManualName('');
      setManualUrl('');
      setManualOpen(false);
    },
  });

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Companies</h1>
        <p className="text-sm opacity-60">
          Every company you&apos;ve applied to is tracked automatically for open-role discovery.
          Each also gets one common resume, generated from that company&apos;s own applications.
        </p>
      </div>

      <div className="border rounded p-4 flex flex-col gap-3">
        <textarea
          className="border rounded px-2 py-1.5 text-sm h-20 bg-transparent"
          placeholder={'Add more companies: Amazon, Salesforce, Stripe\nor one per line'}
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
            onClick={() => setManualOpen((v) => !v)}
          >
            {manualOpen ? 'Cancel' : 'Enter Career Page Manually'}
          </button>
          {resultMsg && <span className="text-xs opacity-60">{resultMsg}</span>}
        </div>

        {manualOpen && (
          <div className="border rounded p-3 flex flex-col gap-2 bg-neutral-50 dark:bg-neutral-900">
            <p className="text-xs opacity-60">
              Use this when auto-discovery can&apos;t find a company&apos;s career page on its own —
              paste the exact URL of its open-roles listing.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <input
                className="border rounded px-2 py-1 text-sm bg-transparent"
                placeholder="Company name"
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
              />
              <input
                className="border rounded px-2 py-1 text-sm bg-transparent"
                placeholder="https://company.com/careers"
                value={manualUrl}
                onChange={(e) => setManualUrl(e.target.value)}
              />
            </div>
            <button
              className="px-3 py-1.5 text-sm rounded bg-black text-white dark:bg-white dark:text-black w-fit"
              onClick={() => addWithCareerUrl.mutate()}
              disabled={addWithCareerUrl.isPending || !manualName.trim() || !manualUrl.trim()}
            >
              {addWithCareerUrl.isPending ? 'Adding...' : 'Add with This Career Page'}
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {companies?.map((c) => (
          <CompanyCard
            key={c.id}
            company={c}
            expanded={expanded === c.id}
            onToggleExpand={() => setExpanded(expanded === c.id ? null : c.id)}
          />
        ))}
        {companies?.length === 0 && (
          <p className="text-sm opacity-60">
            No companies yet — add one above, or add an Application on the Applications tab.
          </p>
        )}
      </div>
    </div>
  );
}

function CompanyCard({
  company,
  expanded,
  onToggleExpand,
}: {
  company: CompanyRow;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const queryClient = useQueryClient();
  const { openPanel } = useSessionsPanel();

  const { data: resume } = useQuery({
    queryKey: ['company-resume', company.resumeCompanyKey],
    queryFn: () => api.getCompanyResume(company.resumeCompanyKey),
    enabled: expanded && company.hasResume,
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

  const startSession = useMutation({
    mutationFn: () => api.startCompanySession(company.name),
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      openPanel(session.id);
    },
  });

  return (
    <div className="border rounded">
      <div className="flex items-center justify-between px-4 py-3 gap-3">
        <button
          className="flex-1 text-left min-w-0"
          onClick={onToggleExpand}
          disabled={!company.hasResume}
        >
          <div className="font-medium text-sm hover:underline truncate">{company.name}</div>
          <div className="flex items-center gap-2 text-xs opacity-60 mt-0.5">
            <StatusBadge status={company.discoveryStatus} />
            <span>{company._count?.roles ?? 0} open roles found</span>
          </div>
        </button>
        <div className="flex items-center gap-2 shrink-0">
          {company.resumeUpdatedAt && (
            <span className="text-xs opacity-60">
              Resume: {new Date(company.resumeUpdatedAt).toLocaleDateString()}
            </span>
          )}
          <button
            className="px-2 py-1 text-xs rounded border"
            onClick={() => startSession.mutate()}
            disabled={startSession.isPending}
          >
            {startSession.isPending ? 'Starting...' : company.hasResume ? 'Regenerate' : 'Generate Resume'}
          </button>
          {company.hasResume && (
            <a
              href={`${API_BASE}/company-resumes/${encodeURIComponent(company.resumeCompanyKey)}/resume.pdf`}
              className="px-2 py-1 text-xs rounded border"
            >
              Download PDF
            </a>
          )}
          <button
            className="px-2 py-1 text-xs rounded border"
            onClick={() => rediscover.mutate(company.id)}
            disabled={company.discoveryStatus === 'DISCOVERING'}
          >
            Re-scan
          </button>
          <button
            className="px-2 py-1 text-xs rounded border text-red-600 dark:text-red-400"
            onClick={() => {
              if (confirm(`Stop tracking ${company.name}? Its unselected open roles will be removed.`)) {
                removeCompany.mutate(company.id);
              }
            }}
          >
            Remove
          </button>
        </div>
      </div>
      {expanded && resume && (
        <pre className="text-sm whitespace-pre-wrap border-t p-3">{resume.resumeContent}</pre>
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
