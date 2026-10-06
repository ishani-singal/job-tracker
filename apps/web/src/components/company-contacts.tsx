'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useSessionsPanel } from '@/lib/sessions-panel-context';
import type {
  CompanyContact,
  ReferralRequest,
  ReferralTone,
  TrackedCompany,
} from '@job-tracker/shared-types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';
const MAX_ROLES = 3;
const TONES: { value: ReferralTone; label: string; hint: string }[] = [
  { value: 'friend', label: 'Friend', hint: 'Warm and casual' },
  { value: 'colleague', label: 'Colleague', hint: 'Friendly but professional' },
  { value: 'acquaintance', label: 'Acquaintance', hint: 'Polite, low-pressure' },
  { value: 'mentor', label: 'Mentor', hint: 'Respectful, appreciative' },
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
            s.score >= 90 ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'
          }`}
          title={s.missing.length ? `Gaps: ${s.missing.join(', ')}` : undefined}
        >
          {s.title}: {s.score}%
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
        <span>· {referral.roles.length} role(s)</span>
      </div>
      <ScoreChips scores={referral.scores} />
      {!referral.targetMet && referral.note && (
        <p className="text-xs text-amber-700 dark:text-amber-400">{referral.note}</p>
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
  const [tone, setTone] = useState<ReferralTone>('colleague');
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');

  const { data: allRoles } = useQuery({
    queryKey: ['discovered-roles', 'all'],
    queryFn: () => api.listDiscoveredRoles(),
  });
  const roles = useMemo(() => (allRoles ?? []).filter((r) => r.companyId === company.id), [allRoles, company.id]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = roles.filter((r) => !q || r.title.toLowerCase().includes(q));
    // Selected roles stay pinned at the top, whatever the search says.
    const pinned = roles.filter((r) => selected.includes(r.id));
    return [...pinned, ...matches.filter((r) => !selected.includes(r.id)).slice(0, 50)];
  }, [roles, search, selected]);

  const start = useMutation({
    mutationFn: () => api.startReferral(contact.id, tone, selected),
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
          </h2>
          <button className="px-2 py-1 text-xs rounded border" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="p-4 flex flex-col gap-4 overflow-y-auto">
          <div className="flex flex-col gap-1.5">
            <div className="text-xs font-medium uppercase opacity-60">How do you know {contact.name.split(' ')[0]}?</div>
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

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium uppercase opacity-60">
                Roles to link (pick up to {MAX_ROLES}) — {selected.length} selected
              </div>
              <input
                className="border rounded px-2 py-1 text-xs bg-transparent"
                placeholder="Search roles..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="border rounded max-h-64 overflow-y-auto divide-y">
              {visible.map((r) => {
                const checked = selected.includes(r.id);
                return (
                  <label
                    key={r.id}
                    className={`flex items-start gap-2 px-2 py-1.5 text-sm cursor-pointer ${
                      !checked && selected.length >= MAX_ROLES ? 'opacity-40' : ''
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={checked}
                      disabled={!checked && selected.length >= MAX_ROLES}
                      onChange={() => toggle(r.id)}
                    />
                    <span className="flex-1 min-w-0">
                      <span className="block truncate">{r.title}</span>
                      <span className="block text-xs opacity-60">
                        {r.postedDate ? `Posted ${new Date(r.postedDate).toLocaleDateString()}` : 'No posting date'}
                        {r.atsScore !== null && ` · ATS ${r.atsScore}%`}
                      </span>
                    </span>
                  </label>
                );
              })}
              {visible.length === 0 && (
                <p className="text-xs opacity-60 p-3">
                  {roles.length === 0 ? `No open roles found for ${company.name} yet — run a scan first.` : 'No roles match.'}
                </p>
              )}
            </div>
          </div>

          <p className="text-xs opacity-60">
            One resume will be generated to cover every selected role and checked against each job description
            for a 90% ATS match. If that isn&apos;t reachable you&apos;ll be told which role falls short. Progress
            shows in the chat panel.
          </p>
        </div>

        <div className="border-t p-3 flex items-center gap-2">
          <button
            className="px-3 py-1.5 text-sm rounded bg-black text-white dark:bg-white dark:text-black"
            onClick={() => start.mutate()}
            disabled={start.isPending || selected.length === 0}
          >
            {start.isPending ? 'Starting...' : 'Generate referral message'}
          </button>
          {start.error && <span className="text-xs text-red-600 dark:text-red-400">{start.error.message}</span>}
        </div>
      </div>
    </div>
  );
}
