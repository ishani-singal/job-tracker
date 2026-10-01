'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  EducationEntry,
  InternshipEntry,
  ProjectEntry,
  StoryEntryType,
  WorkExperienceEntry,
} from '@job-tracker/shared-types';
import {
  DateRangeFields,
  DateRangeFormState,
  EMPTY_DATE_RANGE,
  dateRangeToPayload,
  formatEntryDateRange,
} from './date-range-fields';

/** entryId -> number of sources (Stories/Resume files + connected repos)
 * tagged to it — cheap to compute (no LLM call), unlike the actual
 * narrative text, which is only extracted live at generation/preview time
 * (see SourceCountBadge's "Preview" button). */
type SourceCountMap = Map<string, number>;

function useSourceCountMap(entryType: StoryEntryType): SourceCountMap {
  const { data: storyFiles } = useQuery({ queryKey: ['stories'], queryFn: api.listStories });
  const { data: resumeFiles } = useQuery({ queryKey: ['resume-files'], queryFn: api.listResumeFiles });
  const { data: repos } = useQuery({ queryKey: ['github-connected-repos'], queryFn: api.listConnectedRepos });

  const map: SourceCountMap = new Map();
  const bump = (entryId: string) => map.set(entryId, (map.get(entryId) ?? 0) + 1);
  for (const f of storyFiles ?? []) if (f.entryType === entryType) bump(f.entryId);
  for (const f of resumeFiles ?? []) if (f.entryType === entryType) bump(f.entryId);
  for (const r of repos ?? []) if (r.entryType === entryType) bump(r.entryId);
  return map;
}

export function EntriesSection() {
  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="text-sm font-medium">Background</h2>
        <p className="text-xs opacity-60">
          Curate your work experience, education, internships, and projects once. Mark an
          entry &quot;Required&quot; to have it always included in generated resumes;
          unchecked entries are included only when they&apos;re relevant to the specific job
          being tailored for. Tag a Stories/Resume file or connected GitHub repo to an entry
          (when uploading/connecting) to give it content — resume generation reads that
          source&apos;s raw text live, extracted fresh the first time it&apos;s needed and
          cached after that.
        </p>
      </div>
      <WorkExperienceList />
      <EducationList />
      <InternshipList />
      <ProjectList />
    </section>
  );
}

// ---------- Work Experience ----------

interface WorkExperienceForm extends DateRangeFormState {
  company: string;
  title: string;
  isFamilyBusiness: boolean;
  required: boolean;
}

const EMPTY_WORK_FORM: WorkExperienceForm = {
  ...EMPTY_DATE_RANGE,
  company: '',
  title: '',
  isFamilyBusiness: false,
  required: true,
};

function workExperienceToForm(e: WorkExperienceEntry): WorkExperienceForm {
  return {
    company: e.company,
    title: e.title ?? '',
    location: e.location ?? '',
    startMonth: e.startMonth ? String(e.startMonth) : '',
    startYear: e.startYear ? String(e.startYear) : '',
    endMonth: e.endMonth ? String(e.endMonth) : '',
    endYear: e.endYear ? String(e.endYear) : '',
    isPresent: e.isPresent,
    isFamilyBusiness: e.isFamilyBusiness,
    required: e.required,
  };
}

