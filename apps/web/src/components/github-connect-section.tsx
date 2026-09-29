'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

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

  async function toggleRepo(fullName: string, isConnected: boolean) {
    if (isConnected) {
      await api.disconnectRepo(fullName);
    } else {
      await api.connectRepo(fullName);
    }
    queryClient.invalidateQueries({ queryKey: ['github-connected-repos'] });
  }

  const connectedSet = new Set((connectedRepos ?? []).map((r) => r.fullName));

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">GitHub Repos</h2>
      <p className="text-xs opacity-60">
        Connect repos so the resume agent can pull real project descriptions from their
        READMEs as extra source material, alongside your uploaded Stories.
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

          <div className="flex flex-col gap-1 max-h-64 overflow-y-auto border rounded p-2">
            {availableRepos?.map((repo) => {
              const isConnected = connectedSet.has(repo.fullName);
              return (
                <label
                  key={repo.fullName}
                  className="flex items-center gap-2 text-sm py-1 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={isConnected}
                    onChange={() => toggleRepo(repo.fullName, isConnected)}
                  />
                  <span className="flex-1">{repo.fullName}</span>
                  {repo.private && <span className="text-xs opacity-50">private</span>}
                </label>
              );
            })}
            {availableRepos?.length === 0 && (
              <p className="text-xs opacity-60">No repos found on this account.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
