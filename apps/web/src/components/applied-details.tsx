'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Application } from '@job-tracker/shared-types';
import { api } from '@/lib/api';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';
const NEW_CONTACT = '__new__';

/** Editable "Referred by" and "Resume applied with" for an applied application. */
export function AppliedDetails({ application }: { application: Application }) {
  const queryClient = useQueryClient();
  const [addingName, setAddingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: contacts } = useQuery({
    queryKey: ['application-contacts', application.id],
    queryFn: () => api.listApplicationContacts(application.id),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['applications'] });

  const setReferrer = useMutation({
    mutationFn: async (value: string) => {
      let referredByContactId: string | null = value || null;
      if (value === NEW_CONTACT) {
        referredByContactId = (await api.addApplicationContact(application.id, { name: (addingName ?? '').trim() })).id;
        queryClient.invalidateQueries({ queryKey: ['application-contacts', application.id] });
      }
      await api.updateApplication(application.id, { referredByContactId } as Partial<Application>);
    },
    onSuccess: () => {
      setAddingName(null);
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const uploadResume = useMutation({
    mutationFn: (file: File) => api.uploadAppliedResume(application.id, file),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const input = 'border rounded px-2 py-0.5 text-sm bg-transparent';
  return (
    <div className="text-sm flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="opacity-60">Referred by:</span>
        {addingName === null ? (
          <select
            className={input}
            value={application.referredByContactId ?? ''}
            disabled={setReferrer.isPending}
            onChange={(e) => (e.target.value === NEW_CONTACT ? setAddingName('') : setReferrer.mutate(e.target.value))}
          >
            <option value="">No referral</option>
            {contacts?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option value={NEW_CONTACT}>+ Add a new contact…</option>
          </select>
        ) : (
          <>
            <input
              className={input}
              placeholder="Contact name"
              autoFocus
              value={addingName}
              onChange={(e) => setAddingName(e.target.value)}
            />
            <button
              className="px-2 py-0.5 text-xs rounded border"
              disabled={!addingName.trim() || setReferrer.isPending}
              onClick={() => setReferrer.mutate(NEW_CONTACT)}
            >
              Add
            </button>
            <button className="px-2 py-0.5 text-xs rounded border" onClick={() => setAddingName(null)}>
              Cancel
            </button>
          </>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="opacity-60">Resume applied with:</span>
        {application.appliedResume ? (
          <a href={`${API_BASE}/applications/${application.id}/applied-resume`} className="underline">
            {application.appliedResume.filename}
          </a>
        ) : (
          <span>Not uploaded</span>
        )}
        <label className="px-2 py-0.5 text-xs rounded border cursor-pointer">
          {uploadResume.isPending ? 'Uploading...' : application.appliedResume ? 'Replace' : 'Upload'}
          <input
            type="file"
            accept=".pdf,.doc,.docx"
            className="hidden"
            disabled={uploadResume.isPending}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) uploadResume.mutate(file);
              e.target.value = '';
            }}
          />
        </label>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
