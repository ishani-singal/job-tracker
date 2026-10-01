'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  EducationEntry,
  InternshipEntry,
  ProjectEntry,
  StoryCandidate,
  StoryEntryType,
  WorkExperienceEntry,
} from '@job-tracker/shared-types';

const LOW_CONFIDENCE_THRESHOLD = 0.6;

const ENTRY_TYPE_LABEL: Record<StoryEntryType, string> = {
  WORK_EXPERIENCE: 'Work Experience',
  EDUCATION: 'Education',
  INTERNSHIP: 'Internship',
  PROJECT: 'Project',
  PAPER: 'Paper',
};

export function StoryReviewSection() {
  const queryClient = useQueryClient();

  const { data: runs } = useQuery({
    queryKey: ['story-parse-runs'],
    queryFn: api.listStoryParseRuns,
    refetchInterval: (query) => {
      const latest = query.state.data?.[0];
      const active = latest && (latest.status === 'PENDING' || latest.status === 'PARSING');
      return active ? 2000 : false;
    },
  });

  const { data: candidates } = useQuery({
    queryKey: ['story-candidates', 'PROPOSED'],
    queryFn: () => api.listStoryCandidates(),
  });

  const rerun = useMutation({
    mutationFn: api.triggerStoryRerun,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['story-parse-runs'] }),
  });

  const latestRun = runs?.[0];
  const isParsing = latestRun?.status === 'PENDING' || latestRun?.status === 'PARSING';

  const pending = (candidates ?? []).filter(
    (c) => c.status === 'PROPOSED' || c.status === 'PROPOSED_UPDATE',
  );

  const grouped = new Map<string, StoryCandidate[]>();
  for (const c of pending) {
    const key = c.entryType ?? 'NEW';
    grouped.set(key, [...(grouped.get(key) ?? []), c]);
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium">Story Review</h2>
          <p className="text-xs opacity-60">
            Every uploaded Stories/Resume file and connected GitHub repo gets its own chat
            (in the Chat panel) that asks questions to fill gaps before producing a
            comprehensive, scoped-to-one-entry story. Once that chat is accepted, its stories
            show up here — confirm, edit, or reassign each one before it&apos;s used for
            resume generation. This is what keeps one job&apos;s details from bleeding into
            another&apos;s.
          </p>
        </div>
        <button
          className="shrink-0 px-3 py-1.5 text-sm rounded border"
          onClick={() => rerun.mutate()}
          disabled={rerun.isPending || isParsing}
        >
          {isParsing ? 'Parsing...' : 'Re-parse'}
        </button>
      </div>

      {latestRun?.status === 'ERROR' && (
        <p className="text-xs text-red-600 dark:text-red-400">
          Last parse run failed: {latestRun.errorMessage}
        </p>
      )}

      {pending.length === 0 && !isParsing && (
        <p className="text-xs opacity-60">
          No proposed stories waiting for review. Upload a Stories/Resume file above, connect
          a GitHub repo, or click &quot;Re-parse&quot; to generate some — each document gets
          its own chat (see the Chat button) where you can answer clarifying questions before
          its stories land here.
        </p>
      )}

      {Array.from(grouped.entries()).map(([key, items]) => (
        <div key={key} className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase opacity-60">
            {key === 'NEW' ? 'New Entry Proposals' : ENTRY_TYPE_LABEL[key as StoryEntryType]}
          </h3>
          {items.map((candidate) => (
            <CandidateCard key={candidate.id} candidate={candidate} />
          ))}
        </div>
      ))}
    </section>
  );
}

