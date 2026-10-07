import type { StructuredResume } from '@job-tracker/shared-types';
import type { PrismaService } from '../prisma/prisma.service';
import { isPlainEntry } from './structured-resume-pdf';

const norm = (s?: string | null) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

interface Bound {
  kind: 'work' | 'intern' | 'project';
  key: string;
  title: string;
  max: number;
  min: number | null;
}

/**
 * Safety net for the per-entry bullet ceilings set on the Resume tab
 * (maxBullets): the model is told them as hard limits but still overshoots
 * (e.g. 4 bullets on a 1-bullet internship), so before a generated resume is
 * saved, any entry over its own max is cut to it, keeping the first bullets
 * (the agent puts the strongest first).
 *
 * Entries are matched to Resume-tab entries by company/project name. The same
 * company can appear twice (a full-time role AND an MBA internship at Dell), so
 * a name match alone is ambiguous: the entry's title (the resume subtitle may
 * add words, or be retitled) and an MBA/intern hint break the tie, and each
 * Resume-tab entry is used at most once. Entries with no bound are untouched.
 *
 * Also: an EDUCATION entry carries no bullets unless that education is currently
 * active (the Resume-tab entry's "present" flag; for an unmatched entry in an
 * education section, a dateRange that reads Present/Current).
 */
export interface BulletRuleOptions {
  /** Points the resume overflows one page by (0 when it fits). When given, bullets are removed —
   * as a LAST resort — until it reports 0: the least valuable first (later sections and entries
   * before earlier ones), never below an entry's own minimum (at least 1), never from education
   * or the Skills lines. Used when rendering, so a resume can never spill onto a second page. */
  overflowPoints?: (resume: StructuredResume) => number;
}

export async function enforceBulletBounds(
  prisma: PrismaService,
  resume: StructuredResume,
  options: BulletRuleOptions = {},
): Promise<StructuredResume> {
  const [work, interns, projects, education] = await Promise.all([
    prisma.workExperienceEntry.findMany({ select: { company: true, title: true, minBullets: true, maxBullets: true } }),
    prisma.internshipEntry.findMany({ select: { company: true, title: true, minBullets: true, maxBullets: true } }),
    prisma.projectEntry.findMany({ select: { name: true, minBullets: true, maxBullets: true } }),
    prisma.educationEntry.findMany({ select: { school: true, isPresent: true } }),
  ]);
  const schools = education
    .map((e) => ({ key: norm(e.school), active: e.isPresent }))
    .filter((e) => e.key.length >= 3);
  const all: (Bound | null)[] = [
    ...work.map((w) => ({ kind: 'work' as const, key: norm(w.company), title: norm(w.title), min: w.minBullets, max: w.maxBullets })),
    ...interns.map((i) => ({ kind: 'intern' as const, key: norm(i.company), title: norm(i.title), min: i.minBullets, max: i.maxBullets })),
    ...projects.map((p) => ({ kind: 'project' as const, key: norm(p.name), title: '', min: p.minBullets, max: p.maxBullets })),
  ].map((b) => (b.key.length >= 3 ? (b as unknown as Bound) : null));
  const used = new Set<number>();

  const pick = (name: string, subtitle: string, hint: string): Bound | undefined => {
    const matches = all
      .map((b, i) => ({ b, i }))
      .filter((m): m is { b: Bound; i: number } => !!m.b && !used.has(m.i) && (name.includes(m.b.key) || m.b.key.includes(name)));
    if (matches.length === 0) return undefined;
    const score = ({ b }: { b: Bound }) =>
      (b.title && subtitle.includes(b.title) ? 2 : 0) + (b.kind === 'intern' && /mba|intern|consult/.test(hint) ? 1 : 0);
    const best = matches.reduce((a, c) => (score(c) > score(a) ? c : a));
    used.add(best.i);
    return best.b;
  };

  // min bullets per [section][entry], filled while matching, used by the trim below
  const mins: (number | null)[][] = resume.sections.map((s) => s.entries.map(() => null));

  const result: StructuredResume = {
    ...resume,
    sections: resume.sections.map((section, si) => ({
      ...section,
      entries: section.entries.map((entry, ei) => {
        const name = norm(entry.name);
        if (name.length < 3) return entry;
        const school = schools.find((s) => name.includes(s.key) || s.key.includes(name));
        if (school || section.kind === 'education') {
          const active = school ? school.active : /present|current|ongoing/i.test(entry.dateRange ?? '');
          return active || entry.bullets.length === 0 ? entry : { ...entry, bullets: [] };
        }
        const bound = pick(name, norm(entry.subtitle), `${entry.name} ${entry.subtitle ?? ''}`.toLowerCase());
        mins[si][ei] = bound?.min ?? null;
        return bound && bound.max !== null && bound.max !== undefined && entry.bullets.length > bound.max
          ? { ...entry, bullets: entry.bullets.slice(0, bound.max) }
          : entry;
      }),
    })),
  };

  // Last resort: still more than one page after the rules above? Drop the least valuable bullets
  // (never below an entry's minimum, never from education or the Skills lines) until it fits. The
  // resume agent is asked to cut first; this only guarantees the result for whatever is left.
  if (options.overflowPoints) {
    for (let guard = 0; guard < 60; guard++) {
      const over = options.overflowPoints(result);
      if (over <= 0) break;
      // A bullet is ~1-2 lines (~10-22pt): remove several at once when far over, to avoid re-measuring each time.
      let toRemove = Math.max(1, Math.floor(over / 30));
      let removedAny = false;
      while (toRemove > 0) {
        let removed = false;
        outer: for (let si = result.sections.length - 1; si >= 0; si--) {
          const section = result.sections[si];
          if (section.kind === 'education') continue;
          for (let ei = section.entries.length - 1; ei >= 0; ei--) {
            const entry = section.entries[ei];
            if (isPlainEntry(entry, section.heading)) continue;
            const floor = Math.max(1, mins[si][ei] ?? 1);
            if (entry.bullets.length > floor) {
              section.entries[ei] = { ...entry, bullets: entry.bullets.slice(0, -1) };
              removed = true;
              break outer;
            }
          }
        }
        if (!removed) break;
        removedAny = true;
        toRemove -= 1;
      }
      if (!removedAny) break;
    }
  }
  return result;
}
