'use client';

import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { AddApplicationDialog } from '@/components/add-application-dialog';
import { ApplicationRow } from '@/components/application-row';
import type { DiscoveredRole } from '@job-tracker/shared-types';

function AtsScoreBadge({ score }: { score: number | null }) {
  if (score === null) return <span className="text-xs opacity-40">Scoring...</span>;
  const color =
    score >= 75 ? 'text-green-600' : score >= 50 ? 'text-amber-600' : 'text-red-600';
  return <span className={`text-xs font-medium ${color}`}>{score}% match</span>;
}

export default function ApplicationsPage() {
  const queryClient = useQueryClient();
  const { data: applications, isLoading } = useQuery({
    queryKey: ['applications'],
    queryFn: api.listApplications,
  });
  const { data: unselectedRoles } = useQuery({
    queryKey: ['discovered-roles', 'unselected'],
    queryFn: () => api.listDiscoveredRoles('unselected'),
    refetchInterval: (query) => {
      const anyUnscored = query.state.data?.some((r) => r.atsScore === null);
      return anyUnscored ? 4000 : false;
    },
  });
  const { data: selectedRoles } = useQuery({
    queryKey: ['discovered-roles', 'selected'],
    queryFn: () => api.listDiscoveredRoles('selected'),
    refetchInterval: (query) => {
      const anyUnscored = query.state.data?.some((r) => r.atsScore === null);
      return anyUnscored ? 4000 : false;
    },
  });

  const scoreByApplicationId = new Map(
    (selectedRoles ?? [])
      .filter((r) => r.applicationId)
      .map((r) => [r.applicationId as string, r.atsScore]),
  );
  const roleIdByApplicationId = new Map(
    (selectedRoles ?? [])
      .filter((r) => r.applicationId)
      .map((r) => [r.applicationId as string, r.id]),
  );

  const selectRole = useMutation({
    mutationFn: (id: string) => api.selectRole(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['discovered-roles'] });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
    },
  });

  const unselectRole = useMutation({
    mutationFn: (id: string) => api.unselectRole(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['discovered-roles'] });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
    },
  });

  return (
    <div className="max-w-7xl mx-auto flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Applications</h1>
        <AddApplicationDialog
          onSaved={() => queryClient.invalidateQueries({ queryKey: ['applications'] })}
        />
      </div>

      {isLoading && <p className="text-sm opacity-60">Loading...</p>}

      <div className="grid grid-cols-2 gap-6">
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium opacity-70">
            Open Roles ({unselectedRoles?.length ?? 0})
          </h2>
          <div className="flex flex-col gap-2">
            {unselectedRoles?.map((role) => (
              <DiscoveredRoleRow
                key={role.id}
                role={role}
                onSelect={() => selectRole.mutate(role.id)}
                selecting={selectRole.isPending}
              />
            ))}
            {unselectedRoles?.length === 0 && (
              <p className="text-sm opacity-50">
                No open roles yet — track companies on the Company Resumes tab.
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium opacity-70">
            Selected ({applications?.length ?? 0})
          </h2>
          <div className="flex flex-col gap-2">
            {applications?.map((app) => {
              const roleId = roleIdByApplicationId.get(app.id);
              return (
                <div key={app.id} className="flex flex-col gap-1">
                  <ApplicationRow
                    application={app}
                    onUnselect={roleId ? () => unselectRole.mutate(roleId) : undefined}
                    unselecting={unselectRole.isPending}
                  />
                  {scoreByApplicationId.has(app.id) && (
                    <div className="px-4">
                      <AtsScoreBadge score={scoreByApplicationId.get(app.id) ?? null} />
                    </div>
                  )}
                </div>
              );
            })}
            {applications?.length === 0 && (
              <p className="text-sm opacity-60">
                No applications yet — add one above or select a role on the left.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DiscoveredRoleRow({
  role,
  onSelect,
  selecting,
}: {
  role: DiscoveredRole;
  onSelect: () => void;
  selecting: boolean;
}) {
  return (
    <div className="border rounded px-4 py-3 text-sm flex items-center justify-between gap-3">
      <div className="flex flex-col gap-0.5 min-w-0">
        <a
          href={role.roleUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium hover:underline truncate"
        >
          {role.company.name} — {role.title}
        </a>
        <span className="text-xs opacity-60">
          {role.postedDate
            ? `Posted ${new Date(role.postedDate).toLocaleDateString()}`
            : 'Posted date unknown'}
        </span>
        <AtsScoreBadge score={role.atsScore} />
      </div>
      <button
        className="px-2 py-1 text-xs rounded border shrink-0"
        onClick={onSelect}
        disabled={selecting}
      >
        {selecting ? 'Selecting...' : 'Select to Apply'}
      </button>
    </div>
  );
}
