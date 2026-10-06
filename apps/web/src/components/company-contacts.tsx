'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useSessionsPanel } from '@/lib/sessions-panel-context';
import {
  EXPERIENCE_FILTER_KEY,
  LOCATION_FILTER_KEY,
  usePersistedToggle,
  effectivePostedDate,
  hasInvalidCondition,
  isBeforeCutoff,
  matchesExcludeKeywordsFilter,
  matchesExperienceFilter,
  matchesLocationFilter,
  matchesLocationTextFilter,
} from '@/lib/role-filters';
import type {
  AppSettings,
  CompanyContact,
  DiscoveredRole,
  ReferralChannel,
  ReferralRequest,
  ReferralTone,
  TrackedCompany,
} from '@job-tracker/shared-types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';
const MAX_ROLES = 7;
const FINAL_ROLES = 5;
const TONES: { value: ReferralTone; label: string; hint: string }[] = [
  { value: 'friend', label: 'Friend', hint: 'Warm and casual' },
  { value: 'colleague', label: 'Colleague', hint: 'Friendly but professional' },
  { value: 'acquaintance', label: 'Acquaintance', hint: 'Polite, low-pressure' },
  { value: 'mentor', label: 'Mentor', hint: 'Respectful, appreciative' },
];

const CHANNELS: { value: ReferralChannel; label: string; needs: 'linkedinUrl' | 'phone' | 'email'; missing: string }[] = [
  { value: 'linkedin', label: 'LinkedIn', needs: 'linkedinUrl', missing: 'no LinkedIn saved' },
  { value: 'whatsapp', label: 'WhatsApp', needs: 'phone', missing: 'no phone saved' },
  { value: 'text', label: 'Text message', needs: 'phone', missing: 'no phone saved' },
  { value: 'email', label: 'Email', needs: 'email', missing: 'no email saved' },
];

type ContactDraft = { name: string; linkedinUrl: string; email: string; phone: string };
const EMPTY_DRAFT: ContactDraft = { name: '', linkedinUrl: '', email: '', phone: '' };

export function ContactsSection({ company }: { company: TrackedCompany }) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<ContactDraft>(EMPTY_DRAFT);

  const { data: contacts } = useQuery({
    queryKey: ['company-contacts', company.id],
    queryFn: () => api.listCompanyContacts(company.id),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['company-contacts', company.id] });
    queryClient.invalidateQueries({ queryKey: ['tracked-companies'] });
  };

  const addContact = useMutation({
    mutationFn: () =>
      api.createCompanyContact(company.id, {
        name: draft.name,
        linkedinUrl: draft.linkedinUrl,
        email: draft.email,
        phone: draft.phone,
      }),
    onSuccess: () => {
      setDraft(EMPTY_DRAFT);
      setAdding(false);
      refresh();
    },
  });

  return (
    <div className="border-t p-3 flex flex-col gap-3 bg-neutral-50 dark:bg-neutral-900">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase opacity-60">Contacts at {company.name}</h3>
        <button className="px-2 py-1 text-xs rounded border" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'Add contact'}
        </button>
      </div>

      {adding && (
        <ContactForm
          draft={draft}
          onChange={setDraft}
          onSubmit={() => addContact.mutate()}
          pending={addContact.isPending}
          submitLabel="Save contact"
          error={addContact.error?.message}
        />
      )}

      {contacts?.length === 0 && !adding && (
        <p className="text-xs opacity-60">
          No contacts yet. Add someone you know here to draft a referral request to them.
        </p>
      )}

      {contacts?.map((c) => (
        <ContactRow key={c.id} contact={c} company={company} onChanged={refresh} />
      ))}
    </div>
  );
}

function ContactForm({
  draft,
  onChange,
  onSubmit,
  pending,
  submitLabel,
  error,
}: {
  draft: ContactDraft;
  onChange: (d: ContactDraft) => void;
  onSubmit: () => void;
  pending: boolean;
  submitLabel: string;
  error?: string;
}) {
  const field = (key: keyof ContactDraft, placeholder: string) => (
    <input
      className="border rounded px-2 py-1 text-sm bg-transparent min-w-0"
      placeholder={placeholder}
      value={draft[key]}
      onChange={(e) => onChange({ ...draft, [key]: e.target.value })}
    />
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
        {field('name', 'Name *')}
        {field('linkedinUrl', 'LinkedIn URL')}
        {field('email', 'Email')}
        {field('phone', 'Phone')}
      </div>
      <div className="flex items-center gap-2">
        <button
          className="px-2 py-1 text-xs rounded bg-black text-white dark:bg-white dark:text-black"
          onClick={onSubmit}
          disabled={pending || !draft.name.trim()}
        >
          {pending ? 'Saving...' : submitLabel}
        </button>
        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
      </div>
    </div>
  );
}