function WorkExperienceList() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['work-experience'], queryFn: api.listWorkExperience });
  const sourceCounts = useSourceCountMap('WORK_EXPERIENCE');
  const [form, setForm] = useState<WorkExperienceForm>(EMPTY_WORK_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['work-experience'] });

  const create = useMutation({
    mutationFn: () =>
      api.createWorkExperience({
        company: form.company,
        title: form.title || undefined,
        isFamilyBusiness: form.isFamilyBusiness,
        required: form.required,
        ...dateRangeToPayload(form),
      }),
    onSuccess: () => {
      setForm(EMPTY_WORK_FORM);
      invalidate();
    },
  });

  const update = useMutation({
    mutationFn: () =>
      api.updateWorkExperience(editingId!, {
        company: form.company,
        title: form.title || undefined,
        isFamilyBusiness: form.isFamilyBusiness,
        required: form.required,
        ...dateRangeToPayload(form),
      }),
    onSuccess: () => {
      setForm(EMPTY_WORK_FORM);
      setEditingId(null);
      invalidate();
    },
  });

  const toggleRequired = (entry: WorkExperienceEntry) =>
    api.updateWorkExperience(entry.id, { required: !entry.required }).then(invalidate);

  const remove = (id: string) => api.deleteWorkExperience(id).then(invalidate);

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase opacity-60">Work Experience</h3>
      {data?.map((entry) => (
        <EntryRow
          key={entry.id}
          label={`${entry.company}${entry.title ? ` — ${entry.title}` : ''}`}
          sublabel={[
            entry.location,
            formatEntryDateRange(entry),
            entry.isFamilyBusiness ? 'Family Business' : '',
          ]
            .filter(Boolean)
            .join(' · ')}
          required={entry.required}
          onToggleRequired={() => toggleRequired(entry)}
          onEdit={() => {
            setEditingId(entry.id);
            setForm(workExperienceToForm(entry));
          }}
          onDelete={() => remove(entry.id)}
          entryType="WORK_EXPERIENCE"
          entryId={entry.id}
          entryLabel={`${entry.company}${entry.title ? ` — ${entry.title}` : ''}`}
          sourceCount={sourceCounts.get(entry.id) ?? 0}
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
        <DateRangeFields form={form} onChange={setForm} />
        <label className="flex items-center gap-1 text-xs col-span-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.required}
            onChange={(e) => setForm({ ...form, required: e.target.checked })}
          />
          Required
        </label>
        <label className="flex items-center gap-1 text-xs col-span-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.isFamilyBusiness}
            onChange={(e) => setForm({ ...form, isFamilyBusiness: e.target.checked })}
          />
          Family Business
        </label>
        <FormButtons
          editing={!!editingId}
          disabled={!form.company}
          onSubmit={() => (editingId ? update.mutate() : create.mutate())}
          onCancel={() => {
            setEditingId(null);
            setForm(EMPTY_WORK_FORM);
          }}
        />
      </div>
    </div>
  );
}

// ---------- Education ----------

interface EducationForm extends DateRangeFormState {
  school: string;
  degree: string;
  field: string;
  required: boolean;
}

const EMPTY_EDUCATION_FORM: EducationForm = {
  ...EMPTY_DATE_RANGE,
  school: '',
  degree: '',
  field: '',
  required: true,
};

function educationToForm(e: EducationEntry): EducationForm {
  return {
    school: e.school,
    degree: e.degree ?? '',
    field: e.field ?? '',
    location: e.location ?? '',
    startMonth: e.startMonth ? String(e.startMonth) : '',
    startYear: e.startYear ? String(e.startYear) : '',
    endMonth: e.endMonth ? String(e.endMonth) : '',
    endYear: e.endYear ? String(e.endYear) : '',
    isPresent: e.isPresent,
    required: e.required,
  };
}

function EducationList() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['education'], queryFn: api.listEducation });
  const sourceCounts = useSourceCountMap('EDUCATION');
  const [form, setForm] = useState<EducationForm>(EMPTY_EDUCATION_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['education'] });

  const create = useMutation({
    mutationFn: () =>
      api.createEducation({
        school: form.school,
        degree: form.degree || undefined,
        field: form.field || undefined,
        required: form.required,
        ...dateRangeToPayload(form),
      }),
    onSuccess: () => {
      setForm(EMPTY_EDUCATION_FORM);
      invalidate();
    },
  });

  const update = useMutation({
    mutationFn: () =>
      api.updateEducation(editingId!, {
        school: form.school,
        degree: form.degree || undefined,
        field: form.field || undefined,
        required: form.required,
        ...dateRangeToPayload(form),
      }),
    onSuccess: () => {
      setForm(EMPTY_EDUCATION_FORM);
      setEditingId(null);
      invalidate();
    },
  });

  const toggleRequired = (entry: EducationEntry) =>
    api.updateEducation(entry.id, { required: !entry.required }).then(invalidate);

  const remove = (id: string) => api.deleteEducation(id).then(invalidate);

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase opacity-60">Education</h3>
      {data?.map((entry) => (
        <EntryRow
          key={entry.id}
          label={`${entry.school}${entry.degree ? ` — ${entry.degree}` : ''}${entry.field ? ` in ${entry.field}` : ''}`}
          sublabel={[entry.location, formatEntryDateRange(entry)].filter(Boolean).join(' · ')}
          required={entry.required}
          onToggleRequired={() => toggleRequired(entry)}
          onEdit={() => {
            setEditingId(entry.id);
            setForm(educationToForm(entry));
          }}
          onDelete={() => remove(entry.id)}
          entryType="EDUCATION"
          entryId={entry.id}
          entryLabel={`${entry.school}${entry.degree ? ` — ${entry.degree}` : ''}`}
          sourceCount={sourceCounts.get(entry.id) ?? 0}
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
          placeholder="Field of study"
          value={form.field}
          onChange={(e) => setForm({ ...form, field: e.target.value })}
        />
        <DateRangeFields form={form} onChange={setForm} />
        <label className="flex items-center gap-1 text-xs col-span-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.required}
            onChange={(e) => setForm({ ...form, required: e.target.checked })}
          />
          Required
        </label>
        <FormButtons
          editing={!!editingId}
          disabled={!form.school}
          onSubmit={() => (editingId ? update.mutate() : create.mutate())}
          onCancel={() => {
            setEditingId(null);
            setForm(EMPTY_EDUCATION_FORM);
          }}
        />
      </div>
    </div>
  );
}

// ---------- Internships ----------

interface InternshipForm extends DateRangeFormState {
  company: string;
  title: string;
  isClassProject: boolean;
  isFamilyBusiness: boolean;
  required: boolean;
}

const EMPTY_INTERNSHIP_FORM: InternshipForm = {
  ...EMPTY_DATE_RANGE,
  company: '',
  title: '',
  isClassProject: false,
  isFamilyBusiness: false,
  required: false,
};

function internshipToForm(e: InternshipEntry): InternshipForm {
  return {
    company: e.company,
    title: e.title ?? '',
    location: e.location ?? '',
    startMonth: e.startMonth ? String(e.startMonth) : '',
    startYear: e.startYear ? String(e.startYear) : '',
    endMonth: e.endMonth ? String(e.endMonth) : '',
    endYear: e.endYear ? String(e.endYear) : '',
    isPresent: e.isPresent,
    isClassProject: e.isClassProject,
    isFamilyBusiness: e.isFamilyBusiness,
    required: e.required,
  };
}

function InternshipList() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['internships'], queryFn: api.listInternships });
  const sourceCounts = useSourceCountMap('INTERNSHIP');
  const [form, setForm] = useState<InternshipForm>(EMPTY_INTERNSHIP_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['internships'] });

  const create = useMutation({
    mutationFn: () =>
      api.createInternship({
        company: form.company,
        title: form.title || undefined,
        isClassProject: form.isClassProject,
        isFamilyBusiness: form.isFamilyBusiness,
        required: form.required,
        ...dateRangeToPayload(form),
      }),
    onSuccess: () => {
      setForm(EMPTY_INTERNSHIP_FORM);
      invalidate();
    },
  });

  const update = useMutation({
    mutationFn: () =>
      api.updateInternship(editingId!, {
        company: form.company,
        title: form.title || undefined,
        isClassProject: form.isClassProject,
        isFamilyBusiness: form.isFamilyBusiness,
        required: form.required,
        ...dateRangeToPayload(form),
      }),
    onSuccess: () => {
      setForm(EMPTY_INTERNSHIP_FORM);
      setEditingId(null);
      invalidate();
    },
  });

  const toggleRequired = (entry: InternshipEntry) =>
    api.updateInternship(entry.id, { required: !entry.required }).then(invalidate);

  const remove = (id: string) => api.deleteInternship(id).then(invalidate);

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase opacity-60">Internships</h3>
      {data?.map((entry) => (
        <EntryRow
          key={entry.id}
          label={`${entry.company}${entry.title ? ` — ${entry.title}` : ''}`}
          sublabel={[
            entry.location,
            formatEntryDateRange(entry),
            entry.isClassProject ? 'Class Project' : '',
            entry.isFamilyBusiness ? 'Family Business' : '',
          ]
            .filter(Boolean)
            .join(' · ')}
          required={entry.required}
          onToggleRequired={() => toggleRequired(entry)}
          onEdit={() => {
            setEditingId(entry.id);
            setForm(internshipToForm(entry));
          }}
          onDelete={() => remove(entry.id)}
          entryType="INTERNSHIP"
          entryId={entry.id}
          entryLabel={`${entry.company}${entry.title ? ` — ${entry.title}` : ''}`}
          sourceCount={sourceCounts.get(entry.id) ?? 0}
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
        <DateRangeFields form={form} onChange={setForm} />
        <label className="flex items-center gap-1 text-xs col-span-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.isClassProject}
            onChange={(e) => setForm({ ...form, isClassProject: e.target.checked })}
          />
          Class Project
        </label>
        <label className="flex items-center gap-1 text-xs col-span-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.isFamilyBusiness}
            onChange={(e) => setForm({ ...form, isFamilyBusiness: e.target.checked })}
          />
          Family Business
        </label>
        <label className="flex items-center gap-1 text-xs col-span-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.required}
            onChange={(e) => setForm({ ...form, required: e.target.checked })}
          />
          Required
        </label>
        <FormButtons
          editing={!!editingId}
          disabled={!form.company}
          onSubmit={() => (editingId ? update.mutate() : create.mutate())}
          onCancel={() => {
            setEditingId(null);
            setForm(EMPTY_INTERNSHIP_FORM);
          }}
        />
      </div>
    </div>
  );
}

// ---------- Projects ----------

interface ProjectForm extends DateRangeFormState {
  name: string;
  repoUrl: string;
  liveUrl: string;
  required: boolean;
}

const EMPTY_PROJECT_FORM: ProjectForm = {
  ...EMPTY_DATE_RANGE,
  name: '',
  repoUrl: '',
  liveUrl: '',
  required: false,
};

function projectToForm(e: ProjectEntry): ProjectForm {
  return {
    name: e.name,
    repoUrl: e.repoUrl ?? '',
    liveUrl: e.liveUrl ?? '',
    location: e.location ?? '',
    startMonth: e.startMonth ? String(e.startMonth) : '',
    startYear: e.startYear ? String(e.startYear) : '',
    endMonth: e.endMonth ? String(e.endMonth) : '',
    endYear: e.endYear ? String(e.endYear) : '',
    isPresent: e.isPresent,
    required: e.required,
  };
}

function ProjectList() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });
  const sourceCounts = useSourceCountMap('PROJECT');
  const { data: connectedRepos } = useQuery({
    queryKey: ['github-connected-repos'],
    queryFn: api.listConnectedRepos,
  });
  const [form, setForm] = useState<ProjectForm>(EMPTY_PROJECT_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['projects'] });

  const create = useMutation({
    mutationFn: () =>
      api.createProject({
        name: form.name,
        repoUrl: form.repoUrl || undefined,
        liveUrl: form.liveUrl || undefined,
        required: form.required,
        ...dateRangeToPayload(form),
      }),
    onSuccess: () => {
      setForm(EMPTY_PROJECT_FORM);
      invalidate();
    },
  });

  const update = useMutation({
    mutationFn: () =>
      api.updateProject(editingId!, {
        name: form.name,
        repoUrl: form.repoUrl || undefined,
        liveUrl: form.liveUrl || undefined,
        required: form.required,
        ...dateRangeToPayload(form),
      }),
    onSuccess: () => {
      setForm(EMPTY_PROJECT_FORM);
      setEditingId(null);
      invalidate();
    },
  });

  const toggleRequired = (entry: ProjectEntry) =>
    api.updateProject(entry.id, { required: !entry.required }).then(invalidate);

  const remove = (id: string) => api.deleteProject(id).then(invalidate);

  const hasConnectedRepos = (connectedRepos?.length ?? 0) > 0;

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase opacity-60">Projects</h3>
      {data?.map((entry) => (
        <EntryRow
          key={entry.id}
          label={entry.name}
          sublabel={[entry.repoUrl, entry.liveUrl, entry.location, formatEntryDateRange(entry)]
            .filter(Boolean)
            .join(' · ')}
          required={entry.required}
          onToggleRequired={() => toggleRequired(entry)}
          onEdit={() => {
            setEditingId(entry.id);
            setForm(projectToForm(entry));
          }}
          onDelete={() => remove(entry.id)}
          entryType="PROJECT"
          entryId={entry.id}
          entryLabel={entry.name}
          sourceCount={sourceCounts.get(entry.id) ?? 0}
        />
      ))}
      <div className="grid grid-cols-4 gap-2">
        <input
          className="border rounded px-2 py-1 text-sm bg-transparent col-span-2"
          placeholder="Project name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        {hasConnectedRepos ? (
          <select
            className="border rounded px-2 py-1 text-sm bg-transparent col-span-2"
            value={form.repoUrl}
            onChange={(e) => setForm({ ...form, repoUrl: e.target.value })}
          >
            <option value="">Repo (none)</option>
            {connectedRepos!.map((r) => (
              <option key={r.fullName} value={`https://github.com/${r.fullName}`}>
                {r.fullName}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="border rounded px-2 py-1 text-sm bg-transparent col-span-2"
            placeholder="Repo URL"
            value={form.repoUrl}
            onChange={(e) => setForm({ ...form, repoUrl: e.target.value })}
          />
        )}
        <input
          className="border rounded px-2 py-1 text-sm bg-transparent col-span-4"
          placeholder="Live link"
          value={form.liveUrl}
          onChange={(e) => setForm({ ...form, liveUrl: e.target.value })}
        />
        <DateRangeFields form={form} onChange={setForm} />
        <label className="flex items-center gap-1 text-xs col-span-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.required}
            onChange={(e) => setForm({ ...form, required: e.target.checked })}
          />
          Required
        </label>
        <FormButtons
          editing={!!editingId}
          disabled={!form.name}
          onSubmit={() => (editingId ? update.mutate() : create.mutate())}
          onCancel={() => {
            setEditingId(null);
            setForm(EMPTY_PROJECT_FORM);
          }}
        />
      </div>
    </div>
  );
}

