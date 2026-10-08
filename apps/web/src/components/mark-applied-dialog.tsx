'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import type { Application } from '@job-tracker/shared-types';
import { api } from '@/lib/api';

const NEW_CONTACT = '__new__';

export function MarkAppliedDialog({
  application,
  open,
  onOpenChange,
  onSaved,
}: {
  application: Application;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [appliedDate, setAppliedDate] = useState(new Date().toISOString().slice(0, 10));
  const [referred, setReferred] = useState(false);
  const [contactId, setContactId] = useState('');
  const [newContact, setNewContact] = useState({ name: '', linkedinUrl: '', email: '', phone: '' });
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: contacts } = useQuery({
    queryKey: ['application-contacts', application.id],
    queryFn: () => api.listApplicationContacts(application.id),
    enabled: open && referred,
  });
  const adding = contactId === NEW_CONTACT || (contacts?.length === 0 && referred);
  const canSave = !!appliedDate && (!referred || (adding ? !!newContact.name.trim() : !!contactId));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      let referrerId: string | null = null;
      if (referred) {
        referrerId = adding
          ? (await api.addApplicationContact(application.id, newContact)).id
          : contactId;
      }
      await api.updateApplication(application.id, {
        status: 'APPLIED',
        appliedDate,
        referredByContactId: referrerId,
      } as Partial<Application>);
      if (file) await api.uploadAppliedResume(application.id, file);
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const input = 'border rounded px-2 py-1 text-sm w-full bg-transparent';
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white dark:bg-neutral-900 rounded-lg p-6 w-[480px] max-h-[85vh] overflow-y-auto flex flex-col gap-3 text-sm">
          <Dialog.Title className="text-lg font-semibold">
            Mark applied — {application.company}
            {application.role ? ` · ${application.role}` : ''}
          </Dialog.Title>

          <label className="flex flex-col gap-1 text-xs opacity-80">
            Applied date
            <input type="date" className={input} value={appliedDate} onChange={(e) => setAppliedDate(e.target.value)} />
          </label>

          <label className="flex items-center gap-2">
            <input type="checkbox" checked={referred} onChange={(e) => setReferred(e.target.checked)} />
            I was referred
          </label>

          {referred && (
            <div className="flex flex-col gap-2 border rounded p-3">
              {contacts && contacts.length > 0 && (
                <select className={input} value={contactId} onChange={(e) => setContactId(e.target.value)}>
                  <option value="">Select a contact at {application.company}…</option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                  <option value={NEW_CONTACT}>+ Add a new contact</option>
                </select>
              )}
              {adding && (
                <div className="grid grid-cols-2 gap-2">
                  <input className={input} placeholder="Name *" value={newContact.name} onChange={(e) => setNewContact({ ...newContact, name: e.target.value })} />
                  <input className={input} placeholder="LinkedIn URL" value={newContact.linkedinUrl} onChange={(e) => setNewContact({ ...newContact, linkedinUrl: e.target.value })} />
                  <input className={input} placeholder="Email" value={newContact.email} onChange={(e) => setNewContact({ ...newContact, email: e.target.value })} />
                  <input className={input} placeholder="Phone" value={newContact.phone} onChange={(e) => setNewContact({ ...newContact, phone: e.target.value })} />
                </div>
              )}
            </div>
          )}

          <label className="flex flex-col gap-1 text-xs opacity-80">
            Resume you applied with (optional)
            <input
              type="file"
              accept=".pdf,.doc,.docx"
              className="text-sm"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>

          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex justify-end gap-2 mt-1">
            <button className="px-3 py-1 text-sm rounded border" onClick={() => onOpenChange(false)}>
              Cancel
            </button>
            <button
              className="px-3 py-1 text-sm rounded bg-black text-white dark:bg-white dark:text-black disabled:opacity-50"
              onClick={save}
              disabled={saving || !canSave}
            >
              {saving ? 'Saving...' : 'Mark applied'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
