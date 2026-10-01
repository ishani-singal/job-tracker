export type ApplicationStatus = 'NOT_APPLIED' | 'APPLIED';
export type DerivedStatus = 'active' | 'inactive' | 'stale' | 'rejected';

export interface Application {
  id: string;
  company: string;
  role: string | null;
  jobUrl: string | null;
  jobId: string | null;
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
  minMatchScoreFilter: number | null;
  postedBeforeTodayFilterOn: boolean;
  postedWithinDaysFilter: number;
  hideInvalidConditionRolesFilterOn: boolean;
  excludeKeywordsFilter: string;
  updatedAt: string;
}

export interface ResumeProfile {
  id: string;
  name: string;
  templateBody: string;
  candidateName: string | null;
  candidateEmail: string | null;
  candidatePhone: string | null;
  linkedinUrl: string | null;
  targetRoleArchetype: string | null;
  disqualifierKeywords: string[];
  locationCountry: string | null;
  locationState: string | null;
  locationCity: string | null;
  openToRemote: boolean;
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
  isFamilyBusiness: boolean;
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
  title: string | null;
  isClassProject: boolean;
  isFamilyBusiness: boolean;
  required: boolean;
  sortOrder: number;
}

export interface ProjectEntry extends DateRangeFields {
  id: string;
  name: string;
  repoUrl: string | null;
  liveUrl: string | null;
  demoUrl: string | null;
  required: boolean;
  sortOrder: number;
}

export interface PaperEntry {
  id: string;
  title: string;
  venue: string | null;
  authors: string | null;
  url: string | null;
  publishedMonth: number | null;
  publishedYear: number | null;
  required: boolean;
  sortOrder: number;
}

export interface ResumeTemplate {
  id: string;
  name: string;

  marginTopMin: number;
  marginTopMax: number;
  marginBottomMin: number;
  marginBottomMax: number;
  marginLeftMin: number;
  marginLeftMax: number;
  marginRightMin: number;
  marginRightMax: number;

  bulletFontMin: number;
  bulletFontMax: number;

  nameFontOffsetMin: number;
  nameFontOffsetMax: number;

  sectionHeaderFontOffsetMin: number;
  sectionHeaderFontOffsetMax: number;

  horizontalTabStop: number;

  spacingBeforeSectionMin: number;
  spacingBeforeSectionMax: number;
  spacingAfterSectionMin: number;
  spacingAfterSectionMax: number;
  spacingBetweenBulletsMin: number;
  spacingBetweenBulletsMax: number;

  updatedAt: string;
}

/**
 * The shape `resumeContent` takes once the agent emits structured output
 * (not yet wired up — see project notes). Sections render in array order;
 * each entry's dateRange/location are formatted from its own fields, not
 * stored redundantly here. `kind` picks which icon/date-format convention
 * the renderer uses per section.
 */
export interface StructuredResumeEntry {
  name: string;
  subtitle: string | null;
  location: string | null;
  dateRange: string | null;
  bullets: string[];
}

export interface StructuredResumeSection {
  heading: string;
  kind: 'work' | 'education' | 'project' | 'paper';
  entries: StructuredResumeEntry[];
}

export interface StructuredResume {
  contactLine: string;
  sections: StructuredResumeSection[];
}

export interface ParsedJob {
  company?: string;
  role?: string;
  jdText?: string;
  postedDate?: string;
  applyByDate?: string;
  salaryRange?: string;
  experienceLevel?: string;
  jobId?: string;
  fetchFailed: boolean;
}

export type CompanyDiscoveryStatus = 'PENDING' | 'DISCOVERING' | 'DONE' | 'FAILED';

export interface TrackedCompany {
  id: string;
  name: string;
  careerPageUrl: string | null;
  discoveryStatus: CompanyDiscoveryStatus;
  discoveryError: string | null;
  lastDiscoveredAt: string | null;
  createdAt: string;
  updatedAt: string;
  _count?: { roles: number };
}

export interface DiscoveredRole {
  id: string;
  companyId: string;
  company: TrackedCompany;
  title: string;
  roleUrl: string;
  jobId: string | null;
  postedDate: string | null;
  jdText: string | null;
  atsScore: number | null;
  atsScoreComputedAt: string | null;
  roleIsRemote: boolean | null;
  roleCountry: string | null;
  roleState: string | null;
  roleCity: string | null;
  locationMismatch: boolean | null;
  roleMinYearsExperience: number | null;
  experienceMismatch: boolean | null;
  applicationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type GenerationSessionStatus =
  | 'RUNNING'
  | 'WAITING_FOR_INPUT'
  | 'DONE'
  | 'ACCEPTED'
  | 'ERROR';

export type GenerationSessionScope = 'APPLICATION' | 'LINKEDIN' | 'COMPANY';

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
  scope: GenerationSessionScope;
  applicationId: string | null;
  company: string | null;
  status: GenerationSessionStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
}

export type StoryEntryType = 'WORK_EXPERIENCE' | 'EDUCATION' | 'INTERNSHIP' | 'PROJECT' | 'PAPER';

export interface LinkedinEntryBullets {
  entry_type: string;
  entry_id: string;
  bullets: string[];
}

export interface LinkedinProfile {
  id: string;
  headline: string | null;
  about: string | null;
  entryBullets: LinkedinEntryBullets[];
  updatedAt: string;
}

export interface CompanyResume {
  id: string;
  company: string;
  resumeContent: string;
  updatedAt: string;
}

export interface LinkedinImportSummary {
  importId: string;
  importedAt: string;
  connectionCount: number;
  messageCount: number;
}

export interface LinkedinConnection {
  id: string;
  firstName: string | null;
  lastName: string | null;
  url: string | null;
  emailAddress: string | null;
  company: string | null;
  position: string | null;
  connectedOn: string | null;
}

export interface LinkedinMessageThreadSummary {
  conversationId: string;
  messageCount: number;
  lastMessageAt: string | null;
  participants: string[];
}

export interface LinkedinMessage {
  id: string;
  conversationId: string;
  fromName: string | null;
  toName: string | null;
  content: string | null;
  sentAt: string | null;
}
