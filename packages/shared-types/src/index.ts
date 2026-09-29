export type ApplicationStatus = 'NOT_APPLIED' | 'APPLIED';
export type DerivedStatus = 'active' | 'inactive' | 'stale' | 'rejected';

export interface Application {
  id: string;
  company: string;
  role: string | null;
  jobUrl: string | null;
  jdText: string | null;
  postedDate: string | null;
  applyByDate: string | null;
  salaryRange: string | null;
  experienceLevel: string | null;
  status: ApplicationStatus;
  appliedDate: string | null;
  lastMessageReceivedDate: string | null;
  rejectedDate: string | null;
  resumeContent: string | null;
  resumeGeneratedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present on list responses (GET /applications) — omitted on single-record reads. */
  derivedStatus?: DerivedStatus;
}

export interface AnalyticsSummary {
  uniqueCompanies: number;
  totalActiveApplications: number;
  totalApplicationsDone: number;
  totalCallbacks: number;
}

export interface AnalyticsTimeseriesPoint {
  date: string;
  applications: number;
  callbacks: number;
  runningAverage7d: number;
  callbackRate: number;
}

export interface AppSettings {
  id: string;
  inactivityThresholdDays: number;
  deadlineThresholdDays: number;
  updatedAt: string;
}

export interface ResumeProfile {
  id: string;
  name: string;
  templateBody: string;
  targetRoleArchetype: string | null;
  disqualifierKeywords: string[];
  locationZip: string | null;
  maxYearsExperience: number | null;
  matchScoreTarget: number;
}

interface DateRangeFields {
  location: string | null;
  startMonth: number | null;
  startYear: number | null;
  endMonth: number | null;
  endYear: number | null;
  isPresent: boolean;
}

export interface WorkExperienceEntry extends DateRangeFields {
  id: string;
  company: string;
  title: string | null;
  required: boolean;
  sortOrder: number;
}

export interface EducationEntry extends DateRangeFields {
  id: string;
  school: string;
  degree: string | null;
  field: string | null;
  required: boolean;
  sortOrder: number;
}

export interface InternshipEntry extends DateRangeFields {
  id: string;
  company: string;
  required: boolean;
  sortOrder: number;
}

export interface ProjectEntry extends DateRangeFields {
  id: string;
  name: string;
  repoUrl: string | null;
  liveUrl: string | null;
  required: boolean;
  sortOrder: number;
}

export interface ParsedJob {
  company?: string;
  role?: string;
  jdText?: string;
  postedDate?: string;
  applyByDate?: string;
  salaryRange?: string;
  experienceLevel?: string;
  fetchFailed: boolean;
}

export type GenerationSessionStatus =
  | 'RUNNING'
  | 'WAITING_FOR_INPUT'
  | 'DONE'
  | 'ACCEPTED'
  | 'ERROR';

export type MessageRole = 'USER' | 'ASSISTANT' | 'TOOL';

export interface SessionMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface GenerationSession {
  id: string;
  applicationId: string;
  status: GenerationSessionStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
}
