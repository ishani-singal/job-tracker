import type { StructuredResume } from '@job-tracker/shared-types';
import type { PrismaService } from '../prisma/prisma.service';

const norm = (s?: string | null) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

interface Bound {
  kind: 'work' | 'intern' | 'project';
  key: string;
  title: string;
  max: number;
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
export async function enforceBulletBounds(
  prisma: PrismaService,
  resume: StructuredResume,
): Promise<StructuredResume> {
  const [work, interns, projects, education] = await Promise.all([
    prisma.workExperienceEntry.findMany({ select: { company: true, title: true, maxBullets: true } }),
    prisma.internshipEntry.findMany({ select: { company: true, title: true, maxBullets: true } }),
    prisma.projectEntry.findMany({ select: { name: true, maxBullets: true } }),
    prisma.educationEntry.findMany({ select: { school: true, isPresent: true } }),
  ]);
  const schools = education
    .map((e) => ({ key: norm(e.school), active: e.isPresent }))
    .filter((e) => e.key.length >= 3);
  const all: (Bound | null)[] = [
    ...work.map((w) => ({ kind: 'work' as const, key: norm(w.company), title: norm(w.title), max: w.maxBullets })),
    ...interns.map((i) => ({ kind: 'intern' as const, key: norm(i.company), title: norm(i.title), max: i.maxBullets })),
    ...projects.map((p) => ({ kind: 'project' as const, key: norm(p.name), title: '', max: p.maxBullets })),
  ].map((b) => (b.key.length >= 3 && b.max !== null && b.max !== undefined ? (b as Bound) : null));
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

  return {
    ...resume,
    sections: resume.sections.map((section) => ({
      ...section,
      entries: section.entries.map((entry) => {
        const name = norm(entry.name);
        if (name.length < 3) return entry;
        const school = schools.find((s) => name.includes(s.key) || s.key.includes(name));
        if (school || section.kind === 'education') {
          const active = school ? school.active : /present|current|ongoing/i.test(entry.dateRange ?? '');
          return active || entry.bullets.length === 0 ? entry : { ...entry, bullets: [] };
        }
        const bound = pick(name, norm(entry.subtitle), `${entry.name} ${entry.subtitle ?? ''}`.toLowerCase());
        return bound && entry.bullets.length > bound.max ? { ...entry, bullets: entry.bullets.slice(0, bound.max) } : entry;
      }),
    })),
  };
}
