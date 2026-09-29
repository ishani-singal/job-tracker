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
  listStories: () => request<{ id: string; filename: string }[]>('/resumes/stories'),
  listResumeFiles: () => request<{ id: string; filename: string }[]>('/resumes/files'),
};
