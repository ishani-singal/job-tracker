'use client';

import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { AddApplicationDialog } from '@/components/add-application-dialog';
import { ApplicationRow } from '@/components/application-row';
import {
  HIDE_DUPLICATE_TITLE_KEY,
  hasApplicationWithSameTitle,
  COMPANY_FILTER_KEY,
  matchesCompanyFilter,
  usePersistedString,
  EXPERIENCE_FILTER_KEY,
  LOCATION_FILTER_KEY,
  usePersistedToggle,
  effectivePostedDate,
  hasInvalidCondition,
  invalidConditionReasons,
  isBeforeCutoff,
  matchesExcludeKeywordsFilter,
  matchesExperienceFilter,
  matchesLocationFilter,
  matchesLocationTextFilter,
} from '@/lib/role-filters';
import type { Application, AppSettings, DiscoveredRole, ResumeProfile } from '@job-tracker/shared-types';

function AtsScoreBadge({
  score,
  invalidReasons,
}: {
  score: number | null;
  invalidReasons?: string[];
}) {
  if (invalidReasons && invalidReasons.length > 0) {
    return (
      <span className="text-xs font-medium text-red-600">
        Conditions not valid: {invalidReasons.join('; ')}
      </span>
    );
  }
  if (score === null) return <span className="text-xs opacity-40">Not scored</span>;
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
  const [locationFilterOn, setLocationFilterOn] = usePersistedToggle(LOCATION_FILTER_KEY, true);
  const [experienceFilterOn, setExperienceFilterOn] = usePersistedToggle(EXPERIENCE_FILTER_KEY, true);
  const [companyFilter, setCompanyFilter] = usePersistedString(COMPANY_FILTER_KEY);
  const [hideDuplicateTitleOn, setHideDuplicateTitleOn] = usePersistedToggle(HIDE_DUPLICATE_TITLE_KEY, true);
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  // Both filters below are persisted server-side (AppSettings) so they
  // survive a page reload — initialized from settings once loaded, then
  // held as local state so typing/toggling feels instant, with the save
  // to the server happening alongside.
  const [minScoreFilter, setMinScoreFilter] = useState('');
  const [minScoreFilterInitialized, setMinScoreFilterInitialized] = useState(false);
  const [postedBeforeTodayFilterOn, setPostedBeforeTodayFilterOn] = useState(false);
  const [postedWithinDaysFilter, setPostedWithinDaysFilter] = useState('0');
  const [hideInvalidConditionRolesFilterOn, setHideInvalidConditionRolesFilterOn] = useState(false);
  const [excludeKeywordsFilter, setExcludeKeywordsFilter] = useState('');
  const [locationTextFilter, setLocationTextFilter] = useState('');
  if (settings && !minScoreFilterInitialized) {
    setMinScoreFilter(settings.minMatchScoreFilter != null ? String(settings.minMatchScoreFilter) : '');
    setPostedBeforeTodayFilterOn(settings.postedBeforeTodayFilterOn);
    setPostedWithinDaysFilter(String(settings.postedWithinDaysFilter));
    setHideInvalidConditionRolesFilterOn(settings.hideInvalidConditionRolesFilterOn);
    setExcludeKeywordsFilter(settings.excludeKeywordsFilter);
    setLocationTextFilter(settings.locationTextFilter ?? '');
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

  function handlePostedWithinDaysFilterChange(value: string) {
    setPostedWithinDaysFilter(value);
    const days = Number(value);
    if (value !== '' && !Number.isNaN(days) && days >= 0) {
      updateSettings.mutate({ postedWithinDaysFilter: days });
    }
  }

  const postedWithinDays = Math.max(0, Number(postedWithinDaysFilter) || 0);

  function handleHideInvalidConditionRolesFilterChange(checked: boolean) {
    setHideInvalidConditionRolesFilterOn(checked);
    updateSettings.mutate({ hideInvalidConditionRolesFilterOn: checked });
  }

  function handleExcludeKeywordsFilterChange(value: string) {
    setExcludeKeywordsFilter(value);
    updateSettings.mutate({ excludeKeywordsFilter: value });
  }

  function handleLocationTextFilterChange(value: string) {
    setLocationTextFilter(value);
    updateSettings.mutate({ locationTextFilter: value });
  }

  const excludeKeywords = excludeKeywordsFilter
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

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
  });
  const minScore = minScoreFilter === '' ? null : Number(minScoreFilter);
  const unselectedRoles = unselectedRolesRaw?.filter(
    (r) =>
      (minScore === null || r.atsScore === null || r.atsScore >= minScore) &&
      (!postedBeforeTodayFilterOn || !isBeforeCutoff(effectivePostedDate(r), postedWithinDays)) &&
      (!hideInvalidConditionRolesFilterOn || !hasInvalidCondition(r, profile)) &&
      (!locationFilterOn || matchesLocationFilter(r, profile)) &&
      (!experienceFilterOn || matchesExperienceFilter(r, profile)) &&
      matchesExcludeKeywordsFilter(r, excludeKeywords) &&
      matchesLocationTextFilter(r, locationTextFilter) &&
      matchesCompanyFilter(r.company.name, companyFilter) &&
      (!hideDuplicateTitleOn || !hasApplicationWithSameTitle(r, applications ?? [])),
  );
  const { data: selectedRolesRaw } = useQuery({
    queryKey: ['discovered-roles', 'selected'],
    queryFn: () => api.listDiscoveredRoles('selected'),
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
  const roleByApplicationId = new Map(
    (selectedRolesRaw ?? [])
      .filter((r) => r.applicationId)
      .map((r) => [r.applicationId as string, r]),
  );
  const roleIdByApplicationId = new Map(
    (selectedRolesRaw ?? [])
      .filter((r) => r.applicationId)
      .map((r) => [r.applicationId as string, r.id]),
  );
  const hiddenApplicationIds = new Set(
    postedBeforeTodayFilterOn
      ? (selectedRolesRaw ?? [])
          .filter((r) => r.applicationId && isBeforeCutoff(effectivePostedDate(r), postedWithinDays))
          .map((r) => r.applicationId as string)
      : [],
  );
  const visibleApplications = (applications ?? []).filter(
    (app) => !hiddenApplicationIds.has(app.id) && matchesCompanyFilter(app.company, companyFilter),
  );
  const companyNames = [
    ...new Set([...(applications ?? []).map((a) => a.company), ...(unselectedRolesRaw ?? []).map((r) => r.company.name)]),
  ].sort((a, b) => a.localeCompare(b));

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

  const rescoreRole = useMutation({
    mutationFn: (id: string) => api.rescoreRole(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['discovered-roles'] }),
  });

  const discardRole = useMutation({
    mutationFn: (id: string) => api.discardRole(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['discovered-roles'] }),
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

      <label className="flex items-center gap-1.5 text-xs opacity-70">
        Company
        <input
          type="text"
          list="company-filter-options"
          placeholder="e.g. Meta, Amazon (any of) — filters Open Roles and Selected"
          className="flex-1 min-w-0 border rounded px-1.5 py-0.5 bg-transparent"
          value={companyFilter}
          onChange={(e) => setCompanyFilter(e.target.value)}
        />
        <datalist id="company-filter-options">
          {companyNames.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        {companyFilter && (
          <button className="px-1.5 py-0.5 rounded border" onClick={() => setCompanyFilter('')}>
            Clear
          </button>
        )}
      </label>

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
                Hide roles posted before
                <input
                  type="number"
                  min={0}
                  className="w-10 border rounded px-1 py-0.5 bg-transparent"
                  value={postedWithinDaysFilter}
                  onChange={(e) => handlePostedWithinDaysFilterChange(e.target.value)}
                />
                days ago
              </label>
              <label className="flex items-center gap-1.5 text-xs opacity-70 cursor-pointer">
                <input
                  type="checkbox"
                  checked={hideInvalidConditionRolesFilterOn}
                  onChange={(e) => handleHideInvalidConditionRolesFilterChange(e.target.checked)}
                />
                Hide roles with invalid conditions
              </label>
              <label
                className="flex items-center gap-1.5 text-xs opacity-70 cursor-pointer"
                title="Hide open roles whose title matches an application you already have at that company"
              >
                <input
                  type="checkbox"
                  checked={hideDuplicateTitleOn}
                  onChange={(e) => setHideDuplicateTitleOn(e.target.checked)}
                />
                Hide titles I already have
              </label>
            </div>
          </div>
          <label className="flex items-center gap-1.5 text-xs opacity-70">
            Exclude keywords
            <input
              type="text"
              placeholder="e.g. Software Engineer, UX Researcher"
              className="flex-1 min-w-0 border rounded px-1.5 py-0.5 bg-transparent"
              value={excludeKeywordsFilter}
              onChange={(e) => handleExcludeKeywordsFilterChange(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs opacity-70">
            Location contains
            <input
              type="text"
              placeholder="e.g. Seattle, Remote, New York (any of)"
              className="flex-1 min-w-0 border rounded px-1.5 py-0.5 bg-transparent"
              value={locationTextFilter}
              onChange={(e) => handleLocationTextFilterChange(e.target.value)}
            />
          </label>
          <div className="flex flex-col gap-2">
            {unselectedRoles?.map((role) => (
              <DiscoveredRoleRow
                key={role.id}
                role={role}
                profile={profile}
                onSelect={() => selectRole.mutate(role.id)}
                selecting={selectRole.isPending}
                onScore={() => rescoreRole.mutate(role.id)}
                scoring={rescoreRole.isPending && rescoreRole.variables === role.id}
                onDiscard={() => discardRole.mutate(role.id)}
                discarding={discardRole.isPending && discardRole.variables === role.id}
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
                  {roleByApplicationId.has(app.id) && (
                    <div className="px-4">
                      <AtsScoreBadge
                        score={roleByApplicationId.get(app.id)?.atsScore ?? null}
                        invalidReasons={invalidConditionReasons(roleByApplicationId.get(app.id)!, profile)}
                      />
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
  profile,
  onSelect,
  selecting,
  onScore,
  scoring,
  onDiscard,
  discarding,
}: {
  role: DiscoveredRole;
  profile: ResumeProfile | undefined;
  onSelect: () => void;
  selecting: boolean;
  onScore: () => void;
  scoring: boolean;
  onDiscard: () => void;
  discarding: boolean;
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
        <AtsScoreBadge score={role.atsScore} invalidReasons={invalidConditionReasons(role, profile)} />
      </div>
      <div className="flex flex-col gap-1 shrink-0">
        <button
          className="px-2 py-1 text-xs rounded border"
          onClick={onScore}
          disabled={scoring}
        >
          {scoring ? 'Scoring...' : role.atsScore === null ? 'Score' : 'Rescore'}
        </button>
        <button
          className="px-2 py-1 text-xs rounded border"
          onClick={onSelect}
          disabled={selecting}
        >
          {selecting ? 'Selecting...' : 'Select to Apply'}
        </button>
        <button
          className="px-2 py-1 text-xs rounded border border-red-600 text-red-600 dark:text-red-400 dark:border-red-400"
          onClick={onDiscard}
          disabled={discarding}
        >
          {discarding ? 'Discarding...' : 'Discard'}
        </button>
      </div>
    </div>
  );
}
