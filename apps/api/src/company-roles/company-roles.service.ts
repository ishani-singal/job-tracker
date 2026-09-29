import { Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
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

/** Collapses near-identical company name variants (see normalizeCompanyKey)
 * to one canonical name per group — picks the shortest surviving name as
 * canonical, since legal-suffix variants are usually longer than the plain
 * brand name. */
function dedupeCompanyNames(names: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const key = normalizeCompanyKey(name);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(name);
    groups.set(key, group);
  }
  return Array.from(groups.values()).map(
    (variants) => variants.sort((a, b) => a.length - b.length)[0],
  );
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

const ROLE_LIST_EXTRACTION_PROMPT = `You extract a list of open job postings from raw
career-page text. Return ONLY a JSON object: {"roles": [...]}. Each entry: title (string,
the job title as posted), url (string, the FULL absolute URL to that specific posting —
resolve relative links against the page's own URL given to you; omit the role if you
cannot determine a real per-posting URL), postedDate (ISO date string, or null if not
shown on the page). Only include actual open roles — skip navigation links, footer text,
"view all jobs" links, benefits/culture content, and anything that isn't a specific job
posting. If the page clearly isn't a career/jobs listing page at all, return {"roles": []}.`;

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

  /** Creates a TrackedCompany for every distinct Application.company not
   * already tracked, and kicks off discovery for each — a one-click way to
   * bring the existing application pipeline's companies into the "Track
   * Companies for Open Roles" feature instead of retyping them by hand.
   * Dedupes near-identical legal-name variants first (e.g. "Amazon" vs
   * "Amazon.com Services LLC") so they don't become two separate tracked
   * companies with two redundant career-page discovery runs. */
  async importCompaniesFromApplications(): Promise<{ created: string[]; skipped: string[] }> {
    const applications = await this.prisma.application.findMany({
      select: { company: true },
      distinct: ['company'],
    });
    const names = dedupeCompanyNames(applications.map((a) => a.company).filter(Boolean));
    return this.trackCompanies(names);
  }

  private async trackCompanies(rawNames: string[]): Promise<{ created: string[]; skipped: string[] }> {
    const names = Array.from(new Set(rawNames.map((n) => n.trim()).filter(Boolean)));

    const created: string[] = [];
    const skipped: string[] = [];

    for (const name of names) {
      const existing = await this.prisma.trackedCompany.findUnique({ where: { name } });
      if (existing) {
        skipped.push(name);
        continue;
      }
      await this.prisma.trackedCompany.create({ data: { name } });
      created.push(name);
    }

    for (const name of created) {
      this.discoverForCompany(name).catch((err) =>
        this.logger.warn(`Background discovery failed for ${name}: ${err}`),
      );
    }

    return { created, skipped };
  }

  async rediscover(companyId: string) {
    const company = await this.prisma.trackedCompany.findUnique({ where: { id: companyId } });
    if (!company) throw new NotFoundException(`Company ${companyId} not found`);
    this.discoverForCompany(company.name).catch((err) =>
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

  private async discoverForCompany(name: string): Promise<void> {
    await this.prisma.trackedCompany.update({
      where: { name },
      data: { discoveryStatus: 'DISCOVERING', discoveryError: null },
    });

    try {
      const { careerPageUrl, roles } = await this.findRolesForCompany(name);
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
  ): Promise<{ careerPageUrl?: string; roles: DiscoveredRoleDto[] }> {
    const candidates = CAREER_URL_GUESSES(name);

    for (const url of candidates) {
      try {
        const pageText = await this.renderPageText(url);
        if (!pageText || pageText.length < 200) continue;

        const roles = await this.extractRolesWithLlm(pageText, url);
        if (roles.length > 0) {
          return { careerPageUrl: url, roles };
        }
      } catch {
        // Try the next candidate URL — a 404/timeout on one guess is expected.
        continue;
      }
    }

    return { roles: [] };
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

  private async extractRolesWithLlm(pageText: string, pageUrl: string): Promise<DiscoveredRoleDto[]> {
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
          { role: 'system', content: ROLE_LIST_EXTRACTION_PROMPT },
          { role: 'user', content: `Page URL: ${pageUrl}\n\nPage text:\n${pageText}` },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) throw new Error(`Role extraction request failed: ${response.status}`);

    const data = (await response.json()) as { choices: { message: { content: string } }[] };
    const raw = data.choices[0]?.message?.content ?? '{"roles":[]}';
    const parsed = JSON.parse(raw) as { roles?: DiscoveredRoleDto[] };
    return (parsed.roles ?? []).filter((r) => r.title && r.url);
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
