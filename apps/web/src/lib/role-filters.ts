import { useEffect, useState } from 'react';
import type { Application, DiscoveredRole, ResumeProfile } from '@job-tracker/shared-types';

/** Page-local filter toggles (location / experience) aren't saved server-side;
 * persisting them in localStorage lets the referral picker mirror whatever
 * the Applications page currently has switched on. */
export const LOCATION_FILTER_KEY = 'roleFilter.location';
export const EXPERIENCE_FILTER_KEY = 'roleFilter.experience';

export const COMPANY_FILTER_KEY = 'roleFilter.company';
export const CANADA_REMOTE_KEY = 'roleFilter.canadaRemote';

/** Roles whose remote eligibility is restricted to Canada. */
export function isCanadaRemote(role: DiscoveredRole): boolean {
  return !!role.roleIsRemote && role.roleCountry?.trim().toLowerCase() === 'canada';
}

/** The "Canada remote" option only makes sense for a US-based candidate who is
 * already open to US remote roles. */
export function canAllowCanadaRemote(profile: ResumeProfile | undefined): boolean {
  return !!profile?.openToRemote && profile.locationCountry === 'US';
}
export const HIDE_DUPLICATE_TITLE_KEY = 'roleFilter.hideDuplicateTitle';

/** True when the user already has an application at the same company with the
 * same title (ignoring the " — locations" suffix) as this open role. Companies
 * often post one title as several requisitions (different IDs/locations), so a
 * URL match can't catch these — they're hidden from the open list instead. */
export function hasApplicationWithSameTitle(role: DiscoveredRole, applications: Application[]): boolean {
  const title = role.title.split(' — ')[0].trim().toLowerCase();
  const company = role.company.name.trim().toLowerCase();
  return applications.some(
    (a) => !!a.role && a.company.trim().toLowerCase() === company && a.role.trim().toLowerCase() === title,
  );
}

/** Same idea as usePersistedToggle, for a text filter. */
export function usePersistedString(key: string, initial = ''): [string, (value: string) => void] {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) setValue(stored);
    } catch {
      /* storage unavailable — keep the default */
    }
  }, [key]);
  const set = (next: string) => {
    setValue(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      /* ignore */
    }
  };
  return [value, set];
}

/** True when the company name contains any of the comma-separated terms
 * (case-insensitive). Empty text = no filter. */
export function matchesCompanyFilter(company: string, text: string): boolean {
  const terms = text
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return terms.length === 0 || terms.some((t) => company.toLowerCase().includes(t));
}

