'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useSessionsPanel } from '@/lib/sessions-panel-context';

/** Maps an entry_id back to a human label ("Dell Technologies — Advisor",
 * "University of Washington, Seattle — MBA") by looking it up across all
 * four background lists — the LinkedIn draft only stores the id + type, not
 * a display name, so this join happens client-side at render time. */
function useEntryLabels() {
  const { data: workExperience } = useQuery({
    queryKey: ['work-experience'],
    queryFn: api.listWorkExperience,
  });
  const { data: education } = useQuery({ queryKey: ['education'], queryFn: api.listEducation });
  const { data: internships } = useQuery({
    queryKey: ['internships'],
    queryFn: api.listInternships,
  });
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });

  return (entryType: string, entryId: string): string => {
    if (entryType === 'workExperience') {
      const e = workExperience?.find((x) => x.id === entryId);
      return e ? `${e.company}${e.title ? ` — ${e.title}` : ''}` : 'Work Experience';
    }
    if (entryType === 'education') {
      const e = education?.find((x) => x.id === entryId);
      return e ? `${e.school}${e.degree ? ` — ${e.degree}` : ''}` : 'Education';
    }
    if (entryType === 'internship') {
      const e = internships?.find((x) => x.id === entryId);
      return e ? `${e.company}${e.title ? ` — ${e.title}` : ''}` : 'Internship';
    }
    if (entryType === 'project') {
      const e = projects?.find((x) => x.id === entryId);
      return e ? e.name : 'Project';
    }
    return entryType;
  };
}

export default function LinkedinPage() {
  const queryClient = useQueryClient();
  const { openPanel } = useSessionsPanel();
  const entryLabel = useEntryLabels();

  const { data: profile } = useQuery({
    queryKey: ['linkedin-profile'],
    queryFn: api.getLinkedinProfile,
  });
  const { data: staleness } = useQuery({
    queryKey: ['linkedin-staleness'],
    queryFn: api.getLinkedinStaleness,
  });

  const startSession = useMutation({
    mutationFn: api.startLinkedinSession,
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      openPanel(session.id);
    },
  });

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">LinkedIn Profile</h1>
        <button
          className="px-3 py-1.5 text-sm rounded bg-black text-white dark:bg-white dark:text-black"
          onClick={() => startSession.mutate()}
          disabled={startSession.isPending}
        >
          {startSession.isPending
            ? 'Starting...'
            : profile
              ? 'Regenerate'
              : 'Generate'}
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
          and per-position bullets from your Stories and background — using your target
          role archetype until you have saved applications, then narrowing to applied
          roles, and reinforcing with any resume that got a callback.
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

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">Per-Position Bullets</h2>
            {profile.entryBullets.map((eb, idx) => (
              <div key={`${eb.entry_id}-${idx}`} className="border rounded p-3">
                <h3 className="text-sm font-medium mb-1">
                  {entryLabel(eb.entry_type, eb.entry_id)}
                </h3>
                <ul className="text-sm list-disc pl-5 flex flex-col gap-1">
                  {eb.bullets.map((bullet, i) => (
                    <li key={i}>{bullet}</li>
                  ))}
                </ul>
              </div>
            ))}
          </section>

          <p className="text-xs opacity-50">
            Last generated {new Date(profile.updatedAt).toLocaleString()}
          </p>
        </div>
      )}
    </div>
  );
}
