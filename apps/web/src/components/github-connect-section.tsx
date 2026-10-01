'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { StoryEntryType } from '@job-tracker/shared-types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

const BACKGROUND_TYPE_OPTIONS: { value: StoryEntryType; label: string }[] = [
  { value: 'WORK_EXPERIENCE', label: 'Work Experience' },
  { value: 'EDUCATION', label: 'Education' },
  { value: 'INTERNSHIP', label: 'Internship' },
  { value: 'PROJECT', label: 'Project' },
];

export function GithubConnectSection() {
  const queryClient = useQueryClient();
  const { data: connection } = useQuery({
    queryKey: ['github-connection'],
    queryFn: api.getGithubConnection,
  });
  const { data: connectedRepos } = useQuery({
    queryKey: ['github-connected-repos'],
    queryFn: api.listConnectedRepos,
    enabled: !!connection,
  });
  const { data: availableRepos } = useQuery({
    queryKey: ['github-available-repos'],
    queryFn: api.listAvailableRepos,
    enabled: !!connection,
  });

  async function handleDisconnectAccount() {
    if (!confirm('Disconnect GitHub? This also clears your connected repo selections.')) return;
    await api.disconnectGithub();
    queryClient.invalidateQueries({ queryKey: ['github-connection'] });
    queryClient.invalidateQueries({ queryKey: ['github-connected-repos'] });
  }

  async function disconnectRepo(fullName: string) {
    await api.disconnectRepo(fullName);
    queryClient.invalidateQueries({ queryKey: ['github-connected-repos'] });
  }

  const connectedSet = new Set((connectedRepos ?? []).map((r) => r.fullName));

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">GitHub Repos</h2>
      <p className="text-xs opacity-60">
        Connect a repo to a specific entry (almost always a Project) — resume generation
        reads that repo&apos;s README/metadata live for that entry only.
      </p>

      {!connection ? (
        <a
          href={`${API_BASE}/auth/github/start`}
          className="self-start px-3 py-1.5 text-sm rounded bg-black text-white dark:bg-white dark:text-black"
        >
          Connect GitHub
        </a>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between text-sm">
            <span>
              Connected as <span className="font-medium">{connection.githubLogin}</span>
            </span>
            <button
              className="px-2 py-1 text-xs rounded border text-red-600 dark:text-red-400"
              onClick={handleDisconnectAccount}
            >
              Disconnect
            </button>
          </div>

          {connectedRepos && connectedRepos.length > 0 && (
            <div className="flex flex-col gap-1">
              <h3 className="text-xs font-medium uppercase opacity-60">Connected</h3>
              {connectedRepos.map((r) => (
                <div key={r.fullName} className="flex items-center justify-between text-sm border rounded px-2 py-1">
                  <span>
                    {r.fullName}{' '}
                    <span className="text-xs opacity-60">
                      ({BACKGROUND_TYPE_OPTIONS.find((o) => o.value === r.entryType)?.label ?? r.entryType})
                    </span>
                  </span>
                  <button
                    className="text-xs text-red-600 dark:text-red-400"
                    onClick={() => disconnectRepo(r.fullName)}
                  >
                    Disconnect
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-1">
            <h3 className="text-xs font-medium uppercase opacity-60">Connect a repo</h3>
            <div className="flex flex-col gap-1 max-h-64 overflow-y-auto border rounded p-2">
              {availableRepos
                ?.filter((repo) => !connectedSet.has(repo.fullName))
                .map((repo) => <ConnectRepoRow key={repo.fullName} fullName={repo.fullName} isPrivate={repo.private} />)}
              {availableRepos?.filter((repo) => !connectedSet.has(repo.fullName)).length === 0 && (
                <p className="text-xs opacity-60">No more repos to connect.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** One not-yet-connected repo — picking a category + entry and clicking
 * Connect pins it, same two-step picker as the file-upload flow. */
function ConnectRepoRow({ fullName, isPrivate }: { fullName: string; isPrivate: boolean }) {
  const queryClient = useQueryClient();
  const [entryType, setEntryType] = useState<StoryEntryType | ''>('');
  const [entryId, setEntryId] = useState('');

  const { data: workExperience } = useQuery({
    queryKey: ['work-experience'],
    queryFn: api.listWorkExperience,
    enabled: entryType === 'WORK_EXPERIENCE',
  });
  const { data: education } = useQuery({
    queryKey: ['education'],
    queryFn: api.listEducation,
    enabled: entryType === 'EDUCATION',
  });
  const { data: internships } = useQuery({
    queryKey: ['internships'],
    queryFn: api.listInternships,
    enabled: entryType === 'INTERNSHIP',
  });
  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: api.listProjects,
    enabled: entryType === 'PROJECT',
  });

  const entryOptions: { id: string; label: string }[] =
    entryType === 'WORK_EXPERIENCE'
      ? (workExperience ?? []).map((e) => ({ id: e.id, label: `${e.company}${e.title ? ` — ${e.title}` : ''}` }))
      : entryType === 'EDUCATION'
        ? (education ?? []).map((e) => ({ id: e.id, label: e.school }))
        : entryType === 'INTERNSHIP'
          ? (internships ?? []).map((e) => ({ id: e.id, label: `${e.company}${e.title ? ` — ${e.title}` : ''}` }))
          : entryType === 'PROJECT'
            ? (projects ?? []).map((e) => ({ id: e.id, label: e.name }))
            : [];

  async function handleConnect() {
    if (!entryType || !entryId) return;
    await api.connectRepo(fullName, entryType, entryId);
    setEntryType('');
    setEntryId('');
    queryClient.invalidateQueries({ queryKey: ['github-connected-repos'] });
  }

  return (
    <div className="flex items-center gap-2 text-sm py-1">
      <span className="flex-1">{fullName}</span>
      {isPrivate && <span className="text-xs opacity-50">private</span>}
      <select
        className="border rounded px-1 py-0.5 text-xs bg-transparent"
        value={entryType}
        onChange={(e) => {
          setEntryType(e.target.value as StoryEntryType | '');
          setEntryId('');
        }}
      >
        <option value="">Category...</option>
        {BACKGROUND_TYPE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <select
        className="border rounded px-1 py-0.5 text-xs bg-transparent"
        value={entryId}
        onChange={(e) => setEntryId(e.target.value)}
        disabled={!entryType}
      >
        <option value="">Which one...</option>
        {entryOptions.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        className="px-2 py-0.5 text-xs rounded border"
        onClick={handleConnect}
        disabled={!entryType || !entryId}
      >
        Connect
      </button>
    </div>
  );
}
