'use client';

import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { AddApplicationDialog } from '@/components/add-application-dialog';
import { ApplicationRow } from '@/components/application-row';
import type { Application, AppSettings, DiscoveredRole, ResumeProfile } from '@job-tracker/shared-types';

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

/** A role's "posted date" for filtering purposes: its real postedDate when
 * known, otherwise the date it was first discovered/pulled (createdAt) —
 * a role with no extracted posting date still has to sit somewhere on a
 * before/after-today cutoff, and the pull date is the best available proxy. */
function effectivePostedDate(role: DiscoveredRole): string {
  return role.postedDate ?? role.createdAt;
}

function isBeforeToday(dateStr: string): boolean {
  const date = new Date(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date < today;
}

export default function ApplicationsPage() {
  const queryClient = useQueryClient();
  const [locationFilterOn, setLocationFilterOn] = useState(true);
  const [experienceFilterOn, setExperienceFilterOn] = useState(true);
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  // Both filters below are persisted server-side (AppSettings) so they
  // survive a page reload — initialized from settings once loaded, then
  // held as local state so typing/toggling feels instant, with the save
  // to the server happening alongside.
  const [minScoreFilter, setMinScoreFilter] = useState('');
  const [minScoreFilterInitialized, setMinScoreFilterInitialized] = useState(false);
  const [postedBeforeTodayFilterOn, setPostedBeforeTodayFilterOn] = useState(false);
  if (settings && !minScoreFilterInitialized) {
    setMinScoreFilter(settings.minMatchScoreFilter != null ? String(settings.minMatchScoreFilter) : '');
    setPostedBeforeTodayFilterOn(settings.postedBeforeTodayFilterOn);
    setMinScoreFilterInitialized(true);
  }

  const updateSettings = useMutation({
    mutationFn: (data: Partial<AppSettings>) => api.updateSettings(data),
    onSuccess: (updated) => queryClient.setQueryData(['settings'], updated),
  });

  function handleMinScoreFilterChange(value: string) {
    setMinScoreFilter(value);
    updateSettings.mutate({ minMatchScoreFilter: value === '' ? null : Number(value) });
  }

  function handlePostedBeforeTodayFilterChange(checked: boolean) {
    setPostedBeforeTodayFilterOn(checked);
    updateSettings.mutate({ postedBeforeTodayFilterOn: checked });
  }

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
  const minScore = minScoreFilter === '' ? null : Number(minScoreFilter);
  const unselectedRoles = unselectedRolesRaw?.filter(
    (r) =>
      (minScore === null || r.atsScore === null || r.atsScore === 0 || r.atsScore >= minScore) &&
      (!postedBeforeTodayFilterOn || !isBeforeToday(effectivePostedDate(r))) &&
      (!locationFilterOn || matchesLocationFilter(r, profile)) &&
      (!experienceFilterOn || matchesExperienceFilter(r, profile)),
  );
  const { data: selectedRolesRaw } = useQuery({
    queryKey: ['discovered-roles', 'selected'],
    queryFn: () => api.listDiscoveredRoles('selected'),
    refetchInterval: (query) => {
      const anyUnscored = query.state.data?.some((r) => r.atsScore === null);
      return anyUnscored ? 4000 : false;
    },
  });
  // scoreByApplicationId/roleIdByApplicationId are built from the
  // UNFILTERED selected roles — unselect and the score badge must keep
  // working for an application even while it's hidden by the date filter
  // below. hiddenApplicationIds is the separate set actually used to filter
  // the rendered list (per explicit request — unlike the min-score filter,
  // which only applies to Open Roles, "posted before today" applies to
  // Selected too, treated as a staleness signal). A directly-added
  // application (no linked DiscoveredRole at all) has no date signal to
  // filter on, so it's never hidden by this filter.
  const scoreByApplicationId = new Map(
    (selectedRolesRaw ?? [])
      .filter((r) => r.applicationId)
      .map((r) => [r.applicationId as string, r.atsScore]),
  );
  const roleIdByApplicationId = new Map(
    (selectedRolesRaw ?? [])
      .filter((r) => r.applicationId)
      .map((r) => [r.applicationId as string, r.id]),
  );
  const hiddenApplicationIds = new Set(
    postedBeforeTodayFilterOn
      ? (selectedRolesRaw ?? [])
          .filter((r) => r.applicationId && isBeforeToday(effectivePostedDate(r)))
          .map((r) => r.applicationId as string)
      : [],
  );
  const visibleApplications = (applications ?? []).filter((app) => !hiddenApplicationIds.has(app.id));

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

  // Applications added directly (via AddApplicationDialog) have no backing
  // DiscoveredRole to detach — "unselect" for these just removes them from
  // Selected the same way Delete does.
  const unselectDirectlyAddedApplication = useMutation({
    mutationFn: (id: string) => api.deleteApplication(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applications'] });
    },
  });

  function unselectDirectlyAdded(app: Application) {
    if (confirm(`Unselect ${app.company}${app.role ? ` — ${app.role}` : ''}? This removes it from Selected.`)) {
      unselectDirectlyAddedApplication.mutate(app.id);
    }
  }

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
              <label className="flex items-center gap-1.5 text-xs opacity-70">
                Min match score
                <input
                  type="number"
                  min={0}
                  max={100}
                  placeholder="off"
                  className="w-14 border rounded px-1 py-0.5 bg-transparent"
                  value={minScoreFilter}
                  onChange={(e) => handleMinScoreFilterChange(e.target.value)}
                />
                %
              </label>
              <label className="flex items-center gap-1.5 text-xs opacity-70 cursor-pointer">
                <input
                  type="checkbox"
                  checked={postedBeforeTodayFilterOn}
                  onChange={(e) => handlePostedBeforeTodayFilterChange(e.target.checked)}
                />
                Hide roles posted before today
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
            Selected ({visibleApplications.length}
            {applications && applications.length !== visibleApplications.length
              ? ` of ${applications.length}`
              : ''}
            )
          </h2>
          <div className="flex flex-col gap-2">
            {visibleApplications.map((app) => {
              const roleId = roleIdByApplicationId.get(app.id);
              return (
                <div key={app.id} className="flex flex-col gap-1">
                  <ApplicationRow
                    application={app}
                    onUnselect={
                      roleId ? () => unselectRole.mutate(roleId) : () => unselectDirectlyAdded(app)
                    }
                    unselecting={
                      roleId ? unselectRole.isPending : unselectDirectlyAddedApplication.isPending
                    }
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
            {applications && applications.length > 0 && visibleApplications.length === 0 && (
              <p className="text-sm opacity-60">All selected applications are hidden by the current filters.</p>
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
