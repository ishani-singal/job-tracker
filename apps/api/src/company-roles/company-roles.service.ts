import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import * as cheerio from 'cheerio';
import { Browser, chromium, Page } from 'playwright';
import { PrismaService } from '../prisma/prisma.service';
import { ApplicationsService } from '../applications/applications.service';
import { LocationsService } from '../locations/locations.service';

/** Roles posted before this many days ago are dropped during discovery —
 * stale postings clutter the candidate pool and are usually already filled
 * or about to be. Undated roles (no postedDate could be extracted) are kept
 * since we can't tell either way. */
const MAX_ROLE_AGE_DAYS = 30;

/** Max roles scored in parallel per company. Each unit of work is a
 * headless-browser page load plus an LLM call, so this caps concurrent
 * browser pages and LLM requests rather than being an arbitrary batch size. */
const SCORING_CONCURRENCY = 4;

/** Some career pages (e.g. Netflix's Eightfold-powered board) render a large
 * JSON app-state/theming blob as literal visible body text — real prose, not
 * a <script> tag, so cheerio's text-stripping never removes it, and it can
 * run tens of thousands of characters. Naively preferring og:description
 * only when bodyText is SHORT misses this case entirely (the JSON blob is
 * long, so it looks "substantial" while being pure garbage). Detects this by
 * checking whether the text is dominated by JSON-structural characters — a
 * real JD full of prose has very few brace/bracket/quote characters relative
 * to its length; a JSON dump is mostly punctuation and short quoted tokens. */
