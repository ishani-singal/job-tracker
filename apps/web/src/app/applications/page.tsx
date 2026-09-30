'use client';

import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { AddApplicationDialog } from '@/components/add-application-dialog';
import { ApplicationRow } from '@/components/application-row';
import type { DiscoveredRole, ResumeProfile } from '@job-tracker/shared-types';

/** A role passes the location filter if: it's remote AND the candidate's
 * profile has openToRemote set (remote is always shown only when the user
 * has actually opted into remote roles, not unconditionally), or its
 * country/state match the candidate's profile location, or the role's
 * location couldn't be determined at all (never hide a role just because
 * scoring hasn't run/found a location signal yet — that's not the same as
 * "doesn't match"). */
function matchesLocationFilter(role: DiscoveredRole, profile: ResumeProfile | undefined): boolean {
  if (role.roleIsRemote && profile?.openToRemote) return true;
  if (!profile?.locationCountry) return true; // no profile location set — filter is a no-op
  if (role.roleCountry === null && role.roleState === null) return true; // unknown location
  if (role.roleCountry !== profile.locationCountry) return false;
  if (profile.locationState && role.roleState && role.roleState !== profile.locationState) return false;
  return true;
}

/** A role passes the experience filter if the JD's required minimum years
 * is AT OR BELOW the candidate's profile maxYearsExperience — a role that
 * wants more years than the candidate has is filtered out; a role wanting
 * fewer is always shown (a senior candidate can apply to a junior-friendly
 * role). Roles with no extracted experience signal are never hidden, same
 * "unknown isn't a mismatch" rule as the location filter. */
function matchesExperienceFilter(role: DiscoveredRole, profile: ResumeProfile | undefined): boolean {
  if (profile?.maxYearsExperience == null) return true; // no profile cap set — filter is a no-op
  if (role.roleMinYearsExperience === null) return true; // unknown requirement
  return role.roleMinYearsExperience <= profile.maxYearsExperience;
}

function AtsScoreBadge({ score }: { score: number | null }) {
  if (score === null) return <span className="text-xs opacity-40">Scoring...</span>;
  const color =
    score >= 75 ? 'text-green-600' : score >= 50 ? 'text-amber-600' : 'text-red-600';
  return <span className={`text-xs font-medium ${color}`}>{score}% match</span>;
}

function RoleLocation({ role }: { role: DiscoveredRole }) {
  const parts = [role.roleCity, role.roleState, role.roleCountry].filter(Boolean);
  const label = role.roleIsRemote ? (parts.length ? `Remote (${parts.join(', ')})` : 'Remote') : parts.join(', ');
  if (!label && role.locationMismatch === null) return null;
  return (
    <span className={`text-xs ${role.locationMismatch ? 'text-red-600' : 'opacity-60'}`}>
      {label || 'Location unknown'}
      {role.locationMismatch ? ' · outside your location preferences' : ''}
    </span>
  );
}

function RoleExperience({ role }: { role: DiscoveredRole }) {
  if (role.roleMinYearsExperience === null) return null;
  return (
    <span className={`text-xs ${role.experienceMismatch ? 'text-red-600' : 'opacity-60'}`}>
      {role.roleMinYearsExperience}+ yrs
      {role.experienceMismatch ? ' · above your experience range' : ''}
    </span>
  );
}

export default function ApplicationsPage() {
  const queryClient = useQueryClient();
  const [locationFilterOn, setLocationFilterOn] = useState(true);
  const [experienceFilterOn, setExperienceFilterOn] = useState(true);
  const { data: applications, isLoading } = useQuery({
    queryKey: ['applications'],
    queryFn: api.listApplications,
  });
  const { data: profile } = useQuery({
    queryKey: ['profile'],
    queryFn: api.getProfile,
  });
  const { data: unselectedRolesRaw } = useQuery({
    queryKey: ['discovered-roles', 'unselected'],
    queryFn: () => api.listDiscoveredRoles('unselected'),
    refetchInterval: (query) => {
      const anyUnscored = query.state.data?.some((r) => r.atsScore === null);
      return anyUnscored ? 4000 : false;
    },
  });
  const unselectedRoles = unselectedRolesRaw?.filter(
    (r) =>
      (!locationFilterOn || matchesLocationFilter(r, profile)) &&
      (!experienceFilterOn || matchesExperienceFilter(r, profile)),
  );
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
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-sm font-medium opacity-70">
              Open Roles ({unselectedRoles?.length ?? 0}
              {unselectedRolesRaw && unselectedRolesRaw.length !== unselectedRoles?.length
                ? ` of ${unselectedRolesRaw.length}`
                : ''}
              )
            </h2>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs opacity-70 cursor-pointer">
                <input
                  type="checkbox"
                  checked={locationFilterOn}
                  onChange={(e) => setLocationFilterOn(e.target.checked)}
                />
                {profile?.locationCountry
                  ? `Filter to ${[profile.locationState, profile.locationCountry].filter(Boolean).join(', ')}${profile.openToRemote ? ' + remote' : ''}`
                  : 'Filter to my location'}
              </label>
              <label className="flex items-center gap-1.5 text-xs opacity-70 cursor-pointer">
                <input
                  type="checkbox"
                  checked={experienceFilterOn}
                  onChange={(e) => setExperienceFilterOn(e.target.checked)}
                />
                {profile?.maxYearsExperience != null
                  ? `Filter to ≤${profile.maxYearsExperience} yrs experience`
                  : 'Filter to my experience'}
              </label>
            </div>
          </div>
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
        <RoleLocation role={role} />
        <RoleExperience role={role} />
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
