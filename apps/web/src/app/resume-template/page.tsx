'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ResumeTemplate } from '@job-tracker/shared-types';

type RangeField = {
  key: string;
  label: string;
  minKey: keyof ResumeTemplate;
  maxKey: keyof ResumeTemplate;
  hint?: string;
};

const RANGE_GROUPS: { title: string; step?: string; fields: RangeField[] }[] = [
  {
    title: 'Margins (inches)',
    step: '0.05',
    fields: [
      { key: 'marginTop', label: 'Top', minKey: 'marginTopMin', maxKey: 'marginTopMax' },
      { key: 'marginBottom', label: 'Bottom', minKey: 'marginBottomMin', maxKey: 'marginBottomMax' },
      { key: 'marginLeft', label: 'Left', minKey: 'marginLeftMin', maxKey: 'marginLeftMax' },
      { key: 'marginRight', label: 'Right', minKey: 'marginRightMin', maxKey: 'marginRightMax' },
    ],
  },
  {
    title: 'Fonts',
    fields: [
      {
        key: 'bulletFont',
        label: 'Bullet text size (pt)',
        minKey: 'bulletFontMin',
        maxKey: 'bulletFontMax',
        hint: 'Hard floor of 9pt is enforced regardless of what you set here.',
      },
      {
        key: 'nameFontOffset',
        label: 'Your name (header) size, offset above bullet size (pt)',
        minKey: 'nameFontOffsetMin',
        maxKey: 'nameFontOffsetMax',
        hint: 'Entry headers (e.g. "DELL TECHNOLOGIES | Program Manager") always match the bullet text size, just bold — this offset only affects your own name at the top of the resume.',
      },
      {
        key: 'sectionHeaderFontOffset',
        label: 'Section header size, offset above your name size (pt)',
        minKey: 'sectionHeaderFontOffsetMin',
        maxKey: 'sectionHeaderFontOffsetMax',
      },
    ],
  },
  {
    title: 'Spacing (points)',
    fields: [
      {
        key: 'spacingBeforeSection',
        label: 'Before each section',
        minKey: 'spacingBeforeSectionMin',
        maxKey: 'spacingBeforeSectionMax',
      },
      {
        key: 'spacingAfterSection',
        label: 'After section header',
        minKey: 'spacingAfterSectionMin',
        maxKey: 'spacingAfterSectionMax',
      },
      {
        key: 'spacingBetweenBullets',
        label: 'Between bullets',
        minKey: 'spacingBetweenBulletsMin',
        maxKey: 'spacingBetweenBulletsMax',
      },
    ],
  },
];

export default function ResumeTemplatePage() {
  const queryClient = useQueryClient();
  const { data: template } = useQuery({
    queryKey: ['resume-template'],
    queryFn: api.getResumeTemplate,
  });
  const [draft, setDraft] = useState<Partial<ResumeTemplate>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (template) setDraft(template);
  }, [template]);

  function setField(key: keyof ResumeTemplate, value: number) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    setSaving(true);
    try {
      const updated = await api.updateResumeTemplate(draft);
      queryClient.setQueryData(['resume-template'], updated);
    } catch (err) {
      alert(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  if (!template) return null;

  return (
    <div className="max-w-2xl mx-auto flex flex-col gap-8">
      <div>
        <h1 className="text-xl font-semibold">Resume Template</h1>
        <p className="text-sm opacity-70 mt-1">
          Every value below is a min/max range, not a fixed size. When a resume is downloaded
          as a PDF, the renderer picks the largest sizes and spacing within these ranges that
          still fit the content on one page, shrinking toward the minimums before it would ever
          cut content.
        </p>
      </div>

      {RANGE_GROUPS.map((group) => (
        <section key={group.title} className="flex flex-col gap-4">
          <h2 className="text-sm font-medium">{group.title}</h2>
          {group.fields.map((field) => (
            <div key={String(field.key)} className="flex flex-col gap-1">
              <label className="text-sm">{field.label}</label>
              {field.hint && <p className="text-xs opacity-60">{field.hint}</p>}
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  step={group.step ?? '0.5'}
                  className="w-24 border rounded px-2 py-1 text-sm bg-transparent"
                  value={draft[field.minKey] as number | undefined ?? ''}
                  onChange={(e) => setField(field.minKey, Number(e.target.value))}
                />
                <span className="text-xs opacity-60">to</span>
                <input
                  type="number"
                  step={group.step ?? '0.5'}
                  className="w-24 border rounded px-2 py-1 text-sm bg-transparent"
                  value={draft[field.maxKey] as number | undefined ?? ''}
                  onChange={(e) => setField(field.maxKey, Number(e.target.value))}
                />
              </div>
            </div>
          ))}
        </section>
      ))}

      <section className="flex flex-col gap-1">
        <label className="text-sm">Bullet indent / horizontal tab stop (pt)</label>
        <input
          type="number"
          step="1"
          className="w-24 border rounded px-2 py-1 text-sm bg-transparent"
          value={draft.horizontalTabStop ?? ''}
          onChange={(e) => setField('horizontalTabStop', Number(e.target.value))}
        />
      </section>

      <button
        className="self-start px-4 py-2 text-sm rounded bg-black text-white dark:bg-white dark:text-black disabled:opacity-50"
        disabled={saving}
        onClick={save}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