function looksLikeJsonDump(text: string): boolean {
  const sample = text.slice(0, 2000);
  if (!sample) return false;
  const structuralChars = (sample.match(/[{}[\]":,]/g) ?? []).length;
  return structuralChars / sample.length > 0.15;
}

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
 * forever, not an intended per-company limit. Sized generously because
 * per-page role counts vary wildly across boards — e.g. Microsoft's careers
 * site pages just 4 roles at a time via paginateWithClicks, so a cap of 10
 * (fine for a 20-50-per-page board) silently truncated it at 40 roles. The
 * hitsKnownRole/staleness stop conditions in paginateRoles/paginateWithClicks
 * are what actually end a normal scan early; this is only the backstop. */
const MAX_LISTING_PAGES = 100;

/** Some career boards (e.g. many custom/Workday-embedded sites) don't paginate
 * via a "Next page" link at all — they use a "Show more"/"Load more" button or
 * true infinite scroll that appends more roles into the same page. Those never
 * produce a nextPageUrl for extractRolesWithLlm to follow, so paginateRoles
 * alone would silently stop after the first batch. This caps how many
 * click-or-scroll rounds we try to expand such a listing before reading its
 * text, mirroring MAX_LISTING_PAGES' role as a safety cap, not a target. */
const MAX_LOAD_MORE_ROUNDS = 15;

/** Case-insensitive substrings matched against a clickable element's visible
 * text to find a "load more roles" control — deliberately broad since boards
 * word this differently ("Show more", "Load more jobs", "View more positions").
 * Not matched: "view all"/"see all" — those usually navigate to a different
 * page rather than expanding this one in place. */
const LOAD_MORE_TEXT_PATTERN = /\b(show|load|see|view)\s+more\b/i;

/** Some boards (e.g. Microsoft's careers site) paginate through a JS-driven
 * "next page" BUTTON that re-fetches and replaces the results in place —
 * there's no real hyperlink for extractRolesWithLlm's nextPageUrl to catch,
 * so this is a distinct fallback from both link-following (paginateRoles)
 * and in-place expansion (expandShowMoreListing): click, wait, re-extract,
 * repeat — replacing the accumulated roles each round rather than expanding
 * the same page's content. Matched by aria-label since these buttons are
 * often icon-only with no visible text. */
const NEXT_PAGE_BUTTON_SELECTOR =
  '[aria-label*="next" i]:not([aria-label*="similar" i]), button[aria-label*="Next page" i]';

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
    private readonly locations: LocationsService,
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

  /** One row per tracked company, combining open-role discovery status with
   * resume status — the single unified list the Company Resumes page shows
   * (previously two separate lists: tracked companies here, and a resume
   * list independently re-derived from Application.company, which could
   * show "Amazon" and "Amazon.com Services LLC" as two different rows since
   * it wasn't using the same normalized-name matching as company tracking).
   * Resume rows are matched to a TrackedCompany by normalized name, same
   * logic used everywhere else a company name gets deduped. */
  async listCompanies() {
    const [companies, resumes] = await Promise.all([
      this.prisma.trackedCompany.findMany({
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { roles: true } } },
      }),
      this.prisma.companyResume.findMany(),
    ]);

    const resumeByKey = new Map(resumes.map((r) => [normalizeCompanyKey(r.company), r]));

    return companies.map((company) => {
      const resume = resumeByKey.get(normalizeCompanyKey(company.name));
      return {
        ...company,
        hasResume: !!resume,
        resumeCompanyKey: resume?.company ?? company.name,
        resumeUpdatedAt: resume?.updatedAt ?? null,
      };
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
      const company = await this.prisma.trackedCompany.findUniqueOrThrow({ where: { name } });
      // Re-scans stop paginating as soon as a page's roles overlap with ones
      // already known for this company — boards are date-sorted newest-first,
      // so hitting an already-seen role means everything past that point was
      // already captured in a prior scan. A brand-new company has no known
      // URLs, so its first scan naturally isn't affected by this at all.
      const existingRoles = await this.prisma.discoveredRole.findMany({
        where: { companyId: company.id },
        select: { roleUrl: true },
      });
      const knownRoleUrls = new Set(existingRoles.map((r) => r.roleUrl));

      const { careerPageUrl, roles } = await this.findRolesForCompany(name, seedUrl, knownRoleUrls);

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
    seedUrl: string | undefined,
    knownRoleUrls: Set<string>,
  ): Promise<{ careerPageUrl?: string; roles: DiscoveredRoleDto[] }> {
    // A known-good URL (derived from a real job posting, or manually
    // entered) is tried before any guess — it's known to work for this
    // company, not a guess, so it goes first in the candidate list.
    const candidates = [...(seedUrl ? [seedUrl] : []), ...CAREER_URL_GUESSES(name)];

    for (const url of candidates) {
      try {
        const pageText = await this.renderPageText(url, { expandShowMoreListing: true });
        if (!pageText || pageText.length < 200) continue;

        const { roles: firstPageRoles, nextPageUrl } = await this.extractRolesWithLlm(pageText, url);
        if (firstPageRoles.length === 0) continue;

        const roles = nextPageUrl
          ? await this.paginateRoles(firstPageRoles, nextPageUrl, url, knownRoleUrls)
          : await this.paginateWithClicks(firstPageRoles, url, knownRoleUrls);
        return { careerPageUrl: url, roles };
      } catch {
        // Try the next candidate URL — a 404/timeout on one guess is expected.
        continue;
      }
    }

    return { roles: [] };
  }

  /** Follows a listing's "Next page" links, accumulating roles, until: no
   * more roles come back, there's no next page, the page cap is hit, a
   * page's roles are ALL older than the staleness cutoff (later pages of a
   * date-sorted listing only get older, so this is a safe stop condition,
   * not just an optimization), OR — on a re-scan — a page contains a role
   * already known for this company, since boards are newest-first and
   * hitting a known role means everything after it was already captured. */
  private async paginateRoles(
    firstPageRoles: DiscoveredRoleDto[],
    nextPageUrl: string | undefined,
    firstPageUrl: string,
    knownRoleUrls: Set<string>,
  ): Promise<DiscoveredRoleDto[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_ROLE_AGE_DAYS);
    const isStale = (r: DiscoveredRoleDto) => {
      if (!r.postedDate) return false; // undated — can't judge, don't use it to stop early
      const posted = new Date(r.postedDate);
      return !isNaN(posted.getTime()) && posted < cutoff;
    };
    const hitsKnownRole = (pageRoles: DiscoveredRoleDto[]) =>
      pageRoles.some((r) => knownRoleUrls.has(r.url));

    const allRoles = [...firstPageRoles];
    let currentNextUrl = nextPageUrl;
    let previousUrl = firstPageUrl;
    let pageCount = 1;

    if (hitsKnownRole(firstPageRoles)) return allRoles;

    while (currentNextUrl && pageCount < MAX_LISTING_PAGES) {
      // Guard against a broken pagination link that points back to a page
      // we've already fetched (would otherwise loop until the page cap).
      if (currentNextUrl === previousUrl) break;

      try {
        const pageText = await this.renderPageText(currentNextUrl, { expandShowMoreListing: true });
        if (!pageText || pageText.length < 200) break;

        const { roles: pageRoles, nextPageUrl: followingUrl } = await this.extractRolesWithLlm(
          pageText,
          currentNextUrl,
        );
        if (pageRoles.length === 0) break;

        allRoles.push(...pageRoles);
        pageCount += 1;

        if (hitsKnownRole(pageRoles) || pageRoles.every(isStale)) break;

        previousUrl = currentNextUrl;
        currentNextUrl = followingUrl;
      } catch {
        break;
      }
    }

    return allRoles;
  }

  /** Fallback for boards that paginate via a JS-driven "next page" BUTTON
   * rather than a real link (e.g. Microsoft's careers site) — extractRolesWithLlm
   * never gets a nextPageUrl for these, so paginateRoles alone stops after
   * page 1. Opens its own page (rather than reusing renderPageText's, which
   * closes its page before returning) and stays on it across clicks, since
   * each click mutates the SAME page's DOM in place instead of navigating to
   * a new URL. Same stop conditions as paginateRoles: page cap, no roles
   * found, an entire round is stale, or (on a re-scan) a round hits an
   * already-known role — plus stopping the moment the "next" button itself
   * is gone or disabled. */
  private async paginateWithClicks(
    firstPageRoles: DiscoveredRoleDto[],
    url: string,
    knownRoleUrls: Set<string>,
  ): Promise<DiscoveredRoleDto[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_ROLE_AGE_DAYS);
    const isStale = (r: DiscoveredRoleDto) => {
      if (!r.postedDate) return false;
      const posted = new Date(r.postedDate);
      return !isNaN(posted.getTime()) && posted < cutoff;
    };
    const hitsKnownRole = (pageRoles: DiscoveredRoleDto[]) =>
      pageRoles.some((r) => knownRoleUrls.has(r.url));

    const browser = await this.getBrowser();
    const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (compatible; job-tracker/0.1)' });
    const allRoles = [...firstPageRoles];

    if (hitsKnownRole(firstPageRoles)) {
      await page.close();
      return allRoles;
    }

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });

      for (let pageCount = 1; pageCount < MAX_LISTING_PAGES; pageCount++) {
        const nextButton = page.locator(NEXT_PAGE_BUTTON_SELECTOR).first();
        const buttonCount = await nextButton.count();
        if (buttonCount === 0) break;

        const isDisabled = await nextButton
          .evaluate((el) => el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled)
          .catch(() => true);
        if (isDisabled) break;

        const visible = await nextButton.isVisible().catch(() => false);
        if (!visible) break;

        await nextButton.click().catch(() => {
          throw new Error('next-page button click failed');
        });

        try {
          await page.waitForLoadState('networkidle', { timeout: 5000 });
        } catch {
          // Some boards never go fully idle (polling/analytics) — the fixed
          // settle delay below still lets new roles render.
        }
        await page.waitForTimeout(500);

        const html = await page.content();
        const $ = cheerio.load(html);
        $('script, style, noscript').remove();
        const pageText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 60000);
        if (!pageText || pageText.length < 200 || looksLikeJsonDump(pageText)) break;

        const { roles: pageRoles } = await this.extractRolesWithLlm(pageText, page.url());
        if (pageRoles.length === 0) break;

        allRoles.push(...pageRoles);
        if (hitsKnownRole(pageRoles) || pageRoles.every(isStale)) break;
      }
    } catch (err) {
      this.logger.warn(`Click-based pagination stopped early for ${url}: ${err}`);
    } finally {
      await page.close();
    }

    return allRoles;
  }

  private async renderPageText(
    url: string,
    opts?: { requireSameOrigin?: boolean; expandShowMoreListing?: boolean },
  ): Promise<string> {
    const browser = await this.getBrowser();
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (compatible; job-tracker/0.1)',
    });
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
      if (opts?.expandShowMoreListing) {
        await this.expandShowMoreListing(page);
      }
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
      // Some Eightfold-powered boards (e.g. Netflix) render a large JSON app-
      // state blob as literal body text, not inside a <script> tag — it's
      // long, so a length-only check treats it as "real" content, but it's
      // pure garbage for both JD extraction and date parsing. Prefer
      // og:description whenever bodyText is short OR JSON-dominated.
      const useBodyText = bodyText.length > 200 && !looksLikeJsonDump(bodyText);
      return (useBodyText ? bodyText : ogDescription || bodyText).slice(0, 60000);
    } finally {
      await page.close();
    }
  }

  /** Expands a "Show more"/"Load more"/infinite-scroll listing in place before
   * its text is read — some career boards append roles into the same DOM
   * instead of exposing real pagination, so extractRolesWithLlm would only
   * ever see the first batch otherwise (there's no nextPageUrl for
   * paginateRoles to follow). Each round: scroll to the bottom (triggers
   * scroll-based lazy loading), then click a "show/load/view more" button if
   * one is now visible, then wait briefly for new content. Stops once a round
   * adds nothing new, or after MAX_LOAD_MORE_ROUNDS regardless — a listing
   * that keeps growing every round (e.g. a broken loader re-appending the same
   * roles) must not be followed forever. */
  private async expandShowMoreListing(page: Page): Promise<void> {
    let previousHeight = 0;
    for (let round = 0; round < MAX_LOAD_MORE_ROUNDS; round++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(500);

      const clicked = await page.evaluate((pattern) => {
        const regex = new RegExp(pattern, 'i');
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>('button, a, [role="button"]'),
        );
        const target = candidates.find(
          (el) => el.offsetParent !== null && regex.test(el.textContent ?? ''),
        );
        if (!target) return false;
        target.click();
        return true;
      }, LOAD_MORE_TEXT_PATTERN.source);

      try {
        await page.waitForLoadState('networkidle', { timeout: 5000 });
      } catch {
        // Some infinite-scroll boards never go fully idle (polling/analytics)
        // — a fixed settle delay below still lets the new roles render.
      }
      await page.waitForTimeout(500);

      const newHeight = await page.evaluate(() => document.body.scrollHeight);
      if (!clicked && newHeight <= previousHeight) break;
      previousHeight = newHeight;
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

  async listRoles(params: { unselectedOnly?: boolean; selectedOnly?: boolean }) {
    const roles = await this.prisma.discoveredRole.findMany({
      where: {
        ...(params.unselectedOnly && { applicationId: null }),
        ...(params.selectedOnly && { applicationId: { not: null } }),
      },
      include: { company: true },
      orderBy: [{ postedDate: 'desc' }, { createdAt: 'desc' }],
    });

    // Highest ATS match first so the best-fit open roles surface at the top
    // instead of being ordered purely by posting recency; unscored roles
    // (still being scored, or scoring failed) sort after every scored role
    // rather than before, since a null score isn't "better" than a low one.
    return [...roles].sort((a, b) => {
      if (a.atsScore === null && b.atsScore === null) return 0;
      if (a.atsScore === null) return 1;
      if (b.atsScore === null) return -1;
      return b.atsScore - a.atsScore;
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

    const candidateLocation = this.extractCandidateLocation(profile);

    await this.runWithConcurrency(roles, SCORING_CONCURRENCY, async (role) => {
      try {
        const jdText = role.jdText || (await this.fetchRoleJd(role.roleUrl));
        if (!jdText) {
          // Couldn't resolve a real per-posting page (e.g. the board
          // redirected to a generic careers/search page) — leave atsScore
          // null (shown as "unavailable") rather than scoring against the
          // wrong content.
          return;
        }
        const result = await this.estimateAtsScore(jdText, profile, entries);
        await this.prisma.discoveredRole.update({
          where: { id: role.id },
          data: {
            jdText: role.jdText || jdText || undefined,
            atsScore: result.score,
            atsScoreComputedAt: new Date(),
            roleIsRemote: result.isRemote,
            roleCountry: result.country,
            roleState: result.state,
            roleCity: result.city,
            locationMismatch: this.computeLocationMismatch(result, candidateLocation),
          },
        });
      } catch (err) {
        this.logger.warn(`ATS scoring failed for role ${role.id}: ${err}`);
      }
    });
  }

  /** Resolves the candidate profile's stored country/state codes (from the
   * dropdowns) to display names, so they compare cleanly against a JD's
   * free-form extracted location in computeLocationMismatch(). */
  private extractCandidateLocation(profile: unknown): {
    country: string | null;
    state: string | null;
    openToRemote: boolean;
  } {
    const p = (profile ?? {}) as {
      locationCountry?: string | null;
      locationState?: string | null;
      openToRemote?: boolean;
    };
    const countryCode = p.locationCountry ?? null;
    return {
      country: countryCode ? this.locations.countryName(countryCode) : null,
      state: countryCode && p.locationState ? this.locations.stateName(countryCode, p.locationState) : null,
      openToRemote: !!p.openToRemote,
    };
  }

  /** Runs `fn` over `items` with at most `limit` in flight at once — scoring
   * a company's roles one-at-a-time (each a headless-browser page load plus
   * an LLM round trip) made discovery scoring take minutes for companies with
   * many open roles; a small worker pool keeps it bounded without opening
   * unlimited concurrent browser pages/LLM calls. */
  private async runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    let index = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) {
        const item = items[index++];
        await fn(item);
      }
    });
    await Promise.all(workers);
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
    const result = await this.estimateAtsScore(jdText, profile, entries);
    const candidateLocation = this.extractCandidateLocation(profile);

    return this.prisma.discoveredRole.update({
      where: { id: roleId },
      data: {
        jdText: role.jdText || jdText || undefined,
        atsScore: result.score,
        atsScoreComputedAt: new Date(),
        roleIsRemote: result.isRemote,
        roleCountry: result.country,
        roleState: result.state,
        roleCity: result.city,
        locationMismatch: this.computeLocationMismatch(result, candidateLocation),
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

  /** Lightweight ATS match estimate (0-100) plus the JD's location signal —
   * one LLM call rather than two separate round trips, since both need the
   * same JD text in context. isRemote/country/state/city describe where the
   * role itself is based (or, for a geography-restricted remote role, the
   * country/state its remote eligibility is restricted to, e.g. "Remote (US
   * only)" -> isRemote true, country "United States"). state/country are left
   * null when a remote role isn't restricted to a specific state/country.
   * Any field the JD doesn't state is null. */
  private async estimateAtsScore(
    jdText: string,
    profile: unknown,
    entries: unknown,
  ): Promise<{
    score: number | null;
    isRemote: boolean | null;
    country: string | null;
    state: string | null;
    city: string | null;
  }> {
    const empty = { score: null, isRemote: null, country: null, state: null, city: null };
    if (!jdText) return empty;

    const endpoint = process.env.AZURE_LLM_ENDPOINT;
    const apiKey = process.env.AZURE_LLM_API_KEY;
    const deployment = process.env.AZURE_LLM_DEPLOYMENT_NAME ?? 'gpt-4.1';
    const apiVersion = process.env.AZURE_LLM_API_VERSION ?? '2024-12-01-preview';
    if (!endpoint || !apiKey) return empty;

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
              'screening purposes, and extract the JD\'s work-location signal. Return ONLY a ' +
              'JSON object: {"score": <integer 0-100>, "isRemote": boolean|null, ' +
              '"country": string|null, "state": string|null, "city": string|null}. score: base ' +
              'it on keyword/skill overlap, seniority match, and domain relevance between the ' +
              "candidate's background and the JD's requirements. Be realistic, not generous. " +
              'isRemote: true if the JD says the role is remote/work-from-home/distributed (even ' +
              'if restricted to certain locations), false if it explicitly requires onsite/hybrid ' +
              'office presence, null if the JD says nothing about work location at all. country: ' +
              'full country name (e.g. "United States") the role is based in, or — if remote — the ' +
              'country its remote eligibility is restricted to if the JD states one (e.g. "Remote ' +
              '(US only)" -> "United States"); null if unstated or remote with no country ' +
              'restriction. state: the state/province/region the role is based in, or the specific ' +
              'state remote eligibility is restricted to if the JD states one; null otherwise ' +
              '(including remote roles open anywhere in the country). city: the city the role is ' +
              'based in if stated; null for remote roles or if unstated. Use full names, not ' +
              'abbreviations or codes.',
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
    if (!response.ok) return empty;

    const data = (await response.json()) as { choices: { message: { content: string } }[] };
    const raw = data.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw) as {
      score?: number;
      isRemote?: boolean | null;
      country?: string | null;
      state?: string | null;
      city?: string | null;
    };
    return {
      score: typeof parsed.score === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.score))) : null,
      isRemote: typeof parsed.isRemote === 'boolean' ? parsed.isRemote : null,
      country: parsed.country || null,
      state: parsed.state || null,
      city: parsed.city || null,
    };
  }

  /** Whether a scored role's extracted location conflicts with the
   * candidate's own country/state (city is never checked — see
   * ResumePromptTemplate.locationCity's doc comment). Null means "can't
   * tell" (candidate hasn't set a location, or the JD gave no location
   * signal at all) rather than a mismatch, since flagging every role as a
   * mismatch when there's nothing to compare would make the flag useless.
   *
   * - Onsite/hybrid role (isRemote false/null with a stated country): matches
   *   only if country (+ state, when the JD stated one) equals the
   *   candidate's.
   * - Remote role: matches if the candidate is open to remote AND the JD's
   *   remote-eligible geography (if it restricts one) covers the candidate's
   *   country/state. An unrestricted remote role always matches once the
   *   candidate is open to remote. */
  private computeLocationMismatch(
    role: { isRemote: boolean | null; country: string | null; state: string | null },
    candidate: { country: string | null; state: string | null; openToRemote: boolean },
  ): boolean | null {
    if (!candidate.country) return null;

    const namesMatch = (a: string | null, b: string | null) =>
      !a || !b || a.trim().toLowerCase() === b.trim().toLowerCase();

    if (role.isRemote) {
      if (!candidate.openToRemote) return true;
      if (!namesMatch(role.country, candidate.country)) return true;
      if (role.country && role.state && !namesMatch(role.state, candidate.state)) return true;
      return false;
    }

    if (!role.country) return null; // onsite/unstated with no location signal at all — can't judge
    if (!namesMatch(role.country, candidate.country)) return true;
    if (role.state && !namesMatch(role.state, candidate.state)) return true;
    return false;
  }
}
