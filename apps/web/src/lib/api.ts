import type {
  AnalyticsSummary,
  AnalyticsTimeseriesPoint,
  Application,
  AppSettings,
  CompanyResume,
  DiscoveredRole,
  EducationEntry,
  GenerationSession,
  InternshipEntry,
  LinkedinConnection,
  LinkedinImportSummary,
  LinkedinMessage,
  LinkedinMessageThreadSummary,
  LinkedinProfile,
  ParsedJob,
  ProjectEntry,
  ResumeProfile,
  ResumeTemplate,
  LlmModelPrice,
  LlmUsage,
  StoryEntryType,
  TrackedCompany,
  WorkExperienceEntry,
} from '@job-tracker/shared-types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body !== undefined && { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    throw new ApiError(
      (body as { message?: string })?.message ?? `${init?.method ?? 'GET'} ${path} failed: ${res.status}`,
      res.status,
      body,
    );
  }
  return res.json() as Promise<T>;
}

export const api = {
  listApplications: () => request<Application[]>('/applications'),
  getApplication: (id: string) => request<Application>(`/applications/${id}`),
  createApplication: (data: Partial<Application> & { allowDuplicate?: boolean }) =>
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

  getLlmUsage: () => request<LlmUsage>('/llm-calls'),
  setLlmDailyBudget: (dailyBudgetUsd: number) =>
    request<{ dailyBudgetUsd: number }>('/llm-calls/budget', {
      method: 'PATCH',
      body: JSON.stringify({ dailyBudgetUsd }),
    }),
  upsertLlmPrice: (model: string, price: Omit<LlmModelPrice, 'model'>) =>
    request<LlmModelPrice>(`/llm-calls/prices/${encodeURIComponent(model)}`, {
      method: 'PUT',
      body: JSON.stringify(price),
    }),
  deleteLlmPrice: (model: string) =>
    request<{ deleted: boolean }>(`/llm-calls/prices/${encodeURIComponent(model)}`, {
      method: 'DELETE',
    }),

  getSummary: () => request<AnalyticsSummary>('/analytics/summary'),
  getTimeseries: () => request<AnalyticsTimeseriesPoint[]>('/analytics/timeseries'),

  getProfile: () => request<ResumeProfile>('/resumes/profile'),
  updateProfile: (data: Partial<ResumeProfile>) =>
    request<ResumeProfile>('/resumes/profile', { method: 'PATCH', body: JSON.stringify(data) }),
  getPromptPreview: () =>
    request<{ prompt: string; prefix: string; template_body: string }>(
      '/resumes/prompt-preview',
    ),
  getResumeTemplate: () => request<ResumeTemplate>('/resumes/template'),
  updateResumeTemplate: (data: Partial<ResumeTemplate>) =>
    request<ResumeTemplate>('/resumes/template', { method: 'PATCH', body: JSON.stringify(data) }),
  listStories: () =>
    request<{ id: string; filename: string; entryType: StoryEntryType; entryId: string }[]>(
      '/resumes/stories',
    ),
  listResumeFiles: () =>
    request<{ id: string; filename: string; entryType: StoryEntryType; entryId: string }[]>(
      '/resumes/files',
    ),
  deleteStory: (id: string) => request<void>(`/resumes/stories/${id}`, { method: 'DELETE' }),
  deleteResumeFile: (id: string) => request<void>(`/resumes/files/${id}`, { method: 'DELETE' }),

  getGithubConnection: () =>
    request<{ githubLogin: string } | null>('/github/connection'),
  disconnectGithub: () => request<void>('/github/connection', { method: 'DELETE' }),
  listAvailableRepos: () =>
    request<{ fullName: string; description: string | null; private: boolean; updatedAt: string }[]>(
      '/github/repos/available',
    ),
  listConnectedRepos: () =>
    request<{ fullName: string; entryType: StoryEntryType; entryId: string }[]>(
      '/github/repos/connected',
    ),
  connectRepo: (fullName: string, entryType: StoryEntryType, entryId: string) =>
    request<{ fullName: string }>('/github/repos/connected', {
      method: 'POST',
      body: JSON.stringify({ fullName, entryType, entryId }),
    }),
  disconnectRepo: (fullName: string) =>
    request<void>(`/github/repos/connected/${encodeURIComponent(fullName)}`, {
      method: 'DELETE',
    }),

  getDocumentForEntry: (entryType: StoryEntryType, entryId: string) =>
    request<{ contentHtml: string } | null>(
      `/stories/document?entryType=${entryType}&entryId=${encodeURIComponent(entryId)}`,
    ),
  saveDocumentForEntry: (entryType: StoryEntryType, entryId: string, contentHtml: string) =>
    request<{ contentHtml: string }>('/stories/document', {
      method: 'PUT',
      body: JSON.stringify({ entryType, entryId, contentHtml }),
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
  startLinkedinSession: () =>
    request<GenerationSession>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ scope: 'LINKEDIN' }),
    }),
  startCompanySession: (company: string) =>
    request<GenerationSession>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ scope: 'COMPANY', company }),
    }),
  startEntryDocumentSession: (entryType: StoryEntryType, entryId: string, entryLabel: string) =>
    request<GenerationSession>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ scope: 'ENTRY_DOCUMENT', entryType, entryId, entryLabel }),
    }),
  replyToSession: (id: string, message: string) =>
    request<GenerationSession>(`/sessions/${id}/reply`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
  acceptSession: (id: string) =>
    request<GenerationSession>(`/sessions/${id}/accept`, { method: 'POST' }),
  stopSession: (id: string) =>
    request<GenerationSession>(`/sessions/${id}/stop`, { method: 'POST' }),

  searchLocations: (q: string, country?: string, state?: string) => {
    const params = new URLSearchParams({ q });
    if (country) params.set('country', country);
    if (state) params.set('state', state);
    return request<{ label: string; city: string; region: string | null; country: string }[]>(
      `/locations/search?${params.toString()}`,
    );
  },
  listCountries: () => request<{ code: string; name: string }[]>('/locations/countries'),
  listStates: (country: string) =>
    request<{ code: string; name: string }[]>(`/locations/states?country=${encodeURIComponent(country)}`),

  getLinkedinProfile: () => request<LinkedinProfile | null>('/linkedin/profile'),
  getLinkedinStaleness: () =>
    request<{ stale: boolean; lastGeneratedAt: string | null }>('/linkedin/staleness'),
  getLinkedinPromptPreview: () => request<{ prompt: string }>('/linkedin/prompt-preview'),

  listCompanyResumes: () =>
    request<{ company: string; hasResume: boolean; updatedAt: string | null }[]>(
      '/company-resumes',
    ),
  getCompanyResume: (company: string) =>
    request<CompanyResume>(`/company-resumes/${encodeURIComponent(company)}`),

  getLinkedinDataSummary: () =>
    request<LinkedinImportSummary | null>('/linkedin-data/summary'),
  listLinkedinConnections: (search?: string) =>
    request<LinkedinConnection[]>(
      `/linkedin-data/connections${search ? `?search=${encodeURIComponent(search)}` : ''}`,
    ),
  listLinkedinMessageThreads: () =>
    request<LinkedinMessageThreadSummary[]>('/linkedin-data/message-threads'),
  getLinkedinThreadMessages: (conversationId: string) =>
    request<LinkedinMessage[]>(
      `/linkedin-data/message-threads/${encodeURIComponent(conversationId)}`,
    ),

  listTrackedCompanies: () => request<TrackedCompany[]>('/tracked-companies'),
  addTrackedCompanies: (companies: string) =>
    request<{ created: string[]; skipped: string[] }>('/tracked-companies', {
      method: 'POST',
      body: JSON.stringify({ companies }),
    }),
  addCompanyWithCareerUrl: (name: string, careerPageUrl: string) =>
    request<{ name: string }>('/tracked-companies/with-career-url', {
      method: 'POST',
      body: JSON.stringify({ name, careerPageUrl }),
    }),
  rediscoverCompany: (id: string) =>
    request<{ started: boolean }>(`/tracked-companies/${id}/rediscover`, { method: 'POST' }),
  deleteTrackedCompany: (id: string) =>
    request<{ deleted: boolean }>(`/tracked-companies/${id}`, { method: 'DELETE' }),

  listDiscoveredRoles: (filter?: 'unselected' | 'selected') =>
    request<DiscoveredRole[]>(`/discovered-roles${filter ? `?filter=${filter}` : ''}`),
  selectRole: (id: string) =>
    request<Application>(`/discovered-roles/${id}/select`, { method: 'POST' }),
  unselectRole: (id: string) =>
    request<{ unselected: boolean }>(`/discovered-roles/${id}/unselect`, { method: 'POST' }),
  rescoreRole: (id: string) =>
    request<DiscoveredRole>(`/discovered-roles/${id}/rescore`, { method: 'POST' }),
  discardRole: (id: string) =>
    request<DiscoveredRole>(`/discovered-roles/${id}/discard`, { method: 'POST' }),

  stopAllLlmCalls: () => request<{ stopped: boolean }>('/llm/stop', { method: 'POST' }),
};
