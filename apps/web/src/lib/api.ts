import type {
  AnalyticsSummary,
  AnalyticsTimeseriesPoint,
  Application,
  AppSettings,
  ParsedJob,
  ResumeProfile,
} from '@job-tracker/shared-types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  listApplications: () => request<Application[]>('/applications'),
  getApplication: (id: string) => request<Application>(`/applications/${id}`),
  createApplication: (data: Partial<Application>) =>
    request<Application>('/applications', { method: 'POST', body: JSON.stringify(data) }),
  updateApplication: (id: string, data: Partial<Application>) =>
    request<Application>(`/applications/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteApplication: (id: string) =>
    request<void>(`/applications/${id}`, { method: 'DELETE' }),
  generateResume: (id: string) =>
    request<Application>(`/applications/${id}/generate-resume`, { method: 'POST' }),

  parseJobUrl: (url: string) =>
    request<ParsedJob>('/jobs/parse', { method: 'POST', body: JSON.stringify({ url }) }),

  getSettings: () => request<AppSettings>('/settings'),
  updateSettings: (data: Partial<AppSettings>) =>
    request<AppSettings>('/settings', { method: 'PATCH', body: JSON.stringify(data) }),

  getSummary: () => request<AnalyticsSummary>('/analytics/summary'),
  getTimeseries: () => request<AnalyticsTimeseriesPoint[]>('/analytics/timeseries'),

  getProfile: () => request<ResumeProfile>('/resumes/profile'),
  updateProfile: (data: Partial<ResumeProfile>) =>
    request<ResumeProfile>('/resumes/profile', { method: 'PATCH', body: JSON.stringify(data) }),
  getPromptPreview: () => request<{ prompt: string }>('/resumes/prompt-preview'),
  listStories: () => request<{ id: string; filename: string }[]>('/resumes/stories'),
  listResumeFiles: () => request<{ id: string; filename: string }[]>('/resumes/files'),

  getGithubConnection: () =>
    request<{ githubLogin: string } | null>('/github/connection'),
  disconnectGithub: () => request<void>('/github/connection', { method: 'DELETE' }),
  listAvailableRepos: () =>
    request<{ fullName: string; description: string | null; private: boolean; updatedAt: string }[]>(
      '/github/repos/available',
    ),
  listConnectedRepos: () =>
    request<{ fullName: string }[]>('/github/repos/connected'),
  connectRepo: (fullName: string) =>
    request<{ fullName: string }>('/github/repos/connected', {
      method: 'POST',
      body: JSON.stringify({ fullName }),
    }),
  disconnectRepo: (fullName: string) =>
    request<void>(`/github/repos/connected/${encodeURIComponent(fullName)}`, {
      method: 'DELETE',
    }),
};