// ---------- Shared ----------

function FormButtons({
  editing,
  disabled,
  onSubmit,
  onCancel,
}: {
  editing: boolean;
  disabled: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="col-span-4 flex gap-2">
      <button
        className="flex-1 px-2 py-1 text-sm rounded border"
        onClick={onSubmit}
        disabled={disabled}
      >
        {editing ? 'Save Changes' : 'Add'}
      </button>
      {editing && (
        <button className="px-2 py-1 text-sm rounded border" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}

function EntryRow({
  label,
  sublabel,
  required,
  onToggleRequired,
  onEdit,
  onDelete,
  entryType,
  entryId,
  entryLabel,
  sourceCount,
}: {
  label: string;
  sublabel: string;
  required: boolean;
  onToggleRequired: () => void;
  onEdit: () => void;
  onDelete: () => void;
  entryType: StoryEntryType;
  entryId: string;
  entryLabel: string;
  sourceCount: number;
}) {
  return (
    <div className="flex flex-col border rounded px-3 py-2 text-sm gap-1">
      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          <span>{label}</span>
          {sublabel && <span className="text-xs opacity-60">{sublabel}</span>}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1 text-xs cursor-pointer">
            <input type="checkbox" checked={required} onChange={onToggleRequired} />
            Required
          </label>
          <button className="text-xs opacity-70 hover:opacity-100" onClick={onEdit}>
            Edit
          </button>
          <button className="text-xs text-red-600 dark:text-red-400" onClick={onDelete}>
            Delete
          </button>
        </div>
      </div>
      <NarrativePreview entryType={entryType} entryId={entryId} entryLabel={entryLabel} sourceCount={sourceCount} />
    </div>
  );
}

/** Shows how many sources (Stories/Resume files + connected repos) are
 * tagged to this entry, with a button to extract/preview the actual
 * narrative on demand — this is a real LLM call (cached after the first
 * time), so it's never fetched eagerly for every entry on page load. */
function NarrativePreview({
  entryType,
  entryLabel,
  sourceCount,
  entryId,
}: {
  entryType: StoryEntryType;
  entryId: string;
  entryLabel: string;
  sourceCount: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const { data, isFetching, refetch } = useQuery({
    queryKey: ['narratives', entryType, entryId],
    queryFn: () => api.getNarrativesForEntry(entryType, entryId, entryLabel),
    enabled: false,
  });

  if (sourceCount === 0) {
    return (
      <p className="text-xs opacity-50 italic border-t pt-1">
        No Stories/Resume file or GitHub repo tagged to this entry yet — tag one when
        uploading/connecting to give it content for generation.
      </p>
    );
  }

  return (
    <div className="text-xs border-t pt-1">
      <div className="flex items-center justify-between">
        <span className="opacity-70">
          {sourceCount} source{sourceCount === 1 ? '' : 's'} tagged
        </span>
        <button
          className="opacity-70 hover:opacity-100 underline"
          onClick={() => {
            setExpanded(true);
            refetch();
          }}
          disabled={isFetching}
        >
          {isFetching ? 'Extracting...' : expanded ? 'Re-extract' : 'Preview'}
        </button>
      </div>
      {expanded && data && (
        <div className="mt-1 flex flex-col gap-1">
          {data.length === 0 && <p className="opacity-50 italic">No content extracted.</p>}
          {data.map((narrative, i) => (
            <p key={i} className="opacity-70 whitespace-pre-wrap">
              {narrative}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
