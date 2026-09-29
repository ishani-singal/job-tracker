'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { AddApplicationDialog } from '@/components/add-application-dialog';
import { ApplicationRow } from '@/components/application-row';

export default function ApplicationsPage() {
  const queryClient = useQueryClient();
  const { data: applications, isLoading } = useQuery({
    queryKey: ['applications'],
    queryFn: api.listApplications,
  });

  return (
    <div className="max-w-5xl mx-auto flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Applications</h1>
        <AddApplicationDialog
          onSaved={() => queryClient.invalidateQueries({ queryKey: ['applications'] })}
        />
      </div>

      {isLoading && <p className="text-sm opacity-60">Loading...</p>}

      <div className="flex flex-col gap-2">
        {applications?.map((app) => (
          <ApplicationRow key={app.id} application={app} />
        ))}
        {applications?.length === 0 && (
          <p className="text-sm opacity-60">No applications yet — add one above.</p>
        )}
      </div>
    </div>
  );
}
