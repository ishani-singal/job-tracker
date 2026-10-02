'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ResumeProfile } from '@job-tracker/shared-types';
import { GithubConnectSection } from '@/components/github-connect-section';
import { EntriesSection } from '@/components/entries-section';
import type { StoryEntryType } from '@job-tracker/shared-types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

const BACKGROUND_TYPE_OPTIONS: { value: StoryEntryType; label: string }[] = [
  { value: 'WORK_EXPERIENCE', label: 'Work Experience' },
  { value: 'EDUCATION', label: 'Education' },
  { value: 'INTERNSHIP', label: 'Internship' },
  { value: 'PROJECT', label: 'Project' },
];

interface BackgroundSelection {
  entryType: StoryEntryType | '';
  entryId: string;
}

const EMPTY_BACKGROUND_SELECTION: BackgroundSelection = { entryType: '', entryId: '' };

/** Required two-step picker shown before an upload: the category (Work
 * Experience/Education/Internship/Project), then the specific entry within
 * it (e.g. "Dell" under Work Experience). There is no extraction chat to
 * resolve an untagged upload later — every file must be pinned to exactly
 * one entry before it's used for anything, so both steps are required. */
function BackgroundPicker({
  value,
  onChange,
}: {
  value: BackgroundSelection;
  onChange: (next: BackgroundSelection) => void;
}) {
  const { data: workExperience } = useQuery({
    queryKey: ['work-experience'],
    queryFn: api.listWorkExperience,
    enabled: value.entryType === 'WORK_EXPERIENCE',
  });
  const { data: education } = useQuery({
    queryKey: ['education'],
    queryFn: api.listEducation,
    enabled: value.entryType === 'EDUCATION',
  });
  const { data: internships } = useQuery({
    queryKey: ['internships'],
    queryFn: api.listInternships,
    enabled: value.entryType === 'INTERNSHIP',
  });
  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: api.listProjects,
    enabled: value.entryType === 'PROJECT',
  });

  const entryOptions: { id: string; label: string }[] =
    value.entryType === 'WORK_EXPERIENCE'
      ? (workExperience ?? []).map((e) => ({
          id: e.id,
          label: `${e.company}${e.title ? ` — ${e.title}` : ''}`,
        }))
      : value.entryType === 'EDUCATION'
        ? (education ?? []).map((e) => ({ id: e.id, label: e.school }))
        : value.entryType === 'INTERNSHIP'
          ? (internships ?? []).map((e) => ({
              id: e.id,
              label: `${e.company}${e.title ? ` — ${e.title}` : ''}`,
            }))
          : value.entryType === 'PROJECT'
            ? (projects ?? []).map((e) => ({ id: e.id, label: e.name }))
            : [];

  return (
    <div className="flex gap-2 items-center">
      <select
        className="border rounded px-2 py-1 text-sm bg-transparent"
        value={value.entryType}
        onChange={(e) => onChange({ entryType: e.target.value as StoryEntryType | '', entryId: '' })}
      >
        <option value="">Pick a category...</option>
        {BACKGROUND_TYPE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <select
        className="border rounded px-2 py-1 text-sm bg-transparent"
        value={value.entryId}
        onChange={(e) => onChange({ ...value, entryId: e.target.value })}
        disabled={!value.entryType}
      >
        <option value="">Pick which one...</option>
        {entryOptions.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function StopAllLlmCallsButton() {
  const [stopping, setStopping] = useState(false);

  async function handleStop() {
    setStopping(true);
    try {
      await api.stopAllLlmCalls();
    } finally {
      setStopping(false);
    }
  }

  return (
    <button
      className="px-3 py-1.5 text-sm rounded border border-red-600 text-red-600 dark:text-red-400 dark:border-red-400"
      onClick={handleStop}
      disabled={stopping}
    >
      {stopping ? 'Stopping...' : 'Stop All LLM Calls'}
    </button>
  );
}

export default function ResumesPage() {
  const queryClient = useQueryClient();
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: api.getProfile });
  const { data: stories } = useQuery({ queryKey: ['stories'], queryFn: api.listStories });
  const { data: resumeFiles } = useQuery({
    queryKey: ['resume-files'],
    queryFn: api.listResumeFiles,
  });
  const [storyBackground, setStoryBackground] = useState<BackgroundSelection>(EMPTY_BACKGROUND_SELECTION);
  const [resumeBackground, setResumeBackground] = useState<BackgroundSelection>(EMPTY_BACKGROUND_SELECTION);

  const storyReady = !!storyBackground.entryType && !!storyBackground.entryId;
  const resumeReady = !!resumeBackground.entryType && !!resumeBackground.entryId;

  async function uploadStory(file: File) {
    const form = new FormData();
    // entryType/entryId must come before the file part — the server reads
    // them off req.file().fields, which @fastify/multipart only populates
    // from parts it has already seen by the time the file part resolves;
    // fields appended after the file are not guaranteed to be there yet.
    form.append('entryType', storyBackground.entryType);
    form.append('entryId', storyBackground.entryId);
    form.append('file', file);
    const res = await fetch(`${API_BASE}/resumes/stories/upload`, { method: 'POST', body: form });
    if (!res.ok) {
      alert(`Upload failed: ${res.status} ${await res.text()}`);
      return;
    }
    setStoryBackground(EMPTY_BACKGROUND_SELECTION);
    queryClient.invalidateQueries({ queryKey: ['stories'] });
  }

  async function uploadResume(file: File) {
    const form = new FormData();
    form.append('entryType', resumeBackground.entryType);
    form.append('entryId', resumeBackground.entryId);
    form.append('file', file);
    const res = await fetch(`${API_BASE}/resumes/resume/upload`, { method: 'POST', body: form });
    if (!res.ok) {
      alert(`Upload failed: ${res.status} ${await res.text()}`);
      return;
    }
    setResumeBackground(EMPTY_BACKGROUND_SELECTION);
    queryClient.invalidateQueries({ queryKey: ['resume-files'] });
  }

  async function removeStory(id: string) {
    if (!confirm('Remove this Stories file?')) return;
    await api.deleteStory(id);
    queryClient.invalidateQueries({ queryKey: ['stories'] });
  }

  async function removeResumeFile(id: string) {
    if (!confirm('Remove this Resume file?')) return;
    await api.deleteResumeFile(id);
    queryClient.invalidateQueries({ queryKey: ['resume-files'] });
  }

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Resumes</h1>
        <StopAllLlmCallsButton />
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Stories (primary source)</h2>
        <p className="text-xs opacity-60">
          Pick which entry this document is about before uploading — a category (Work
          Experience, Education, Internship, Project), then the specific entry within it (e.g.
          &quot;Dell&quot; under Work Experience). Resume generation reads this file&apos;s raw
          text live for that entry only.
        </p>
        <div className="flex gap-2 items-center">
          <BackgroundPicker value={storyBackground} onChange={setStoryBackground} />
          <input
            type="file"
            disabled={!storyReady}
            onChange={(e) => e.target.files?.[0] && uploadStory(e.target.files[0])}
          />
        </div>
        <ul className="text-sm opacity-80 flex flex-col gap-1">
          {stories?.map((f) => (
            <li key={f.id} className="flex items-center justify-between">
              <span>{f.filename}</span>
              <button
                className="text-xs text-red-600 dark:text-red-400"
                onClick={() => removeStory(f.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Resume (formatting reference)</h2>
        <div className="flex gap-2 items-center">
          <BackgroundPicker value={resumeBackground} onChange={setResumeBackground} />
          <input
            type="file"
            disabled={!resumeReady}
            onChange={(e) => e.target.files?.[0] && uploadResume(e.target.files[0])}
          />
        </div>
        <ul className="text-sm opacity-80 flex flex-col gap-1">
          {resumeFiles?.map((f) => (
            <li key={f.id} className="flex items-center justify-between">
              <span>{f.filename}</span>
              <button
                className="text-xs text-red-600 dark:text-red-400"
                onClick={() => removeResumeFile(f.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </section>

      <GithubConnectSection />

      {profile && <ProfileForm profile={profile} />}

      <EntriesSection />

      <PromptPreviewSection />
    </div>
  );
}

function PromptPreviewSection() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['prompt-preview'],
    queryFn: api.getPromptPreview,
  });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  function startEditing() {
    setDraft(data?.template_body ?? '');
    setEditing(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await api.updateProfile({ templateBody: draft });
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      queryClient.invalidateQueries({ queryKey: ['prompt-preview'] });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Resume-Generation Prompt (live preview)</h2>
        {data && !editing && (
          <button className="text-xs opacity-70 hover:opacity-100" onClick={startEditing}>
            Edit
          </button>
        )}
      </div>
      <p className="text-xs opacity-60">
        This is the exact system prompt sent to the AI when you click &quot;Generate
        Resume&quot; on an application — your candidate profile above plus the process
        template below. It updates automatically whenever you edit your profile. The
        persona/facts/background section is read-only here (it&apos;s generated from your
        profile and background entries above); only the process template is directly
        editable. The job description and your uploaded Stories/Resume/connected-repo
        content are added on top of this per generation, not shown here.
      </p>
      {isLoading && <p className="text-xs opacity-60">Loading...</p>}
      {error && (
        <p className="text-xs text-amber-600">
          Couldn&apos;t reach the resume agent to preview the prompt — it may not be running.
        </p>
      )}
      {data && !editing && (
        <pre className="text-xs whitespace-pre-wrap border rounded p-3 max-h-96 overflow-y-auto opacity-80">
          {data.prompt}
        </pre>
      )}
      {data && editing && (
        <div className="flex flex-col gap-2">
          <pre className="text-xs whitespace-pre-wrap border rounded p-3 max-h-48 overflow-y-auto opacity-60">
            {data.prefix}
          </pre>
          <textarea
            className="border rounded px-2 py-1 text-xs w-full h-64 bg-transparent font-mono"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              className="px-3 py-1.5 text-sm rounded bg-black text-white dark:bg-white dark:text-black"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
            <button
              className="px-3 py-1.5 text-sm rounded border"
              onClick={() => setEditing(false)}
              disabled={saving}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function ProfileForm({ profile }: { profile: ResumeProfile }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    candidateName: profile.candidateName ?? '',
    candidateEmail: profile.candidateEmail ?? '',
    candidatePhone: profile.candidatePhone ?? '',
    linkedinUrl: profile.linkedinUrl ?? '',
    targetRoleArchetype: profile.targetRoleArchetype ?? '',
    disqualifierKeywords: (profile.disqualifierKeywords ?? []).join(', '),
    locationCountry: profile.locationCountry ?? '',
    locationState: profile.locationState ?? '',
    locationCity: profile.locationCity ?? '',
    openToRemote: profile.openToRemote ?? false,
    maxYearsExperience: profile.maxYearsExperience?.toString() ?? '',
    matchScoreTarget: profile.matchScoreTarget?.toString() ?? '93',
    minBulletsWork: profile.minBulletsWork?.toString() ?? '',
    maxBulletsWork: profile.maxBulletsWork?.toString() ?? '',
    minBulletsInternship: profile.minBulletsInternship?.toString() ?? '',
    maxBulletsInternship: profile.maxBulletsInternship?.toString() ?? '',
    minBulletsProject: profile.minBulletsProject?.toString() ?? '',
    maxBulletsProject: profile.maxBulletsProject?.toString() ?? '',
  });
  const [saving, setSaving] = useState(false);

  const { data: countries } = useQuery({ queryKey: ['countries'], queryFn: api.listCountries });
  const { data: states } = useQuery({
    queryKey: ['states', form.locationCountry],
    queryFn: () => api.listStates(form.locationCountry),
    enabled: !!form.locationCountry,
  });

  async function handleSave() {
    setSaving(true);
    try {
      await api.updateProfile({
        candidateName: form.candidateName,
        candidateEmail: form.candidateEmail,
        candidatePhone: form.candidatePhone,
        linkedinUrl: form.linkedinUrl,
        targetRoleArchetype: form.targetRoleArchetype,
        disqualifierKeywords: form.disqualifierKeywords
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        locationCountry: form.locationCountry || null,
        locationState: form.locationState || null,
        locationCity: form.locationCity || null,
        openToRemote: form.openToRemote,
        maxYearsExperience: form.maxYearsExperience ? Number(form.maxYearsExperience) : undefined,
        matchScoreTarget: form.matchScoreTarget ? Number(form.matchScoreTarget) : undefined,
        minBulletsWork: form.minBulletsWork ? Number(form.minBulletsWork) : null,
        maxBulletsWork: form.maxBulletsWork ? Number(form.maxBulletsWork) : null,
        minBulletsInternship: form.minBulletsInternship ? Number(form.minBulletsInternship) : null,
        maxBulletsInternship: form.maxBulletsInternship ? Number(form.maxBulletsInternship) : null,
        minBulletsProject: form.minBulletsProject ? Number(form.minBulletsProject) : null,
        maxBulletsProject: form.maxBulletsProject ? Number(form.maxBulletsProject) : null,
      });
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">Candidate Profile</h2>
      <p className="text-xs opacity-60">
        These facts get interpolated into the resume-generation prompt for every role —
        edit once, applies to all future generations.
      </p>

      <Field label="Candidate Name">
        <input
          className="border rounded px-2 py-1 text-sm w-full bg-transparent"
          value={form.candidateName}
          onChange={(e) => setForm({ ...form, candidateName: e.target.value })}
        />
      </Field>
      <Field label="Target Role Archetype">
        <input
          className="border rounded px-2 py-1 text-sm w-full bg-transparent"
          value={form.targetRoleArchetype}
          onChange={(e) => setForm({ ...form, targetRoleArchetype: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Email">
          <input
            type="email"
            className="border rounded px-2 py-1 text-sm w-full bg-transparent"
            value={form.candidateEmail}
            onChange={(e) => setForm({ ...form, candidateEmail: e.target.value })}
          />
        </Field>
        <Field label="Phone Number">
          <input
            type="tel"
            className="border rounded px-2 py-1 text-sm w-full bg-transparent"
            value={form.candidatePhone}
            onChange={(e) => setForm({ ...form, candidatePhone: e.target.value })}
          />
        </Field>
      </div>
      <Field label="LinkedIn URL">
        <input
          type="url"
          placeholder="https://linkedin.com/in/..."
          className="border rounded px-2 py-1 text-sm w-full bg-transparent"
          value={form.linkedinUrl}
          onChange={(e) => setForm({ ...form, linkedinUrl: e.target.value })}
        />
      </Field>
      <Field label="Disqualifier Keywords (comma-separated)">
        <input
          className="border rounded px-2 py-1 text-sm w-full bg-transparent"
          value={form.disqualifierKeywords}
          onChange={(e) => setForm({ ...form, disqualifierKeywords: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Country">
          <select
            className="border rounded px-2 py-1 text-sm w-full bg-transparent"
            value={form.locationCountry}
            onChange={(e) =>
              setForm({ ...form, locationCountry: e.target.value, locationState: '', locationCity: '' })
            }
          >
            <option value="">Select country</option>
            {countries?.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="State / Region">
          <select
            className="border rounded px-2 py-1 text-sm w-full bg-transparent"
            value={form.locationState}
            onChange={(e) => setForm({ ...form, locationState: e.target.value, locationCity: '' })}
            disabled={!form.locationCountry}
          >
            <option value="">Select state</option>
            {states?.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="City (optional)">
          <input
            className="border rounded px-2 py-1 text-sm w-full bg-transparent"
            value={form.locationCity}
            onChange={(e) => setForm({ ...form, locationCity: e.target.value })}
            disabled={!form.locationState}
          />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-xs opacity-80">
        <input
          type="checkbox"
          checked={form.openToRemote}
          onChange={(e) => setForm({ ...form, openToRemote: e.target.checked })}
        />
        Open to remote roles (also match roles whose remote eligibility covers my location)
      </label>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Max Years Experience Cutoff">
          <input
            type="number"
            className="border rounded px-2 py-1 text-sm w-full bg-transparent"
            value={form.maxYearsExperience}
            onChange={(e) => setForm({ ...form, maxYearsExperience: e.target.value })}
          />
        </Field>
        <Field label="ATS Match Score Target (%)">
          <input
            type="number"
            min={0}
            max={100}
            className="border rounded px-2 py-1 text-sm w-full bg-transparent"
            value={form.matchScoreTarget}
            onChange={(e) => setForm({ ...form, matchScoreTarget: e.target.value })}
          />
        </Field>
      </div>
      <p className="text-xs opacity-60">
        93% is a reasonable default for most ATS systems — higher targets push the agent to
        incorporate more exact JD phrasing, which can read as less natural.
      </p>

      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium opacity-80">Bullets per entry (leave blank = open-ended)</h3>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Work Experience — Min">
            <input
              type="number"
              min={0}
              className="border rounded px-2 py-1 text-sm w-full bg-transparent"
              value={form.minBulletsWork}
              onChange={(e) => setForm({ ...form, minBulletsWork: e.target.value })}
            />
          </Field>
          <Field label="Work Experience — Max">
            <input
              type="number"
              min={0}
              className="border rounded px-2 py-1 text-sm w-full bg-transparent"
              value={form.maxBulletsWork}
              onChange={(e) => setForm({ ...form, maxBulletsWork: e.target.value })}
            />
          </Field>
          <div />
          <Field label="Internship — Min">
            <input
              type="number"
              min={0}
              className="border rounded px-2 py-1 text-sm w-full bg-transparent"
              value={form.minBulletsInternship}
              onChange={(e) => setForm({ ...form, minBulletsInternship: e.target.value })}
            />
          </Field>
          <Field label="Internship — Max">
            <input
              type="number"
              min={0}
              className="border rounded px-2 py-1 text-sm w-full bg-transparent"
              value={form.maxBulletsInternship}
              onChange={(e) => setForm({ ...form, maxBulletsInternship: e.target.value })}
            />
          </Field>
          <div />
          <Field label="Project — Min">
            <input
              type="number"
              min={0}
              className="border rounded px-2 py-1 text-sm w-full bg-transparent"
              value={form.minBulletsProject}
              onChange={(e) => setForm({ ...form, minBulletsProject: e.target.value })}
            />
          </Field>
          <Field label="Project — Max">
            <input
              type="number"
              min={0}
              className="border rounded px-2 py-1 text-sm w-full bg-transparent"
              value={form.maxBulletsProject}
              onChange={(e) => setForm({ ...form, maxBulletsProject: e.target.value })}
            />
          </Field>
        </div>
      </div>

      <button
        className="self-start px-3 py-1.5 text-sm rounded bg-black text-white dark:bg-white dark:text-black"
        onClick={handleSave}
        disabled={saving}
      >
        {saving ? 'Saving...' : 'Save Profile'}
      </button>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs opacity-80">
      {label}
      {children}
    </label>
  );
}
