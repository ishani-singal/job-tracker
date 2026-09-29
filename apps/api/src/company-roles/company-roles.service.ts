import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import * as cheerio from 'cheerio';
import { Browser, chromium } from 'playwright';
import { PrismaService } from '../prisma/prisma.service';
import { ApplicationsService } from '../applications/applications.service';

/** Roles posted before this many days ago are dropped during discovery —
 * stale postings clutter the candidate pool and are usually already filled
 * or about to be. Undated roles (no postedDate could be extracted) are kept
 * since we can't tell either way. */
const MAX_ROLE_AGE_DAYS = 30;

/** Strips common legal-entity suffixes and normalizes case/punctuation so
 * "Amazon" and "Amazon.com Services LLC" collapse to the same key. Not
 * exhaustive — good enough to catch the common patterns without an external
 * company-name-resolution service. */
function normalizeCompanyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.com\b/g, '')
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|services|group|holdings|plc)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/** Derives a career-board listing root from one known job posting URL —
 * tried before the generic guess-list since it's a real URL known to work
 * for this exact company, not a guess. Returns undefined if the URL doesn't
 * match a recognized ATS pattern (falls through to the guess-list). */
function deriveCareerRootFromJobUrl(jobUrl: string): string | undefined {
  try {
    const url = new URL(jobUrl);
    const host = url.hostname;

    // Greenhouse: boards.greenhouse.io/<company>/jobs/<id> -> board root
    if (host === 'boards.greenhouse.io') {
      const match = url.pathname.match(/^\/([^/]+)/);
      if (match) return `https://boards.greenhouse.io/${match[1]}`;
    }
    // Lever: jobs.lever.co/<company>/<id> -> board root
    if (host === 'jobs.lever.co') {
      const match = url.pathname.match(/^\/([^/]+)/);
      if (match) return `https://jobs.lever.co/${match[1]}`;
    }
    // Workday: <tenant>.wdN.myworkdayjobs.com/<site>/job/... -> listing root
    // (drop the /job/... suffix, keep tenant + site path).
    if (/\.myworkdayjobs\.com$/.test(host)) {
      const match = url.pathname.match(/^(\/[^/]+)\/job\//);
      if (match) return `https://${host}${match[1]}`;
      return `https://${host}${url.pathname.split('/job/')[0]}`;
    }
    // SmartRecruiters: careers.smartrecruiters.com/<company>/... -> board root
    if (host === 'careers.smartrecruiters.com') {
      const match = url.pathname.match(/^\/([^/]+)/);
      if (match) return `https://careers.smartrecruiters.com/${match[1]}`;
    }
    // Generic fallback: same-origin "/careers" or "/jobs" root, stripped of
    // the specific posting path — a reasonable guess for custom career sites.
    if (/\/(careers|jobs)\//i.test(url.pathname)) {
      const match = url.pathname.match(/^(.*\/(careers|jobs))\//i);
      if (match) return `${url.origin}${match[1]}`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

const CAREER_URL_GUESSES = (company: string): string[] => {
  const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const slugDashed = company.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return [
    `https://boards.greenhouse.io/${slug}`,
    `https://jobs.lever.co/${slug}`,
    `https://${slug}.wd1.myworkdayjobs.com`,
    `https://www.${slug}.com/careers`,
    `https://${slug}.com/careers`,
    `https://www.${slug}.com/jobs`,
    `https://careers.${slug}.com`,
    `https://www.${slugDashed}.com/careers`,
  ];
};

/** Follows a listing's pagination up to this many pages — a safety cap so a
 * broken "Next" link (e.g. one that points back to itself) can't loop
 * forever. Most boards' open-role counts fit well within this. */
const MAX_LISTING_PAGES = 10;

function buildRoleListExtractionPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You extract a list of open job postings from raw career-page text. Today's date is
${today} — use it to resolve any relative date phrasing. Return ONLY a JSON object:
{"roles": [...], "nextPageUrl": string|null}. Each role entry: title (string, the job title as
posted), url (string, the FULL absolute URL to that specific posting — resolve relative links
against the page's own URL given to you; omit the role if you cannot determine a real
per-posting URL), postedDate (ISO date string YYYY-MM-DD, or null — resolve relative phrasing
like "Posted 3 days ago" or "2 weeks ago" against today's date; only null if there's truly no
recency signal for that role). Only include actual open roles — skip navigation links, footer
text, "view all jobs" links, benefits/culture content, and anything that isn't a specific job
posting. nextPageUrl: the FULL absolute URL of a "Next page"/"Next"/pagination-forward link if
this listing spans multiple pages and one is present on this page, resolved against the page's
own URL — null if there's no next page or the page isn't paginated. If the page clearly isn't a
career/jobs listing page at all, return {"roles": [], "nextPageUrl": null}.`;
}

export interface DiscoveredRoleDto {
  title: string;
  url: string;
  postedDate?: string;
}

@Injectable()
export class CompanyRolesService implements OnModuleDestroy {
  private readonly logger = new Logger(CompanyRolesService.name);
  private browser: Browser | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => ApplicationsService))
    private readonly applications: ApplicationsService,
  ) {}

  async onModuleDestroy() {
    await this.browser?.close();
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
    }
    return this.browser;
  }

  listCompanies() {
    return this.prisma.trackedCompany.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { roles: true } } },
    });
  }

  /** Parses bulk company input (comma- and/or newline-separated), creates a
   * TrackedCompany per unique name (skipping ones that already exist), and
   * kicks off discovery for each in the background. Returns the created rows
   * immediately — callers poll discoveryStatus rather than waiting here. */
  async addCompanies(rawInput: string): Promise<{ created: string[]; skipped: string[] }> {
    const names = rawInput
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return this.trackCompanies(names);
  }

  /** Ensures a TrackedCompany exists for this company name, matching against
   * existing tracked companies by normalized name (so "Amazon.com Services
   * LLC" matches an existing "Amazon" row rather than creating a duplicate)
   * — called automatically whenever an Application is created, so the
   * Applications and Tracked Companies lists stay a single unified set with
   * no manual "import" step. Fire-and-forget safe: swallows/logs its own
   * errors so it never blocks the Application create it's attached to.
   * If the Application had a jobUrl, its derived career-board root is tried
   * before the generic guess-list — a real known-good URL beats a guess. */
  async ensureCompanyTracked(name: string, seedJobUrl?: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;

    try {
      const key = normalizeCompanyKey(trimmed);
      const existingTracked = await this.prisma.trackedCompany.findMany({ select: { name: true } });
      if (existingTracked.some((c) => normalizeCompanyKey(c.name) === key)) return;

      await this.prisma.trackedCompany.create({ data: { name: trimmed } });
      const seedUrl = seedJobUrl ? deriveCareerRootFromJobUrl(seedJobUrl) : undefined;
      this.discoverForCompany(trimmed, seedUrl).catch((err) =>
        this.logger.warn(`Background discovery failed for ${trimmed}: ${err}`),
      );
    } catch (err) {
      this.logger.warn(`ensureCompanyTracked failed for ${trimmed}: ${err}`);
    }
  }

  private async trackCompanies(rawNames: string[]): Promise<{ created: string[]; skipped: string[] }> {
    const names = Array.from(new Set(rawNames.map((n) => n.trim()).filter(Boolean)));
    const existingTracked = await this.prisma.trackedCompany.findMany({ select: { name: true } });
    const existingKeys = new Set(existingTracked.map((c) => normalizeCompanyKey(c.name)));

    const created: string[] = [];
    const skipped: string[] = [];

    for (const name of names) {
      const key = normalizeCompanyKey(name);
      if (existingKeys.has(key)) {
        skipped.push(name);
        continue;
      }
      await this.prisma.trackedCompany.create({ data: { name } });
      existingKeys.add(key);
      created.push(name);
    }

    for (const name of created) {
      this.discoverForCompany(name).catch((err) =>
        this.logger.warn(`Background discovery failed for ${name}: ${err}`),
      );
    }

    return { created, skipped };
  }

  /** Adds a single company with a manually-provided career page URL — used
   * when auto-discovery's guessed URLs can't find the right board (custom
   * ATS, non-standard domain, etc.). The manual URL is used directly, no
   * guessing. If the company is already tracked, updates its careerPageUrl
   * and re-runs discovery against it instead of creating a duplicate. */
  async addCompanyWithCareerUrl(name: string, careerPageUrl: string): Promise<{ name: string }> {
    const trimmed = name.trim();
    const url = careerPageUrl.trim();
    if (!trimmed) throw new Error('Company name is required');
    if (!url) throw new Error('Career page URL is required');

    const key = normalizeCompanyKey(trimmed);
    const existingTracked = await this.prisma.trackedCompany.findMany();
    const existing = existingTracked.find((c) => normalizeCompanyKey(c.name) === key);

    const company = existing
      ? await this.prisma.trackedCompany.update({
          where: { id: existing.id },
          data: { careerPageUrl: url },
        })
      : await this.prisma.trackedCompany.create({ data: { name: trimmed, careerPageUrl: url } });

    this.discoverForCompany(company.name, url).catch((err) =>
      this.logger.warn(`Background discovery failed for ${company.name}: ${err}`),
    );

    return { name: company.name };
  }

  async rediscover(companyId: string) {
    const company = await this.prisma.trackedCompany.findUnique({ where: { id: companyId } });
    if (!company) throw new NotFoundException(`Company ${companyId} not found`);
    // Reuse the already-known career page (from a prior discovery or manual
    // entry) instead of re-guessing from scratch, when one exists.
    this.discoverForCompany(company.name, company.careerPageUrl ?? undefined).catch((err) =>
      this.logger.warn(`Background discovery failed for ${company.name}: ${err}`),
    );
    return { started: true };
  }

  async deleteCompany(companyId: string) {
    const company = await this.prisma.trackedCompany.findUnique({ where: { id: companyId } });
    if (!company) throw new NotFoundException(`Company ${companyId} not found`);
    // DiscoveredRoles cascade-delete via the schema's onDelete: Cascade —
    // selected roles (with an applicationId) keep their Application row,
    // only the DiscoveredRole join/candidate-pool entry is removed.
    await this.prisma.trackedCompany.delete({ where: { id: companyId } });
    return { deleted: true };
  }

  private async discoverForCompany(name: string, seedUrl?: string): Promise<void> {
    await this.prisma.trackedCompany.update({
      where: { name },
      data: { discoveryStatus: 'DISCOVERING', discoveryError: null },
    });

    try {
      const { careerPageUrl, roles } = await this.findRolesForCompany(name, seedUrl);
      const company = await this.prisma.trackedCompany.findUniqueOrThrow({ where: { name } });

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - MAX_ROLE_AGE_DAYS);

      const kept = roles.filter((r) => {
        if (!r.postedDate) return true;
        const posted = new Date(r.postedDate);
        return isNaN(posted.getTime()) || posted >= cutoff;
      });

      for (const role of kept) {
        await this.prisma.discoveredRole.upsert({
          where: { companyId_roleUrl: { companyId: company.id, roleUrl: role.url } },
          update: {
            title: role.title,
            postedDate: role.postedDate ? new Date(role.postedDate) : null,
          },
          create: {
            companyId: company.id,
            title: role.title,
            roleUrl: role.url,
            postedDate: role.postedDate ? new Date(role.postedDate) : null,
          },
        });
      }

      await this.prisma.trackedCompany.update({
        where: { id: company.id },
        data: {
          careerPageUrl,
          discoveryStatus: 'DONE',
          lastDiscoveredAt: new Date(),
        },
      });

      // Fire-and-forget ATS scoring for newly discovered roles — don't block
      // discovery completion on it.
      this.scoreUnscoredRolesForCompany(company.id).catch((err) =>
        this.logger.warn(`Scoring failed for ${name}: ${err}`),
      );
    } catch (err) {
      await this.prisma.trackedCompany.update({
        where: { name },
        data: { discoveryStatus: 'FAILED', discoveryError: String(err) },
      });
    }
  }

  private async findRolesForCompany(
    name: string,
    seedUrl?: string,
  ): Promise<{ careerPageUrl?: string; roles: DiscoveredRoleDto[] }> {
    // A known-good URL (derived from a real job posting, or manually
    // entered) is tried before any guess — it's known to work for this
    // company, not a guess, so it goes first in the candidate list.
    const candidates = [...(seedUrl ? [seedUrl] : []), ...CAREER_URL_GUESSES(name)];

    for (const url of candidates) {
      try {
        const pageText = await this.renderPageText(url);
        if (!pageText || pageText.length < 200) continue;

        const { roles: firstPageRoles, nextPageUrl } = await this.extractRolesWithLlm(pageText, url);
        if (firstPageRoles.length === 0) continue;

        const roles = await this.paginateRoles(firstPageRoles, nextPageUrl, url);
        return { careerPageUrl: url, roles };
      } catch {
        // Try the next candidate URL — a 404/timeout on one guess is expected.
        continue;
      }
    }

    return { roles: [] };
  }

  /** Follows a listing's "Next page" links, accumulating roles, until: no
   * more roles come back, there's no next page, the page cap is hit, or a
   * page's roles are ALL older than the staleness cutoff (later pages of a
   * date-sorted listing only get older, so this is a safe stop condition,
   * not just an optimization). */
  private async paginateRoles(
    firstPageRoles: DiscoveredRoleDto[],
    nextPageUrl: string | undefined,
    firstPageUrl: string,
  ): Promise<DiscoveredRoleDto[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_ROLE_AGE_DAYS);
    const isStale = (r: DiscoveredRoleDto) => {
      if (!r.postedDate) return false; // undated — can't judge, don't use it to stop early
      const posted = new Date(r.postedDate);
      return !isNaN(posted.getTime()) && posted < cutoff;
    };

    const allRoles = [...firstPageRoles];
    let currentNextUrl = nextPageUrl;
    let previousUrl = firstPageUrl;
    let pageCount = 1;

    while (currentNextUrl && pageCount < MAX_LISTING_PAGES) {
      // Guard against a broken pagination link that points back to a page
      // we've already fetched (would otherwise loop until the page cap).
      if (currentNextUrl === previousUrl) break;

      try {
        const pageText = await this.renderPageText(currentNextUrl);
        if (!pageText || pageText.length < 200) break;

        const { roles: pageRoles, nextPageUrl: followingUrl } = await this.extractRolesWithLlm(
          pageText,
          currentNextUrl,
        );
        if (pageRoles.length === 0) break;

        allRoles.push(...pageRoles);
        pageCount += 1;

        if (pageRoles.every(isStale)) break;

        previousUrl = currentNextUrl;
        currentNextUrl = followingUrl;
      } catch {
        break;
      }
    }

    return allRoles;
  }

  private async renderPageText(url: string, opts?: { requireSameOrigin?: boolean }): Promise<string> {
    const browser = await this.getBrowser();
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (compatible; job-tracker/0.1)',
    });
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
      if (opts?.requireSameOrigin) {
        // Some career boards (e.g. certain Greenhouse embeds) silently
        // redirect every individual job URL to the company's own generic
        // careers/search page instead of a real per-posting document — if
        // that happened, the page text is the listing shell, not a JD, so
        // treat it as unresolvable rather than scoring against garbage.
        // Compare registrable domains (not full origin), since a plain
        // www./scheme normalization redirect (notion.com -> www.notion.com)
        // is completely legitimate and must not be flagged the same way.
        const finalUrl = new URL(page.url());
        const requestedUrl = new URL(url);
        const registrableDomain = (host: string) => host.replace(/^www\./, '');
        const domainChanged =
          registrableDomain(finalUrl.hostname) !== registrableDomain(requestedUrl.hostname);
        // A same-domain redirect that lands on a generic listing/search root
        // (not the specific posting path) is still the "shell" case, e.g.
        // Greenhouse embeds bouncing to <company>.com/careers/search.
        const landedOnGenericListing =
          !domainChanged &&
          /\/(careers|jobs)\/?(search)?\/?$/i.test(finalUrl.pathname) &&
          finalUrl.pathname !== requestedUrl.pathname;
        if (domainChanged || landedOnGenericListing) return '';
      }
      const html = await page.content();
      const $ = cheerio.load(html);
      const ogDescription = $('meta[property="og:description"]').attr('content')?.trim();
      $('script, style, noscript').remove();
      const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
      return (bodyText.length > 200 ? bodyText : ogDescription || bodyText).slice(0, 60000);
    } finally {
      await page.close();
    }
  }

  private async extractRolesWithLlm(
    pageText: string,
    pageUrl: string,
  ): Promise<{ roles: DiscoveredRoleDto[]; nextPageUrl?: string }> {
    const endpoint = process.env.AZURE_LLM_ENDPOINT;
    const apiKey = process.env.AZURE_LLM_API_KEY;
    const deployment = process.env.AZURE_LLM_DEPLOYMENT_NAME ?? 'gpt-4.1';
    const apiVersion = process.env.AZURE_LLM_API_VERSION ?? '2024-12-01-preview';
    if (!endpoint || !apiKey) throw new Error('AZURE_LLM_ENDPOINT / AZURE_LLM_API_KEY not configured');

    const baseEndpoint = endpoint.replace(/\/openai\/?$/, '');
    const url = `${baseEndpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: buildRoleListExtractionPrompt() },
          { role: 'user', content: `Page URL: ${pageUrl}\n\nPage text:\n${pageText}` },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) throw new Error(`Role extraction request failed: ${response.status}`);

    const data = (await response.json()) as { choices: { message: { content: string } }[] };
    const raw = data.choices[0]?.message?.content ?? '{"roles":[]}';
    const parsed = JSON.parse(raw) as { roles?: DiscoveredRoleDto[]; nextPageUrl?: string | null };
    return {
      roles: (parsed.roles ?? []).filter((r) => r.title && r.url),
      nextPageUrl: parsed.nextPageUrl ?? undefined,
    };
  }

  listRoles(params: { unselectedOnly?: boolean; selectedOnly?: boolean }) {
    return this.prisma.discoveredRole.findMany({
      where: {
        ...(params.unselectedOnly && { applicationId: null }),
        ...(params.selectedOnly && { applicationId: { not: null } }),
      },
      include: { company: true },
      orderBy: [{ postedDate: 'desc' }, { createdAt: 'desc' }],
    });
  }

  /** Pushes a discovered role into Applications: creates (or reuses, if a
   * dedup match already exists) an Application from the role's data, then
   * links the DiscoveredRole to it so it moves to the "selected" side. */
  async selectRole(roleId: string) {
    const role = await this.prisma.discoveredRole.findUnique({
      where: { id: roleId },
      include: { company: true },
    });
    if (!role) throw new NotFoundException(`Role ${roleId} not found`);
    if (role.applicationId) {
      return this.prisma.application.findUnique({ where: { id: role.applicationId } });
    }

    let application;
    try {
      application = await this.applications.create({
        company: role.company.name,
        role: role.title,
        jobUrl: role.roleUrl,
        jobId: role.jobId ?? undefined,
        jdText: role.jdText ?? undefined,
        postedDate: role.postedDate?.toISOString(),
      });
    } catch (err: unknown) {
      const body = (err as { getResponse?: () => { duplicateOf?: { id: string } } })?.getResponse?.();
      if (body?.duplicateOf) {
        application = body.duplicateOf;
      } else {
        throw err;
      }
    }

    await this.prisma.discoveredRole.update({
      where: { id: roleId },
      data: { applicationId: application.id },
    });

    return application;
  }

  async unselectRole(roleId: string) {
    const role = await this.prisma.discoveredRole.findUnique({ where: { id: roleId } });
    if (!role) throw new NotFoundException(`Role ${roleId} not found`);
    await this.prisma.discoveredRole.update({
      where: { id: roleId },
      data: { applicationId: null },
    });
    return { unselected: true };
  }

  private async scoreUnscoredRolesForCompany(companyId: string) {
    const roles = await this.prisma.discoveredRole.findMany({
      where: { companyId, atsScore: null },
    });
    if (roles.length === 0) return;

    const [profile, entries] = await Promise.all([this.fetchCandidateProfile(), this.fetchCandidateEntries()]);

    for (const role of roles) {
      try {
        const jdText = role.jdText || (await this.fetchRoleJd(role.roleUrl));
        if (!jdText) {
          // Couldn't resolve a real per-posting page (e.g. the board
          // redirected to a generic careers/search page) — leave atsScore
          // null (shown as "unavailable") rather than scoring against the
          // wrong content.
          continue;
        }
        const score = await this.estimateAtsScore(jdText, profile, entries);
        await this.prisma.discoveredRole.update({
          where: { id: role.id },
          data: {
            jdText: role.jdText || jdText || undefined,
            atsScore: score,
            atsScoreComputedAt: new Date(),
          },
        });
      } catch (err) {
        this.logger.warn(`ATS scoring failed for role ${role.id}: ${err}`);
      }
    }
  }

  async rescoreRole(roleId: string) {
    const role = await this.prisma.discoveredRole.findUnique({ where: { id: roleId } });
    if (!role) throw new NotFoundException(`Role ${roleId} not found`);

    const [profile, entries] = await Promise.all([this.fetchCandidateProfile(), this.fetchCandidateEntries()]);
    const jdText = role.jdText || (await this.fetchRoleJd(role.roleUrl));
    if (!jdText) {
      return this.prisma.discoveredRole.update({
        where: { id: roleId },
        data: { atsScoreComputedAt: new Date() },
      });
    }
    const score = await this.estimateAtsScore(jdText, profile, entries);

    return this.prisma.discoveredRole.update({
      where: { id: roleId },
      data: {
        jdText: role.jdText || jdText || undefined,
        atsScore: score,
        atsScoreComputedAt: new Date(),
      },
    });
  }

  private async fetchRoleJd(roleUrl: string): Promise<string> {
    try {
      const pageText = await this.renderPageText(roleUrl, { requireSameOrigin: true });
      return pageText.slice(0, 20000);
    } catch {
      return '';
    }
  }

  private apiBaseUrl(): string {
    return `http://localhost:${process.env.PORT ?? 4100}`;
  }

  private async fetchCandidateProfile(): Promise<unknown> {
    const res = await fetch(`${this.apiBaseUrl()}/resumes/profile`);
    return res.ok ? res.json() : {};
  }

  private async fetchCandidateEntries(): Promise<unknown> {
    const res = await fetch(`${this.apiBaseUrl()}/entries`);
    return res.ok ? res.json() : {};
  }

  /** Lightweight ATS match estimate (0-100) — a fast, standalone LLM call
   * comparing the JD against the candidate's profile/background, distinct
   * from the full resume-generation flow's matchScoreTarget (which scores an
   * actual generated resume, not a candidate-vs-JD fit estimate up front). */
  private async estimateAtsScore(jdText: string, profile: unknown, entries: unknown): Promise<number | null> {
    if (!jdText) return null;

    const endpoint = process.env.AZURE_LLM_ENDPOINT;
    const apiKey = process.env.AZURE_LLM_API_KEY;
    const deployment = process.env.AZURE_LLM_DEPLOYMENT_NAME ?? 'gpt-4.1';
    const apiVersion = process.env.AZURE_LLM_API_VERSION ?? '2024-12-01-preview';
    if (!endpoint || !apiKey) return null;

    const baseEndpoint = endpoint.replace(/\/openai\/?$/, '');
    const url = `${baseEndpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content:
              'You estimate how well a candidate matches a job description for ATS/recruiter ' +
              'screening purposes. Return ONLY a JSON object: {"score": <integer 0-100>}. Base ' +
              'it on keyword/skill overlap, seniority match, and domain relevance between the ' +
              "candidate's background and the JD's requirements. Be realistic, not generous.",
          },
          {
            role: 'user',
            content: `Candidate profile:\n${JSON.stringify(profile)}\n\nCandidate background:\n${JSON.stringify(entries)}\n\nJob description:\n${jdText.slice(0, 12000)}`,
          },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) return null;

    const data = (await response.json()) as { choices: { message: { content: string } }[] };
    const raw = data.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw) as { score?: number };
    return typeof parsed.score === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.score))) : null;
  }
}
