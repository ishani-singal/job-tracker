'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ResumeProfile } from '@job-tracker/shared-types';
import { GithubConnectSection } from '@/components/github-connect-section';
import { EntriesSection } from '@/components/entries-section';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

export default function ResumesPage() {
  const queryClient = useQueryClient();
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: api.getProfile });
  const { data: stories } = useQuery({ queryKey: ['stories'], queryFn: api.listStories });
  const { data: resumeFiles } = useQuery({
    queryKey: ['resume-files'],
    queryFn: api.listResumeFiles,
  });

  async function uploadStory(file: File) {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${API_BASE}/resumes/stories/upload`, { method: 'POST', body: form });
    if (!res.ok) {
      alert(`Upload failed: ${res.status} ${await res.text()}`);
      return;
    }
    queryClient.invalidateQueries({ queryKey: ['stories'] });
  }

  async function uploadResume(file: File) {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${API_BASE}/resumes/resume/upload`, { method: 'POST', body: form });
    if (!res.ok) {
      alert(`Upload failed: ${res.status} ${await res.text()}`);
      return;
    }
    queryClient.invalidateQueries({ queryKey: ['resume-files'] });
  }

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-8">
      <h1 className="text-xl font-semibold">Resumes</h1>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Stories (primary source)</h2>
        <input
          type="file"
          onChange={(e) => e.target.files?.[0] && uploadStory(e.target.files[0])}
        />
        <ul className="text-sm opacity-80 list-disc pl-5">
          {stories?.map((f) => <li key={f.id}>{f.filename}</li>)}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Resume (formatting reference)</h2>
        <input
          type="file"
          onChange={(e) => e.target.files?.[0] && uploadResume(e.target.files[0])}
        />
        <ul className="text-sm opacity-80 list-disc pl-5">
          {resumeFiles?.map((f) => <li key={f.id}>{f.filename}</li>)}
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
    targetRoleArchetype: profile.targetRoleArchetype ?? '',
    disqualifierKeywords: (profile.disqualifierKeywords ?? []).join(', '),
    locationZip: profile.locationZip ?? '',
    maxYearsExperience: profile.maxYearsExperience?.toString() ?? '',
    matchScoreTarget: profile.matchScoreTarget?.toString() ?? '93',
  });
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await api.updateProfile({
        targetRoleArchetype: form.targetRoleArchetype,
        disqualifierKeywords: form.disqualifierKeywords
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        locationZip: form.locationZip,
        maxYearsExperience: form.maxYearsExperience ? Number(form.maxYearsExperience) : undefined,
        matchScoreTarget: form.matchScoreTarget ? Number(form.matchScoreTarget) : undefined,
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

      <Field label="Target Role Archetype">
        <input
          className="border rounded px-2 py-1 text-sm w-full bg-transparent"
          value={form.targetRoleArchetype}
          onChange={(e) => setForm({ ...form, targetRoleArchetype: e.target.value })}
        />
      </Field>
      <Field label="Disqualifier Keywords (comma-separated)">
        <input
          className="border rounded px-2 py-1 text-sm w-full bg-transparent"
          value={form.disqualifierKeywords}
          onChange={(e) => setForm({ ...form, disqualifierKeywords: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Location / Zip">
          <input
            className="border rounded px-2 py-1 text-sm w-full bg-transparent"
            value={form.locationZip}
            onChange={(e) => setForm({ ...form, locationZip: e.target.value })}
          />
        </Field>
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
