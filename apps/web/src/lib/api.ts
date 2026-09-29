import type {
  AnalyticsSummary,
  AnalyticsTimeseriesPoint,
  Application,
  AppSettings,
  EducationEntry,
  GenerationSession,
  InternshipEntry,
  ParsedJob,
  ProjectEntry,
  ResumeProfile,
  WorkExperienceEntry,
} from '@job-tracker/shared-types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body !== undefined && { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
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
  getPromptPreview: () =>
    request<{ prompt: string; prefix: string; template_body: string }>(
      '/resumes/prompt-preview',
    ),
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

  listWorkExperience: () => request<WorkExperienceEntry[]>('/entries/work-experience'),
  createWorkExperience: (data: Partial<WorkExperienceEntry>) =>
    request<WorkExperienceEntry>('/entries/work-experience', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateWorkExperience: (id: string, data: Partial<WorkExperienceEntry>) =>
    request<WorkExperienceEntry>(`/entries/work-experience/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteWorkExperience: (id: string) =>
    request<void>(`/entries/work-experience/${id}`, { method: 'DELETE' }),

  listEducation: () => request<EducationEntry[]>('/entries/education'),
  createEducation: (data: Partial<EducationEntry>) =>
    request<EducationEntry>('/entries/education', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateEducation: (id: string, data: Partial<EducationEntry>) =>
    request<EducationEntry>(`/entries/education/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteEducation: (id: string) =>
    request<void>(`/entries/education/${id}`, { method: 'DELETE' }),

  listInternships: () => request<InternshipEntry[]>('/entries/internships'),
  createInternship: (data: Partial<InternshipEntry>) =>
    request<InternshipEntry>('/entries/internships', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateInternship: (id: string, data: Partial<InternshipEntry>) =>
    request<InternshipEntry>(`/entries/internships/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteInternship: (id: string) =>
    request<void>(`/entries/internships/${id}`, { method: 'DELETE' }),

  listProjects: () => request<ProjectEntry[]>('/entries/projects'),
  createProject: (data: Partial<ProjectEntry>) =>
    request<ProjectEntry>('/entries/projects', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateProject: (id: string, data: Partial<ProjectEntry>) =>
    request<ProjectEntry>(`/entries/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteProject: (id: string) =>
    request<void>(`/entries/projects/${id}`, { method: 'DELETE' }),

  listSessions: () => request<GenerationSession[]>('/sessions'),
  getSession: (id: string) => request<GenerationSession>(`/sessions/${id}`),
  startSession: (applicationId: string) =>
    request<GenerationSession>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ applicationId }),
    }),
  replyToSession: (id: string, message: string) =>
    request<GenerationSession>(`/sessions/${id}/reply`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
  acceptSession: (id: string) =>
    request<GenerationSession>(`/sessions/${id}/accept`, { method: 'POST' }),

  searchLocations: (q: string) =>
    request<{ label: string; city: string; region: string | null; country: string }[]>(
      `/locations/search?q=${encodeURIComponent(q)}`,
    ),
};