function ContactRow({
  contact,
  company,
  onChanged,
}: {
  contact: CompanyContact;
  company: TrackedCompany;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [referralOpen, setReferralOpen] = useState(false);
  const [draft, setDraft] = useState<ContactDraft>({
    name: contact.name,
    linkedinUrl: contact.linkedinUrl ?? '',
    email: contact.email ?? '',
    phone: contact.phone ?? '',
  });

  const save = useMutation({
    mutationFn: () =>
      api.updateCompanyContact(contact.id, {
        name: draft.name,
        linkedinUrl: draft.linkedinUrl,
        email: draft.email,
        phone: draft.phone,
      }),
    onSuccess: () => {
      setEditing(false);
      onChanged();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteCompanyContact(contact.id),
    onSuccess: onChanged,
  });

  return (
    <div className="border rounded bg-white dark:bg-neutral-950">
      {editing ? (
        <div className="p-3 flex flex-col gap-2">
          <ContactForm
            draft={draft}
            onChange={setDraft}
            onSubmit={() => save.mutate()}
            pending={save.isPending}
            submitLabel="Save"
            error={save.error?.message}
          />
          <button className="px-2 py-1 text-xs rounded border w-fit" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-3 px-3 py-2 flex-wrap">
          <div className="flex-1 min-w-[12rem]">
            <div className="text-sm font-medium">{contact.name}</div>
            <div className="flex items-center gap-3 text-xs mt-0.5 flex-wrap">
              {contact.linkedinUrl && (
                <a
                  href={contact.linkedinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 dark:text-blue-400 hover:underline"
                >
                  LinkedIn
                </a>
              )}
              {contact.email && (
                <a href={`mailto:${contact.email}`} className="text-blue-600 dark:text-blue-400 hover:underline">
                  {contact.email}
                </a>
              )}
              {contact.phone && <span className="opacity-70">{contact.phone}</span>}
              {!contact.linkedinUrl && !contact.email && !contact.phone && (
                <span className="opacity-50">No contact details yet</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="px-2 py-1 text-xs rounded bg-black text-white dark:bg-white dark:text-black"
              onClick={() => setReferralOpen(true)}
            >
              Referral message
            </button>
            {contact.referrals.length > 0 && (
              <button className="px-2 py-1 text-xs rounded border" onClick={() => setShowHistory((v) => !v)}>
                {showHistory ? 'Hide' : 'History'} ({contact.referrals.length})
              </button>
            )}
            <button className="px-2 py-1 text-xs rounded border" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              className="px-2 py-1 text-xs rounded border text-red-600 dark:text-red-400"
              onClick={() => {
                if (confirm(`Delete ${contact.name} and their referral history?`)) remove.mutate();
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}

      {showHistory && (
        <div className="border-t p-3 flex flex-col gap-3">
          {contact.referrals.map((r) => (
            <ReferralHistoryItem key={r.id} referral={r} />
          ))}
        </div>
      )}

      {referralOpen && (
        <ReferralDialog contact={contact} company={company} onClose={() => setReferralOpen(false)} />
      )}
    </div>
  );
}

export function ScoreChips({ scores }: { scores: ReferralRequest['scores'] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {scores.map((s) => (
        <span
          key={s.roleId}
          className={`text-xs rounded px-1.5 py-0.5 border ${
            s.dropped
              ? 'opacity-50 line-through'
              : s.score >= 90
                ? 'text-green-700 dark:text-green-400'
                : 'text-amber-700 dark:text-amber-400'
          }`}
          title={s.dropped ? 'Dropped from the final set' : s.missing.length ? `Gaps: ${s.missing.join(', ')}` : undefined}
        >
          {s.title}: {s.score}%{s.dropped ? ' (dropped)' : ''}
        </span>
      ))}
    </div>
  );
}

function ReferralHistoryItem({ referral }: { referral: ReferralRequest }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <div className="flex items-center gap-2 text-xs opacity-70 flex-wrap">
        <span>{new Date(referral.createdAt).toLocaleString()}</span>
        <span>· {referral.tone} tone</span>
        {referral.channel && <span>· {referral.channel}</span>}
        <span>· {referral.roles.length} role(s)</span>
      </div>
      <ScoreChips scores={referral.scores} />
      {referral.note && (
        <p className={`text-xs ${referral.targetMet ? 'opacity-70' : 'text-amber-700 dark:text-amber-400'}`}>
          {referral.note}
        </p>
      )}
      <pre className="whitespace-pre-wrap text-sm border rounded p-2 font-sans">{referral.message}</pre>
      <div className="flex items-center gap-2">
        <button
          className="px-2 py-1 text-xs rounded border"
          onClick={() => {
            navigator.clipboard?.writeText(referral.message).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy message'}
        </button>
        <a href={`${API_BASE}/referrals/${referral.id}/resume.pdf`} className="px-2 py-1 text-xs rounded border">
          Resume PDF
        </a>
        <a href={`${API_BASE}/referrals/${referral.id}/resume.docx`} className="px-2 py-1 text-xs rounded border">
          Resume Word
        </a>
      </div>
    </div>
  );
}

function ReferralDialog({
  contact,
  company,
  onClose,
}: {
  contact: CompanyContact;
  company: TrackedCompany;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { openPanel } = useSessionsPanel();
  const [step, setStep] = useState<'roles' | 'details'>('roles');
  const [tone, setTone] = useState<ReferralTone>('colleague');
  const [channel, setChannel] = useState<ReferralChannel>(
    () => CHANNELS.find((c) => contact[c.needs])?.value ?? 'email',
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  // Same location/experience toggles the Applications page has on.
  const [locationFilterOn] = usePersistedToggle(LOCATION_FILTER_KEY, true);
  const [experienceFilterOn] = usePersistedToggle(EXPERIENCE_FILTER_KEY, true);

  const { data: allRoles } = useQuery({
    queryKey: ['discovered-roles', 'all'],
    queryFn: () => api.listDiscoveredRoles(),
  });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: api.getProfile });
  // Same saved "Location contains" filter as the Applications page; edits here
  // write through to it. Held locally while typing so the list responds at once.
  const [locationText, setLocationText] = useState<string | null>(null);
  const locationTextValue = locationText ?? settings?.locationTextFilter ?? '';
  const updateSettings = useMutation({
    mutationFn: (data: Partial<AppSettings>) => api.updateSettings(data),
    onSuccess: (updated) => queryClient.setQueryData(['settings'], updated),
  });

  const refreshRoles = () => queryClient.invalidateQueries({ queryKey: ['discovered-roles'] });
  const rescore = useMutation({ mutationFn: (id: string) => api.rescoreRole(id), onSuccess: refreshRoles });
  const discard = useMutation({
    mutationFn: (id: string) => api.discardRole(id),
    onSuccess: (_, id) => {
      setSelected((cur) => cur.filter((x) => x !== id));
      refreshRoles();
    },
  });

  // The same lists the Applications page shows under its current filters:
  // open (unselected) roles go through every filter; roles already in
  // Applications only through the posted-date filter, as there. A discarded
  // role scores 0 and is always dropped, whichever filters are on.
  const filtered = useMemo(() => {
    if (!allRoles || !settings || !profile) return null;
    const excludeKeywords = settings.excludeKeywordsFilter
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    const minScore = settings.minMatchScoreFilter;
    const withinDays = Math.max(0, settings.postedWithinDaysFilter);
    return allRoles.filter((r) => {
      if (r.companyId !== company.id || r.atsScore === 0) return false;
      const dateOk = !settings.postedBeforeTodayFilterOn || !isBeforeCutoff(effectivePostedDate(r), withinDays);
      const locationTextOk = matchesLocationTextFilter(r, locationTextValue);
      if (r.applicationId) return dateOk && locationTextOk;
      return (
        dateOk &&
        (minScore == null || r.atsScore === null || r.atsScore >= minScore) &&
        (!settings.hideInvalidConditionRolesFilterOn || !hasInvalidCondition(r, profile)) &&
        (!locationFilterOn || matchesLocationFilter(r, profile)) &&
        (!experienceFilterOn || matchesExperienceFilter(r, profile)) &&
        matchesExcludeKeywordsFilter(r, excludeKeywords) &&
        locationTextOk
      );
    });
  }, [allRoles, settings, profile, company.id, locationFilterOn, experienceFilterOn, locationTextValue]);

  const visible = useMemo(() => {
    if (!filtered) return [];
    const q = search.trim().toLowerCase();
    // Selected roles stay pinned at the top, whatever the search says.
    const pinned = filtered.filter((r) => selected.includes(r.id));
    const rest = filtered.filter((r) => !selected.includes(r.id) && (!q || r.title.toLowerCase().includes(q)));
    return [...pinned, ...rest];
  }, [filtered, search, selected]);

  const chosen = (filtered ?? []).filter((r) => selected.includes(r.id));

  const start = useMutation({
    mutationFn: () =>
      api.startReferral(
        contact.id,
        tone,
        channel,
        chosen.map((r) => r.id),
      ),
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['company-contacts', company.id] });
      openPanel(session.id);
      onClose();
    },
  });

  const toggle = (id: string) =>
    setSelected((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= MAX_ROLES ? cur : [...cur, id],
    );

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white dark:bg-neutral-900 rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between border-b p-3">
          <h2 className="text-sm font-medium">
            Referral message for {contact.name} at {company.name}
            <span className="ml-2 text-xs opacity-60">Step {step === 'roles' ? 1 : 2} of 2</span>
          </h2>
          <button className="px-2 py-1 text-xs rounded border" onClick={onClose}>
            Close
          </button>
        </div>

        {step === 'roles' ? (
          <>
            <div className="p-4 flex flex-col gap-2 overflow-y-auto">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium uppercase opacity-60">
                  Pick up to {MAX_ROLES} roles — {chosen.length} selected
                </div>
                <input
                  className="border rounded px-2 py-1 text-xs bg-transparent"
                  placeholder="Search roles..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <label className="flex items-center gap-1.5 text-xs opacity-70">
                Location contains
                <input
                  type="text"
                  placeholder="e.g. Seattle, Remote (any of); roles with no location still show"
                  className="flex-1 min-w-0 border rounded px-1.5 py-0.5 bg-transparent"
                  value={locationTextValue}
                  onChange={(e) => {
                    setLocationText(e.target.value);
                    updateSettings.mutate({ locationTextFilter: e.target.value });
                  }}
                />
              </label>
              <div className="border rounded max-h-96 overflow-y-auto divide-y">
                {filtered === null && <p className="text-xs opacity-60 p-3">Loading roles...</p>}
                {visible.map((r) => (
                  <RolePickRow
                    key={r.id}
                    role={r}
                    checked={selected.includes(r.id)}
                    disabled={!selected.includes(r.id) && selected.length >= MAX_ROLES}
                    onToggle={() => toggle(r.id)}
                    onScore={() => rescore.mutate(r.id)}
                    scoring={rescore.isPending && rescore.variables === r.id}
                    onDiscard={() => discard.mutate(r.id)}
                    discarding={discard.isPending && discard.variables === r.id}
                  />
                ))}
                {filtered !== null && visible.length === 0 && (
                  <p className="text-xs opacity-60 p-3">
                    {filtered.length === 0
                      ? `No open roles for ${company.name} pass your current filters — run a scan or loosen the filters on the Applications page.`
                      : 'No roles match.'}
                  </p>
                )}
              </div>
              {(rescore.error || discard.error) && (
                <p className="text-xs text-red-600 dark:text-red-400">
                  {(rescore.error ?? discard.error)?.message}
                </p>
              )}
              <p className="text-xs opacity-60">
                The final message links {FINAL_ROLES} roles. Pick up to {MAX_ROLES} and the weakest fits are dropped
                automatically after the ATS check to help the rest reach 90%. Same filters as the Applications page;
                unscored roles can be scored here, and discard removes a role you don&apos;t want.
              </p>
            </div>
            <div className="border-t p-3 flex items-center gap-2">
              <button
                className="px-3 py-1.5 text-sm rounded bg-black text-white dark:bg-white dark:text-black"
                onClick={() => setStep('details')}
                disabled={chosen.length === 0}
              >
                Next
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="p-4 flex flex-col gap-4 overflow-y-auto">
              <div className="flex flex-col gap-1.5">
                <div className="text-xs font-medium uppercase opacity-60">Where will you send it?</div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {CHANNELS.map((c) => (
                    <label
                      key={c.value}
                      className={`border rounded px-2 py-1.5 text-sm cursor-pointer ${
                        channel === c.value ? 'border-black dark:border-white' : 'opacity-70'
                      }`}
                    >
                      <input
                        type="radio"
                        name="channel"
                        className="mr-1.5"
                        checked={channel === c.value}
                        onChange={() => setChannel(c.value)}
                      />
                      {c.label}
                      {!contact[c.needs] && <div className="text-xs opacity-60">{c.missing}</div>}
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="text-xs font-medium uppercase opacity-60">
                  How do you know {contact.name.split(' ')[0]}?
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {TONES.map((t) => (
                    <label
                      key={t.value}
                      className={`border rounded px-2 py-1.5 text-sm cursor-pointer ${
                        tone === t.value ? 'border-black dark:border-white' : 'opacity-70'
                      }`}
                    >
                      <input
                        type="radio"
                        name="tone"
                        className="mr-1.5"
                        checked={tone === t.value}
                        onChange={() => setTone(t.value)}
                      />
                      {t.label}
                      <div className="text-xs opacity-60">{t.hint}</div>
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <div className="text-xs font-medium uppercase opacity-60">
                  {chosen.length > FINAL_ROLES
                    ? `${chosen.length} candidate roles — the weakest ${chosen.length - FINAL_ROLES} will be dropped`
                    : `Linking ${chosen.length} role(s)`}
                </div>
                <ul className="text-sm list-disc pl-5">
                  {chosen.map((r) => (
                    <li key={r.id}>{r.title}</li>
                  ))}
                </ul>
              </div>

              <p className="text-xs opacity-60">
                One resume will be generated for these roles and checked against each job description for a 90% ATS
                match. If that isn&apos;t reachable you&apos;ll be told which roles fall short.
                Progress shows in the chat panel.
              </p>
            </div>
            <div className="border-t p-3 flex items-center gap-2">
              <button className="px-3 py-1.5 text-sm rounded border" onClick={() => setStep('roles')}>
                Back
              </button>
              <button
                className="px-3 py-1.5 text-sm rounded bg-black text-white dark:bg-white dark:text-black"
                onClick={() => start.mutate()}
                disabled={start.isPending || chosen.length === 0}
              >
                {start.isPending ? 'Starting...' : 'Generate referral message'}
              </button>
              {start.error && <span className="text-xs text-red-600 dark:text-red-400">{start.error.message}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RolePickRow({
  role,
  checked,
  disabled,
  onToggle,
  onScore,
  scoring,
  onDiscard,
  discarding,
}: {
  role: DiscoveredRole;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  onScore: () => void;
  scoring: boolean;
  onDiscard: () => void;
  discarding: boolean;
}) {
  const location = [role.roleCity, role.roleState, role.roleCountry].filter(Boolean).join(', ');
  const scoreColor =
    role.atsScore === null
      ? ''
      : role.atsScore >= 75
        ? 'text-green-600'
        : role.atsScore >= 50
          ? 'text-amber-600'
          : 'text-red-600';
  return (
    <div className={`flex items-start gap-2 px-2 py-1.5 text-sm ${disabled ? 'opacity-40' : ''}`}>
      <input type="checkbox" className="mt-1" checked={checked} disabled={disabled} onChange={onToggle} />
      <div className="flex-1 min-w-0">
        <div className="truncate">{role.title}</div>
        <div className="text-xs opacity-60">
          {role.applicationId ? 'In Applications · ' : ''}
          {role.postedDate ? `Posted ${new Date(role.postedDate).toLocaleDateString()}` : 'No posting date'}
          {role.roleIsRemote ? ' · Remote' : ''}
          {location && ` · ${location}`}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {role.atsScore !== null ? (
          <span className={`text-xs font-medium ${scoreColor}`}>{role.atsScore}% match</span>
        ) : (
          <button className="px-2 py-0.5 text-xs rounded border" onClick={onScore} disabled={scoring}>
            {scoring ? 'Scoring...' : 'Score'}
          </button>
        )}
        <button
          className="px-2 py-0.5 text-xs rounded border text-red-600 dark:text-red-400"
          onClick={onDiscard}
          disabled={discarding}
        >
          {discarding ? '...' : 'Discard'}
        </button>
      </div>
    </div>
  );
}
