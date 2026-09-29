'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  EducationEntry,
  InternshipEntry,
  ProjectEntry,
  WorkExperienceEntry,
} from '@job-tracker/shared-types';

export function EntriesSection() {
  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="text-sm font-medium">Background</h2>
        <p className="text-xs opacity-60">
          Curate your work experience, education, internships, and projects once. Mark an
          entry &quot;Required&quot; to have it always included in generated resumes;
          unchecked entries are included only when they&apos;re relevant to the specific job
          being tailored for.
        </p>
      </div>
      <WorkExperienceList />
      <EducationList />
      <InternshipList />
      <ProjectList />
    </section>
  );
}

function WorkExperienceList() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['work-experience'], queryFn: api.listWorkExperience });
  const [form, setForm] = useState({
    company: '',
    title: '',
    yearIn: '',
    yearOut: '',
    required: true,
  });

  const create = useMutation({
    mutationFn: () =>
      api.createWorkExperience({
        company: form.company,
        title: form.title || undefined,
        yearIn: form.yearIn ? Number(form.yearIn) : undefined,
        yearOut: form.yearOut ? Number(form.yearOut) : undefined,
        required: form.required,
      }),
    onSuccess: () => {
      setForm({ company: '', title: '', yearIn: '', yearOut: '', required: true });
      queryClient.invalidateQueries({ queryKey: ['work-experience'] });
    },
  });

  const toggleRequired = (entry: WorkExperienceEntry) =>
    api
      .updateWorkExperience(entry.id, { required: !entry.required })
      .then(() => queryClient.invalidateQueries({ queryKey: ['work-experience'] }));

  const remove = (id: string) =>
    api.deleteWorkExperience(id).then(() =>
      queryClient.invalidateQueries({ queryKey: ['work-experience'] }),
    );

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase opacity-60">Work Experience</h3>
      {data?.map((entry) => (
        <EntryRow
          key={entry.id}
          label={`${entry.company}${entry.title ? ` — ${entry.title}` : ''}`}
          sublabel={`${entry.yearIn ?? '?'} – ${entry.yearOut ?? 'present'}`}
          required={entry.required}
          onToggleRequired={() => toggleRequired(entry)}
          onDelete={() => remove(entry.id)}
        />
      ))}
      <div className="grid grid-cols-4 gap-2">
        <input
          className="border rounded px-2 py-1 text-sm bg-transparent col-span-2"
          placeholder="Company"
          value={form.company}
          onChange={(e) => setForm({ ...form, company: e.target.value })}
        />
        <input
          className="border rounded px-2 py-1 text-sm bg-transparent col-span-2"
          placeholder="Title"
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
        />
        <input
          className="border rounded px-2 py-1 text-sm bg-transparent"
          placeholder="Year in"
          value={form.yearIn}
          onChange={(e) => setForm({ ...form, yearIn: e.target.value })}
        />
        <input
          className="border rounded px-2 py-1 text-sm bg-transparent"
          placeholder="Year out"
          value={form.yearOut}
          onChange={(e) => setForm({ ...form, yearOut: e.target.value })}
        />
        <label className="flex items-center gap-1 text-xs col-span-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.required}
            onChange={(e) => setForm({ ...form, required: e.target.checked })}
          />
          Required
        </label>
        <button
          className="col-span-2 px-2 py-1 text-sm rounded border"
          onClick={() => create.mutate()}
          disabled={!form.company || create.isPending}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function EducationList() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['education'], queryFn: api.listEducation });
  const [form, setForm] = useState({ school: '', degree: '', year: '', required: true });

  const create = useMutation({
    mutationFn: () =>
      api.createEducation({
        school: form.school,
        degree: form.degree || undefined,
        year: form.year ? Number(form.year) : undefined,
        required: form.required,
      }),
    onSuccess: () => {
      setForm({ school: '', degree: '', year: '', required: true });
      queryClient.invalidateQueries({ queryKey: ['education'] });
    },
  });

  const toggleRequired = (entry: EducationEntry) =>
    api
      .updateEducation(entry.id, { required: !entry.required })
      .then(() => queryClient.invalidateQueries({ queryKey: ['education'] }));

  const remove = (id: string) =>
    api.deleteEducation(id).then(() => queryClient.invalidateQueries({ queryKey: ['education'] }));

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase opacity-60">Education</h3>
      {data?.map((entry) => (
        <EntryRow
          key={entry.id}
          label={`${entry.school}${entry.degree ? ` — ${entry.degree}` : ''}`}
          sublabel={entry.year ? `${entry.year}` : ''}
          required={entry.required}
          onToggleRequired={() => toggleRequired(entry)}
          onDelete={() => remove(entry.id)}
        />
      ))}
      <div className="grid grid-cols-4 gap-2">
        <input
          className="border rounded px-2 py-1 text-sm bg-transparent col-span-2"
          placeholder="School"
          value={form.school}
          onChange={(e) => setForm({ ...form, school: e.target.value })}
        />
        <input
          className="border rounded px-2 py-1 text-sm bg-transparent"
          placeholder="Degree"
          value={form.degree}
          onChange={(e) => setForm({ ...form, degree: e.target.value })}
        />
        <input
          className="border rounded px-2 py-1 text-sm bg-transparent"
          placeholder="Year"
          value={form.year}
          onChange={(e) => setForm({ ...form, year: e.target.value })}
        />
        <label className="flex items-center gap-1 text-xs col-span-4 cursor-pointer">
          <input
            type="checkbox"
            checked={form.required}
            onChange={(e) => setForm({ ...form, required: e.target.checked })}
          />
          Required
        </label>
        <button
          className="col-span-4 px-2 py-1 text-sm rounded border"
          onClick={() => create.mutate()}
          disabled={!form.school || create.isPending}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function InternshipList() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['internships'], queryFn: api.listInternships });
  const [form, setForm] = useState({ company: '', year: '', required: false });

  const create = useMutation({
    mutationFn: () =>
      api.createInternship({
        company: form.company,
        year: form.year ? Number(form.year) : undefined,
        required: form.required,
      }),
    onSuccess: () => {
      setForm({ company: '', year: '', required: false });
      queryClient.invalidateQueries({ queryKey: ['internships'] });
    },
  });

  const toggleRequired = (entry: InternshipEntry) =>
    api
      .updateInternship(entry.id, { required: !entry.required })
      .then(() => queryClient.invalidateQueries({ queryKey: ['internships'] }));

  const remove = (id: string) =>
    api
      .deleteInternship(id)
      .then(() => queryClient.invalidateQueries({ queryKey: ['internships'] }));

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase opacity-60">Internships</h3>
      {data?.map((entry) => (
        <EntryRow
          key={entry.id}
          label={entry.company}
          sublabel={entry.year ? `${entry.year}` : ''}
          required={entry.required}
          onToggleRequired={() => toggleRequired(entry)}
          onDelete={() => remove(entry.id)}
        />
      ))}
      <div className="grid grid-cols-4 gap-2">
        <input
          className="border rounded px-2 py-1 text-sm bg-transparent col-span-3"
          placeholder="Company"
          value={form.company}
          onChange={(e) => setForm({ ...form, company: e.target.value })}
        />
        <input
          className="border rounded px-2 py-1 text-sm bg-transparent"
          placeholder="Year"
          value={form.year}
          onChange={(e) => setForm({ ...form, year: e.target.value })}
        />
        <label className="flex items-center gap-1 text-xs col-span-4 cursor-pointer">
          <input
            type="checkbox"
            checked={form.required}
            onChange={(e) => setForm({ ...form, required: e.target.checked })}
          />
          Required
        </label>
        <button
          className="col-span-4 px-2 py-1 text-sm rounded border"
          onClick={() => create.mutate()}
          disabled={!form.company || create.isPending}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function ProjectList() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });
  const [form, setForm] = useState({
    name: '',
    repoUrl: '',
    liveUrl: '',
    year: '',
    required: false,
  });

  const create = useMutation({
    mutationFn: () =>
      api.createProject({
        name: form.name,
        repoUrl: form.repoUrl || undefined,
        liveUrl: form.liveUrl || undefined,
        year: form.year ? Number(form.year) : undefined,
        required: form.required,
      }),
    onSuccess: () => {
      setForm({ name: '', repoUrl: '', liveUrl: '', year: '', required: false });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const toggleRequired = (entry: ProjectEntry) =>
    api
      .updateProject(entry.id, { required: !entry.required })
      .then(() => queryClient.invalidateQueries({ queryKey: ['projects'] }));

  const remove = (id: string) =>
    api.deleteProject(id).then(() => queryClient.invalidateQueries({ queryKey: ['projects'] }));

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase opacity-60">Projects</h3>
      {data?.map((entry) => (
        <EntryRow
          key={entry.id}
          label={entry.name}
          sublabel={[entry.repoUrl, entry.liveUrl, entry.year ? `${entry.year}` : '']
            .filter(Boolean)
            .join(' · ')}
          required={entry.required}
          onToggleRequired={() => toggleRequired(entry)}
          onDelete={() => remove(entry.id)}
        />
      ))}
      <div className="grid grid-cols-4 gap-2">
        <input
          className="border rounded px-2 py-1 text-sm bg-transparent col-span-2"
          placeholder="Project name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <input
          className="border rounded px-2 py-1 text-sm bg-transparent col-span-2"
          placeholder="Repo URL"
          value={form.repoUrl}
          onChange={(e) => setForm({ ...form, repoUrl: e.target.value })}
        />
        <input
          className="border rounded px-2 py-1 text-sm bg-transparent col-span-3"
          placeholder="Live link"
          value={form.liveUrl}
          onChange={(e) => setForm({ ...form, liveUrl: e.target.value })}
        />
        <input
          className="border rounded px-2 py-1 text-sm bg-transparent"
          placeholder="Year"
          value={form.year}
          onChange={(e) => setForm({ ...form, year: e.target.value })}
        />
        <label className="flex items-center gap-1 text-xs col-span-4 cursor-pointer">
          <input
            type="checkbox"
            checked={form.required}
            onChange={(e) => setForm({ ...form, required: e.target.checked })}
          />
          Required
        </label>
        <button
          className="col-span-4 px-2 py-1 text-sm rounded border"
          onClick={() => create.mutate()}
          disabled={!form.name || create.isPending}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function EntryRow({
  label,
  sublabel,
  required,
  onToggleRequired,
  onDelete,
}: {
  label: string;
  sublabel: string;
  required: boolean;
  onToggleRequired: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center justify-between border rounded px-3 py-2 text-sm">
      <div className="flex flex-col">
        <span>{label}</span>
        {sublabel && <span className="text-xs opacity-60">{sublabel}</span>}
      </div>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1 text-xs cursor-pointer">
          <input type="checkbox" checked={required} onChange={onToggleRequired} />
          Required
        </label>
        <button className="text-xs text-red-600 dark:text-red-400" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}
