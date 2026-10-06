import type { StructuredResume } from '@job-tracker/shared-types';
import type { PrismaService } from '../prisma/prisma.service';

const norm = (s?: string | null) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Safety net for the per-entry bullet ceilings set on the Resume tab
 * (maxBullets): the model is told them as hard limits but still overshoots
 * (e.g. 4 bullets on a 1-bullet internship), so before a generated resume is
 * saved, any entry over its own max is cut to it, keeping the first bullets
 * (the agent puts the strongest first). Entries are matched to the Resume-tab
 * entries by company/project name, using the title to tell two roles at the
 * same company apart. Entries with no matching bound are untouched.
 */
export async function enforceBulletBounds(
  prisma: PrismaService,
  resume: StructuredResume,
): Promise<StructuredResume> {
  const [work, interns, projects] = await Promise.all([
    prisma.workExperienceEntry.findMany({ select: { company: true, title: true, maxBullets: true } }),
    prisma.internshipEntry.findMany({ select: { company: true, title: true, maxBullets: true } }),
    prisma.projectEntry.findMany({ select: { name: true, maxBullets: true } }),
  ]);
  const bounds = [
    ...work.map((w) => ({ key: norm(w.company), title: norm(w.title), max: w.maxBullets })),
    ...interns.map((i) => ({ key: norm(i.company), title: norm(i.title), max: i.maxBullets })),
    ...projects.map((p) => ({ key: norm(p.name), title: '', max: p.maxBullets })),
  ].filter((b) => b.key.length >= 3 && b.max !== null && b.max !== undefined);

  return {
    ...resume,
    sections: resume.sections.map((section) => ({
      ...section,
      entries: section.entries.map((entry) => {
        const name = norm(entry.name);
        if (name.length < 3) return entry;
        const matches = bounds.filter((b) => name.includes(b.key) || b.key.includes(name));
        const bound = matches.find((b) => b.title && b.title === norm(entry.subtitle)) ?? matches[0];
        return bound && entry.bullets.length > (bound.max as number)
          ? { ...entry, bullets: entry.bullets.slice(0, bound.max as number) }
          : entry;
      }),
    })),
  };
}