export function usePersistedToggle(key: string, initial: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) setValue(stored === '1');
    } catch {
      /* storage unavailable — keep the default */
    }
  }, [key]);
  const set = (next: boolean) => {
    setValue(next);
    try {
      localStorage.setItem(key, next ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  return [value, set];
}

// Open-roles filter rules, shared by the Applications page and the referral
// role picker so both show the same list.

/** A role passes the location filter if: it's remote AND the candidate's
 * profile has openToRemote set (remote is always shown only when the user
 * has actually opted into remote roles, not unconditionally), or its
 * country/state match the candidate's profile location, or the role's
 * location couldn't be determined at all (never hide a role just because
 * scoring hasn't run/found a location signal yet — that's not the same as
 * "doesn't match"). */
export function matchesLocationFilter(
  role: DiscoveredRole,
  profile: ResumeProfile | undefined,
  allowCanadaRemote = false,
): boolean {
  // For a US-based, remote-open candidate, Canada-only remote roles are in or
  // out as a group, per the "Canada remote" checkbox.
  if (canAllowCanadaRemote(profile) && isCanadaRemote(role)) return allowCanadaRemote;
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
export function matchesExperienceFilter(role: DiscoveredRole, profile: ResumeProfile | undefined): boolean {
  if (profile?.maxYearsExperience == null) return true; // no profile cap set — filter is a no-op
  if (role.roleMinYearsExperience === null) return true; // unknown requirement
  return role.roleMinYearsExperience <= profile.maxYearsExperience;
}

/** Why a role fails a hard disqualifying condition — a literal 0% score
 * (also what Discard sets), a location or experience mismatch, or the JD
 * containing one of the candidate's disqualifierKeywords. Empty when none
 * apply. When any apply, the role's numeric score isn't a meaningful match
 * signal and shouldn't be shown as one. */
export function invalidConditionReasons(
  role: DiscoveredRole,
  profile: ResumeProfile | undefined,
  allowCanadaRemote = false,
): string[] {
  const reasons: string[] = [];
  if (role.atsScore === 0) reasons.push('scored 0% (or was discarded)');
  const canadaRemoteAllowed = allowCanadaRemote && canAllowCanadaRemote(profile) && isCanadaRemote(role);
  if (role.locationMismatch && !canadaRemoteAllowed) {
    const where = [role.roleCity, role.roleState, role.roleCountry].filter(Boolean).join(', ');
    reasons.push(
      role.roleIsRemote
        ? `remote only for ${where || 'a region'} you're not in, or you're not open to remote`
        : `location${where ? ` (${where})` : ''} is outside your location preferences`,
    );
  }
  if (role.experienceMismatch) {
    reasons.push(
      `requires ${role.roleMinYearsExperience ?? '?'}+ yrs, above your max of ${profile?.maxYearsExperience ?? '?'}`,
    );
  }
  const jdLower = role.jdText?.toLowerCase() ?? '';
  const hits = (profile?.disqualifierKeywords ?? []).filter((k) => k.trim() && jdLower.includes(k.trim().toLowerCase()));
  if (hits.length > 0) reasons.push(`JD mentions disqualifier keyword${hits.length > 1 ? 's' : ''}: ${hits.join(', ')}`);
  return reasons;
}

export function hasInvalidCondition(
  role: DiscoveredRole,
  profile: ResumeProfile | undefined,
  allowCanadaRemote = false,
): boolean {
  return invalidConditionReasons(role, profile, allowCanadaRemote).length > 0;
}

/** True when none of the user-entered exclude keywords (e.g. "Software
 * Engineer", "UX Researcher") appear in the role's TITLE — matched as
 * substrings, case-insensitive. Deliberately title-only, not the JD body:
 * broad single words like "Engineer" or "India" are common filler in almost
 * any job description's prose, so matching against the full JD text would
 * false-positive on unrelated roles (e.g. a PM posting that happens to
 * mention "collaborate with engineers"). The title is short and specific
 * enough that a substring match there reliably means "this role is that". */
export function matchesExcludeKeywordsFilter(role: DiscoveredRole, keywords: string[]): boolean {
  if (keywords.length === 0) return true;
  const title = role.title.toLowerCase();
  return !keywords.some((k) => k.trim() && title.includes(k.trim().toLowerCase()));
}

/** True when the role mentions at least one of the user's location terms
 * (comma-separated, case-insensitive) in its title or extracted location —
 * the title carries the listed locations for roles scanned or scored since
 * that was added, the extracted fields cover the rest. Empty text = no filter.
 * A role with no location information at all (nothing extracted, not remote,
 * and no " — location" suffix in its title) always passes: unknown isn't a
 * mismatch, same rule as the other location filter. */
export function matchesLocationTextFilter(role: DiscoveredRole, text: string): boolean {
  const terms = text
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (terms.length === 0) return true;
  const hasNoLocation =
    !role.roleCity && !role.roleState && !role.roleCountry && !role.roleIsRemote && !role.title.includes(' — ');
  if (hasNoLocation) return true;
  const haystack = [role.title, role.roleCity, role.roleState, role.roleCountry, role.roleIsRemote ? 'remote' : '']
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return terms.some((t) => haystack.includes(t));
}

/** A role's "posted date" for filtering purposes: its real postedDate when
 * known, otherwise the date it was first discovered/pulled (createdAt) —
 * a role with no extracted posting date still has to sit somewhere on a
 * before/after-today cutoff, and the pull date is the best available proxy. */
export function effectivePostedDate(role: DiscoveredRole): string {
  return role.postedDate ?? role.createdAt;
}

/** True when dateStr falls before the cutoff (today minus daysBack, at
 * midnight) — daysBack=0 means "before today" (keep only roles posted
 * today or later), daysBack=3 means "before 3 days ago" (keep roles posted
 * in the last 3 days). */
export function isBeforeCutoff(dateStr: string, daysBack: number): boolean {
  const date = new Date(dateStr);
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - daysBack);
  return date < cutoff;
}
