'use client';

import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { api } from '@/lib/api';
import type { Application, ParsedJob } from '@job-tracker/shared-types';

interface FormState {
  company: string;
  role: string;
  jobUrl: string;
  jdText: string;
  postedDate: string;
  applyByDate: string;
  salaryRange: string;
  experienceLevel: string;
}

const EMPTY_FORM: FormState = {
  company: '',
  role: '',
  jobUrl: '',
  jdText: '',
  postedDate: '',
  applyByDate: '',
  salaryRange: '',
  experienceLevel: '',
};

function toFormState(app: Application): FormState {
  return {
    company: app.company,
    role: app.role ?? '',
    jobUrl: app.jobUrl ?? '',
    jdText: app.jdText ?? '',
    postedDate: app.postedDate ? app.postedDate.slice(0, 10) : '',
    applyByDate: app.applyByDate ? app.applyByDate.slice(0, 10) : '',
    salaryRange: app.salaryRange ?? '',
    experienceLevel: app.experienceLevel ?? '',
  };
}

interface Props {
  onSaved: () => void;
  /** Edit mode when provided — renders as a controlled dialog around existing data. */
  editApplication?: Application;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function AddApplicationDialog({ onSaved, editApplication, open, onOpenChange }: Props) {
  const isEditMode = !!editApplication;
  const [internalOpen, setInternalOpen] = useState(false);
  const dialogOpen = open ?? internalOpen;
  const setDialogOpen = onOpenChange ?? setInternalOpen;

  const [url, setUrl] = useState('');
  const [parsing, setParsing] = useState(false);
  const [parseFailed, setParseFailed] = useState(false);
  const [form, setForm] = useState<FormState>(editApplication ? toFormState(editApplication) : EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (editApplication) {
      setForm(toFormState(editApplication));
      setUrl(editApplication.jobUrl ?? '');
    }
  }, [editApplication]);

  async function handleParse() {
    if (!url) return;
    setParsing(true);
    setParseFailed(false);
    try {
      const parsed: ParsedJob = await api.parseJobUrl(url);
      setParseFailed(parsed.fetchFailed);
      setForm((prev) => ({
        ...prev,
        jobUrl: url,
        company: parsed.company ?? prev.company,
        role: parsed.role ?? prev.role,
        jdText: parsed.jdText ?? prev.jdText,
        postedDate: parsed.postedDate ?? prev.postedDate,
        applyByDate: parsed.applyByDate ?? prev.applyByDate,
        salaryRange: parsed.salaryRange ?? prev.salaryRange,
        experienceLevel: parsed.experienceLevel ?? prev.experienceLevel,
      }));
    } catch {
      setParseFailed(true);
      setForm((prev) => ({ ...prev, jobUrl: url }));
    } finally {
      setParsing(false);
    }
  }

  async function handleSubmit() {
    if (!form.company) return;
    setSubmitting(true);
    try {
      if (isEditMode) {
        await api.updateApplication(editApplication.id, form);
      } else {
        await api.createApplication(form);
        setForm(EMPTY_FORM);
        setUrl('');
      }
      setDialogOpen(false);
      onSaved();
    } finally {
      setSubmitting(false);
    }
  }

  const trigger = isEditMode ? null : (
    <Dialog.Trigger asChild>
      <button className="px-3 py-1.5 text-sm rounded bg-black text-white dark:bg-white dark:text-black">
        Add Application
      </button>
    </Dialog.Trigger>
  );

  return (
    <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
      {trigger}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white dark:bg-neutral-900 rounded-lg p-6 w-[520px] max-h-[85vh] overflow-y-auto flex flex-col gap-3">
          <Dialog.Title className="text-lg font-semibold">
            {isEditMode ? 'Edit Application' : 'Add Application'}
          </Dialog.Title>

          <div className="flex gap-2">
            <input
              className="flex-1 border rounded px-2 py-1 text-sm bg-transparent"
              placeholder="Paste job posting URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button
              className="px-3 py-1 text-sm rounded border"
              onClick={handleParse}
              disabled={parsing || !url}
            >
              {parsing ? 'Parsing...' : 'Parse'}
            </button>
          </div>
          {parseFailed && (
            <p className="text-xs text-amber-600">
              Couldn&apos;t auto-parse this posting — fill in the fields manually below.
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Company">
              <input
                className="border rounded px-2 py-1 text-sm w-full bg-transparent"
                value={form.company}
                onChange={(e) => setForm({ ...form, company: e.target.value })}
              />
            </Field>
            <Field label="Role / Title">
              <input
                className="border rounded px-2 py-1 text-sm w-full bg-transparent"
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Job Description">
            <textarea
              className="border rounded px-2 py-1 text-sm w-full h-24 bg-transparent"
              value={form.jdText}
              onChange={(e) => setForm({ ...form, jdText: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Posted Date">
              <input
                type="date"
                className="border rounded px-2 py-1 text-sm w-full bg-transparent"
                value={form.postedDate}
                onChange={(e) => setForm({ ...form, postedDate: e.target.value })}
              />
            </Field>
            <Field label="Apply By">
              <input
                type="date"
                className="border rounded px-2 py-1 text-sm w-full bg-transparent"
                value={form.applyByDate}
                onChange={(e) => setForm({ ...form, applyByDate: e.target.value })}
              />
            </Field>
            <Field label="Salary Range">
              <input
                className="border rounded px-2 py-1 text-sm w-full bg-transparent"
                value={form.salaryRange}
                onChange={(e) => setForm({ ...form, salaryRange: e.target.value })}
              />
            </Field>
            <Field label="Experience Level">
              <input
                className="border rounded px-2 py-1 text-sm w-full bg-transparent"
                value={form.experienceLevel}
                onChange={(e) => setForm({ ...form, experienceLevel: e.target.value })}
              />
            </Field>
          </div>

          <div className="flex justify-end gap-2 mt-2">
            <Dialog.Close asChild>
              <button className="px-3 py-1.5 text-sm rounded border">Cancel</button>
            </Dialog.Close>
            <button
              className="px-3 py-1.5 text-sm rounded bg-black text-white dark:bg-white dark:text-black"
              onClick={handleSubmit}
              disabled={submitting || !form.company}
            >
              {submitting ? 'Saving...' : isEditMode ? 'Save Changes' : 'Save Application'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
