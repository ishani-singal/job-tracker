'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Application } from '@job-tracker/shared-types';
import { api } from '@/lib/api';

const STATUSES = ['Screening', 'Interviewing', 'Offer', 'Rejected', 'Withdrawn'];

/** Hand-entered interview progress (rounds so far + status) for an applied application. */
export function InterviewProgress({ application }: { application: Application }) {
  const queryClient = useQueryClient();
  const [rounds, setRounds] = useState(application.interviewRounds?.toString() ?? '');

  async function save(patch: Partial<Application>) {
    await api.updateApplication(application.id, patch);
    queryClient.invalidateQueries({ queryKey: ['applications'] });
  }

  const input = 'border rounded px-1.5 py-0.5 text-xs bg-transparent';
  return (
    <div className="flex items-center gap-2 text-xs">
      <label className="flex items-center gap-1 opacity-80">
        Rounds
        <input
          type="number"
          min={0}
          className={`${input} w-14`}
          value={rounds}
          onChange={(e) => setRounds(e.target.value)}
          onBlur={() => {
            const n = rounds === '' ? null : Math.max(0, Math.floor(Number(rounds)));
            if (n !== (application.interviewRounds ?? null)) save({ interviewRounds: n });
          }}
        />
      </label>
      <select
        className={input}
        value={application.interviewStatus ?? ''}
        onChange={(e) => save({ interviewStatus: e.target.value || null })}
      >
        <option value="">Status…</option>
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </div>
  );
}
