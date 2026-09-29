'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useSessionsPanel } from '@/lib/sessions-panel-context';
import { LinkedinDataSection } from '@/components/linkedin-data-section';
import { formatEntryDateRange } from '@/components/date-range-fields';
import type {
  EducationEntry,
  InternshipEntry,
  LinkedinEntryBullets,
  ProjectEntry,
  WorkExperienceEntry,
} from '@job-tracker/shared-types';

function bulletsFor(
  entryBullets: LinkedinEntryBullets[],
  entryType: string,
  entryId: string,
): string[] {
  return entryBullets.find((eb) => eb.entry_type === entryType && eb.entry_id === entryId)
    ?.bullets ?? [];
}

/** Sort key for merging Work Experience + Internships chronologically —
 * ongoing (isPresent) entries first, then by start date descending. */
function sortKey(e: { isPresent: boolean; startYear: number | null; startMonth: number | null }) {
  if (e.isPresent) return Infinity;
  return (e.startYear ?? 0) * 12 + (e.startMonth ?? 0);
}

export default function LinkedinPage() {
  const queryClient = useQueryClient();
  const { openPanel } = useSessionsPanel();

  const { data: profile } = useQuery({
    queryKey: ['linkedin-profile'],
    queryFn: api.getLinkedinProfile,
  });
  const { data: staleness } = useQuery({
    queryKey: ['linkedin-staleness'],
    queryFn: api.getLinkedinStaleness,
  });
  const { data: workExperience } = useQuery({
    queryKey: ['work-experience'],
    queryFn: api.listWorkExperience,
  });
  const { data: internships } = useQuery({
    queryKey: ['internships'],
    queryFn: api.listInternships,
  });
  const { data: education } = useQuery({ queryKey: ['education'], queryFn: api.listEducation });
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });

  const startSession = useMutation({
    mutationFn: api.startLinkedinSession,
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      openPanel(session.id);
    },
  });

  const workAndInternships = [
    ...(workExperience ?? []).map((e) => ({ ...e, kind: 'workExperience' as const })),
    ...(internships ?? []).map((e) => ({ ...e, kind: 'internship' as const })),
  ].sort((a, b) => sortKey(b) - sortKey(a));

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">LinkedIn Profile</h1>
        <button
          className="px-3 py-1.5 text-sm rounded bg-black text-white dark:bg-white dark:text-black"
          onClick={() => startSession.mutate()}
          disabled={startSession.isPending}
        >
          {startSession.isPending ? 'Starting...' : profile ? 'Regenerate' : 'Generate'}
        </button>
      </div>

      {staleness?.stale && profile && (
        <p className="text-xs text-amber-600 border border-amber-200 dark:border-amber-900 rounded px-3 py-2">
          Your Stories, background, profile, or applications have changed since this draft
          was generated — regenerate to pick up the latest.
        </p>
      )}

      {!profile ? (
        <p className="text-sm opacity-60">
          No draft generated yet. This agent writes your LinkedIn headline, About section,
          and bullets for every Work Experience, Internship, Education, and Project entry —
          using your target role archetype until you have saved applications, then narrowing
          to applied roles, and reinforcing with any resume that got a callback.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-1">
            <h2 className="text-sm font-medium">Headline</h2>
            <p className="text-sm border rounded p-3">{profile.headline}</p>
          </section>

          <section className="flex flex-col gap-1">
            <h2 className="text-sm font-medium">About</h2>
            <p className="text-sm whitespace-pre-wrap border rounded p-3">{profile.about}</p>
          </section>

          <EntrySection
            title="Work Experience"
            entries={workAndInternships}
            getLabel={(e) => `${e.company}${e.title ? ` — ${e.title}` : ''}`}
            getBullets={(e) => bulletsFor(profile.entryBullets, e.kind, e.id)}
          />

          <EntrySection
            title="Education"
            entries={education ?? []}
            getLabel={(e) => `${e.school}${e.degree ? ` — ${e.degree}` : ''}`}
            getBullets={(e) => bulletsFor(profile.entryBullets, 'education', e.id)}
          />

          <EntrySection
            title="Projects"
            entries={projects ?? []}
            getLabel={(e) => e.name}
            getBullets={(e) => bulletsFor(profile.entryBullets, 'project', e.id)}
          />

          <p className="text-xs opacity-50">
            Last generated {new Date(profile.updatedAt).toLocaleString()}
          </p>
        </div>
      )}

      <LinkedinDataSection />
    </div>
  );
}

interface DatedEntry {
  id: string;
  startMonth: number | null;
  startYear: number | null;
  endMonth: number | null;
  endYear: number | null;
  isPresent: boolean;
}

function EntrySection<
  T extends DatedEntry &
    Partial<WorkExperienceEntry & InternshipEntry & EducationEntry & ProjectEntry>,
>({
  title,
  entries,
  getLabel,
  getBullets,
}: {
  title: string;
  entries: T[];
  getLabel: (entry: T) => string;
  getBullets: (entry: T) => string[];
}) {
  if (entries.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">{title}</h2>
      {entries.map((entry) => {
        const bullets = getBullets(entry);
        const dateRange = formatEntryDateRange(entry);
        return (
          <div key={entry.id} className="border rounded p-3">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-sm font-medium">{getLabel(entry)}</h3>
              {dateRange && <span className="text-xs opacity-50">{dateRange}</span>}
            </div>
            {bullets.length > 0 ? (
              <ul className="text-sm list-disc pl-5 flex flex-col gap-1">
                {bullets.map((bullet, i) => (
                  <li key={i}>{bullet}</li>
                ))}
              </ul>
            ) : (
              <p className="text-xs opacity-50">No bullets generated for this entry yet.</p>
            )}
          </div>
        );
      })}
    </section>
  );
}
