import { useEffect, useState } from 'react';
import type { DiscoveredRole, ResumeProfile } from '@job-tracker/shared-types';

/** Page-local filter toggles (location / experience) aren't saved server-side;
 * persisting them in localStorage lets the referral picker mirror whatever
 * the Applications page currently has switched on. */
export const LOCATION_FILTER_KEY = 'roleFilter.location';
export const EXPERIENCE_FILTER_KEY = 'roleFilter.experience';

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
export function matchesLocationFilter(role: DiscoveredRole, profile: ResumeProfile | undefined): boolean {
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

/** True when a role fails a hard disqualifying condition — a literal 0%
 * score, a location or experience mismatch, or the JD containing one of the
 * candidate's disqualifierKeywords — in which case its numeric score isn't
 * a meaningful match signal and shouldn't be shown as one. */
export function hasInvalidCondition(role: DiscoveredRole, profile: ResumeProfile | undefined): boolean {
  if (role.atsScore === 0) return true;
  if (role.locationMismatch) return true;
  if (role.experienceMismatch) return true;
  const keywords = profile?.disqualifierKeywords ?? [];
  if (keywords.length > 0 && role.jdText) {
    const jdLower = role.jdText.toLowerCase();
    if (keywords.some((k) => k.trim() && jdLower.includes(k.trim().toLowerCase()))) return true;
  }
  return false;
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