function CandidateCard({ candidate }: { candidate: StoryCandidate }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(candidate.proposedStoryText);
  const [newEntryName, setNewEntryName] = useState(candidate.newEntryLabel ?? '');

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['story-candidates'] });
    queryClient.invalidateQueries({ queryKey: ['confirmed-stories'] });
    queryClient.invalidateQueries({ queryKey: ['work-experience'] });
    queryClient.invalidateQueries({ queryKey: ['education'] });
    queryClient.invalidateQueries({ queryKey: ['internships'] });
    queryClient.invalidateQueries({ queryKey: ['projects'] });
  };

  const confirm = useMutation({
    mutationFn: () => api.confirmStoryCandidate(candidate.id, text),
    onSuccess: invalidate,
  });

  const reject = useMutation({
    mutationFn: () => api.rejectStoryCandidate(candidate.id),
    onSuccess: invalidate,
  });

  const reassign = useMutation({
    mutationFn: (target: { entryType: StoryEntryType; entryId: string }) =>
      api.reassignStoryCandidate(candidate.id, target.entryType, target.entryId),
    onSuccess: invalidate,
  });

  const createEntry = useMutation({
    mutationFn: (entryType: StoryEntryType) =>
      api.createEntryFromStoryCandidate(candidate.id, entryType, nameFieldFor(entryType, newEntryName)),
    onSuccess: invalidate,
  });

  const isLowConfidence = candidate.confidence < LOW_CONFIDENCE_THRESHOLD;
  const isUpdate = candidate.status === 'PROPOSED_UPDATE';
  const needsEntry = !candidate.entryId;

  return (
    <div
      className={`flex flex-col gap-2 border rounded px-3 py-2 text-sm ${
        isLowConfidence ? 'border-amber-500' : ''
      }`}
    >
      <div className="flex items-center justify-between text-xs opacity-70">
        <span>
          Source: {candidate.storyFileId ?? candidate.resumeFileId ?? candidate.repoFullName ?? 'unknown'}
          {isUpdate && ' · Update available'}
        </span>
        <span className={isLowConfidence ? 'text-amber-600 dark:text-amber-400 font-medium' : ''}>
          Confidence: {Math.round(candidate.confidence * 100)}%
          {isLowConfidence && ' — please confirm the entry below'}
        </span>
      </div>

      {isUpdate && (
        <details className="text-xs opacity-60">
          <summary className="cursor-pointer">Show source excerpt</summary>
          <p className="whitespace-pre-wrap mt-1">{candidate.sourceSpanText}</p>
        </details>
      )}

      {needsEntry ? (
        <div className="flex flex-col gap-2 text-xs">
          <span className="opacity-70">
            No existing entry matched{candidate.newEntryLabel ? ` — proposed as a new entry: "${candidate.newEntryLabel}"` : ''}.
            Pick an existing entry this actually belongs to, or create a new one below.
          </span>
          <EntryReassignPicker
            currentEntryType={candidate.entryType ?? undefined}
            currentEntryId={undefined}
            onPick={(entryType, entryId) => reassign.mutate({ entryType, entryId })}
          />
          <div className="flex items-center gap-2">
            <input
              className="border rounded px-2 py-1 text-xs bg-transparent flex-1"
              placeholder="New entry name (company/school/project)"
              value={newEntryName}
              onChange={(e) => setNewEntryName(e.target.value)}
            />
            <select
              className="border rounded px-2 py-1 text-xs bg-transparent"
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) createEntry.mutate(e.target.value as StoryEntryType);
              }}
              disabled={!newEntryName.trim() || createEntry.isPending}
            >
              <option value="" disabled>
                Create as...
              </option>
              <option value="WORK_EXPERIENCE">Work Experience</option>
              <option value="EDUCATION">Education</option>
              <option value="INTERNSHIP">Internship</option>
              <option value="PROJECT">Project</option>
            </select>
          </div>
        </div>
      ) : (
        <EntryReassignPicker
          currentEntryType={candidate.entryType ?? undefined}
          currentEntryId={candidate.entryId ?? undefined}
          onPick={(entryType, entryId) => reassign.mutate({ entryType, entryId })}
        />
      )}

      <textarea
        className="border rounded px-2 py-1 text-xs w-full h-24 bg-transparent font-mono"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      <div className="flex gap-2">
        <button
          className="px-2 py-1 text-xs rounded bg-black text-white dark:bg-white dark:text-black"
          onClick={() => confirm.mutate()}
          disabled={confirm.isPending || needsEntry}
        >
          {isUpdate ? 'Confirm Update' : 'Confirm'}
        </button>
        <button
          className="px-2 py-1 text-xs rounded border"
          onClick={() => reject.mutate()}
          disabled={reject.isPending}
        >
          Reject
        </button>
      </div>
    </div>
  );
}

function nameFieldFor(entryType: StoryEntryType, name: string): Record<string, unknown> {
  switch (entryType) {
    case 'WORK_EXPERIENCE':
    case 'INTERNSHIP':
      return { company: name };
    case 'EDUCATION':
      return { school: name };
    case 'PROJECT':
      return { name };
    default:
      return {};
  }
}

/** The "mark/align" control — lets the user pick which existing entry this
 * candidate's story actually belongs to, overriding the model's guess. */
function EntryReassignPicker({
  currentEntryType,
  currentEntryId,
  onPick,
}: {
  currentEntryType?: StoryEntryType;
  currentEntryId?: string;
  onPick: (entryType: StoryEntryType, entryId: string) => void;
}) {
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

  const options: { entryType: StoryEntryType; entryId: string; label: string }[] = [
    ...(workExperience ?? []).map((e: WorkExperienceEntry) => ({
      entryType: 'WORK_EXPERIENCE' as const,
      entryId: e.id,
      label: `Work: ${e.company}${e.title ? ` — ${e.title}` : ''}`,
    })),
    ...(education ?? []).map((e: EducationEntry) => ({
      entryType: 'EDUCATION' as const,
      entryId: e.id,
      label: `Education: ${e.school}`,
    })),
    ...(internships ?? []).map((e: InternshipEntry) => ({
      entryType: 'INTERNSHIP' as const,
      entryId: e.id,
      label: `Internship: ${e.company}${e.title ? ` — ${e.title}` : ''}`,
    })),
    ...(projects ?? []).map((e: ProjectEntry) => ({
      entryType: 'PROJECT' as const,
      entryId: e.id,
      label: `Project: ${e.name}`,
    })),
  ];

  const currentValue =
    currentEntryType && currentEntryId ? `${currentEntryType}:${currentEntryId}` : '';

  return (
    <select
      className="border rounded px-2 py-1 text-xs bg-transparent"
      value={currentValue}
      onChange={(e) => {
        const [entryType, entryId] = e.target.value.split(':') as [StoryEntryType, string];
        if (entryType && entryId) onPick(entryType, entryId);
      }}
    >
      <option value="">Select entry...</option>
      {options.map((o) => (
        <option key={`${o.entryType}:${o.entryId}`} value={`${o.entryType}:${o.entryId}`}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
