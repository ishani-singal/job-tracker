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
import { LlmKillSwitchService } from '../llm-kill-switch/llm-kill-switch.service';
import { BudgetExceededError, LlmCallsService } from '../llm-calls/llm-calls.service';

type ChatUsage = Parameters<LlmCallsService['recordAzureUsage']>[2];

/** Roles posted before this many days ago are dropped during discovery —
 * stale postings clutter the candidate pool and are usually already filled
 * or about to be. Undated roles (no postedDate could be extracted) are kept
 * since we can't tell either way. */
const MAX_ROLE_AGE_DAYS = 15;

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

/** Some SPAs (e.g. Google's careers site) return HTTP 200 on the same URL
 * with no redirect for a delisted/removed/not-found job, but silently fall
 * back to rendering a generic SEARCH RESULTS listing (other, unrelated open
 * roles) instead of a real 404 or the requested JD — verified directly
 * against a stale Google job URL: 200, same origin, page text literally
 * contains "Jobs search results" and "N jobs matched" followed by a list of
 * other jobs' titles/locations, not the requested posting. A naive
 * "contains JD vocabulary" check is fooled by this, since the fallback
 * listing's job titles/snippets do contain real words like "experience" —
 * matching on the search-results page's own literal UI copy is far more
 * precise. requireSameOrigin's domain/generic-listing checks don't catch
 * this either, since the URL is a genuine specific-job path, not a bounce to
 * a listing root. */
function looksLikeSearchResultsFallback(text: string): boolean {
  return /jobs?\s+search\s+results|\b\d[\d,]*\s+jobs?\s+matched\b/i.test(text.slice(0, 3000));
}

/** Some boards (e.g. Google careers) render each job card as a visually
 * empty full-card overlay <a href> with no text content at all — the actual
 * title lives in a sibling/descendant element for styling purposes — but the
 * anchor still carries a descriptive aria-label like "Learn more about
 * <title>". Falls back to that (with the common "Learn more about " prefix
 * stripped) whenever the anchor's own visible text is empty, so these links
 * aren't silently dropped by the "no text = not a real link" filter. */
function extractLinkText($el: ReturnType<cheerio.CheerioAPI>): string {
  const text = $el.text().replace(/\s+/g, ' ').trim();
  if (text) return text;
  const ariaLabel = $el.attr('aria-label')?.trim() ?? '';
  return ariaLabel.replace(/^(learn more about|view|apply (for|to))\s+/i, '').trim();
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
 * forever — not a page-count cap. Pagination in paginateRoles/
 * paginateWithClicks stops only on the real conditions: no more roles, no
 * next page, hitting an already-known role (re-scans), or every role on a
 * page being past the staleness cutoff (later pages of a date-sorted
 * listing only get older). MAX_LISTING_PAGES exists purely so a broken
 * pagination link/button that cycles back to itself can't loop forever —
 * it should never be the thing that actually ends a normal scan. */
const MAX_LISTING_PAGES = Number.MAX_SAFE_INTEGER;

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
posted), url (string — if a "Real links found on this page" list is provided, you MUST copy the
url for this role EXACTLY from that list; NEVER construct, guess, or slugify a URL yourself from
the job title even if it looks like a plausible pattern for this site — if no matching link is in
the list, omit the role entirely rather than inventing one. If no links list is provided, resolve
a relative link against the page's own URL, and still omit the role if you cannot find a real
URL for it), postedDate (ISO date string YYYY-MM-DD, or null — resolve relative phrasing like
"Posted 3 days ago" or "2 weeks ago" against today's date; only null if there's truly no recency
signal for that role), location (string, or null — the city/state/country or "Remote" shown for
that role on the listing, copied as shown, e.g. "Seattle, WA"; if a role lists several locations
keep them all in one string; null if the listing shows none for it). Only include actual open roles — skip navigation links, footer text, "view
all jobs" links, benefits/culture content, and anything that isn't a specific job posting.
nextPageUrl: the FULL absolute URL of a "Next page"/"Next"/pagination-forward link if this
listing spans multiple pages and one is present (prefer picking it from the links list too, by
its link text) — null if there's no next page or the page isn't paginated. If the page clearly
isn't a career/jobs listing page at all, return {"roles": [], "nextPageUrl": null}.`;
}

/** Job titles only, no URL — used by discoverRolesByClickingCards for boards
 * with real listings but zero real per-posting <a href> links (URLs get
 * discovered separately by clicking each matching card). */
function buildTitleOnlyExtractionPrompt(): string {
  return `You extract job posting TITLES ONLY from raw career-page text — this page has no
usable per-posting links, so URLs will be discovered separately by clicking each card. Return
ONLY a JSON object: {"titles": [string, ...]}. Each entry is the exact job title as posted,
verbatim (needed to find and click the matching element later — do not paraphrase, truncate, or
reformat it). Only include actual open roles — skip navigation, footer text, "view all jobs"
links, benefits/culture content, and anything that isn't a specific job posting. If the page
clearly isn't a career/jobs listing page at all, return {"titles": []}.`;
}

/** On a re-scan, this many consecutive pages containing no role that wasn't
 * already known ends pagination — the stop for undated boards (e.g. Meta's job
 * search), where the "reached a known role" rule can't be trusted because
 * there's no newest-first order to rely on. A first scan has no known roles,
 * so it never triggers. */
const KNOWN_PAGE_STREAK_STOP = 3;

/** How a scan's pagination ended — 'no-next-page', 'known-role' (re-scan
 * reached already-captured roles) and 'stale' (reached roles past the age
 * cutoff) are natural stops; the rest mean the board may not have been read
 * to its end. */
type ScanEnd = 'no-next-page' | 'known-role' | 'stale' | 'next-link-repeated' | 'empty-page' | 'error';

interface ScanStats {
  method: 'links' | 'click-cards' | 'api';
  pages: number;
  end: ScanEnd | null;
  /** Total the job API reported (method 'api' only). */
  apiTotal?: number;
}

type ScanConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

/** Grades how complete a scan's coverage of the board likely is, from how
 * pagination ended and how many roles carried a posting date (undated roles
 * defeat the stale-stop, so a mostly-undated board is less certain). */
function scanConfidence(
  stats: ScanStats,
  rolesFound: number,
  datedRoles: number,
): { level: ScanConfidenceLevel; note: string } {
  if (rolesFound === 0) return { level: 'LOW', note: 'No roles were extracted from the career page.' };
  if (stats.method === 'api') {
    // A job API lists everything with a total to check against, so it's the
    // most certain method (it just doesn't carry posting dates).
    return stats.end === 'no-next-page'
      ? { level: 'HIGH', note: `Read all ${rolesFound} roles from the board's job API.` }
      : {
          level: 'MEDIUM',
          note: `The board's job API reported ${stats.apiTotal ?? '?'} roles but only ${rolesFound} were read.`,
        };
  }
  if (stats.method === 'click-cards') {
    return { level: 'LOW', note: 'Fell back to clicking job cards (capped per scan) — likely incomplete.' };
  }

  let level: ScanConfidenceLevel;
  let note: string;
  switch (stats.end) {
    case 'error':
      level = stats.pages <= 1 ? 'LOW' : 'MEDIUM';
      note = `Pagination stopped on an error after ${stats.pages} page${stats.pages === 1 ? '' : 's'}.`;
      break;
    case 'empty-page':
      level = 'MEDIUM';
      note = `A page came back empty after ${stats.pages} page${stats.pages === 1 ? '' : 's'} — the board may continue.`;
      break;
    case 'next-link-repeated':
      level = 'MEDIUM';
      note = 'The next-page link pointed back to a page already read, so pagination stopped.';
      break;
    case 'no-next-page':
      if (stats.pages <= 1 && rolesFound >= 10) {
        level = 'MEDIUM';
        note = `Only one page was read (${rolesFound} roles) and no next page was found — the board may have more.`;
      } else {
        level = 'HIGH';
        note = `Read to the end of the listing (${stats.pages} page${stats.pages === 1 ? '' : 's'}).`;
      }
      break;
    case 'known-role':
      level = 'HIGH';
      note = `Reached roles already captured by an earlier scan (${stats.pages} page${stats.pages === 1 ? '' : 's'}).`;
      break;
    case 'stale':
      level = 'HIGH';
      note = `Read back to roles older than ${MAX_ROLE_AGE_DAYS} days (${stats.pages} page${stats.pages === 1 ? '' : 's'}).`;
      break;
    default:
      level = 'MEDIUM';
      note = 'Could not tell how the scan ended.';
  }

  if (datedRoles / rolesFound < 0.5) {
    const pct = Math.round((datedRoles / rolesFound) * 100);
    level = level === 'HIGH' ? 'MEDIUM' : 'LOW';
    note += ` Only ${pct}% of roles had a posting date.`;
  }
  return { level, note };
}

export interface DiscoveredRoleDto {
  title: string;
  url: string;
  postedDate?: string;
  /** Listing's location text; folded into `title` at extraction time. */
  location?: string | null;
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
    private readonly killSwitch: LlmKillSwitchService,
    private readonly llmCalls: LlmCallsService,
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

  /** Navigates and waits for the page to settle, tolerating boards that
   * never go fully idle (persistent polling/analytics/websockets — verified
   * on Expedia's careers page: `waitUntil: 'networkidle'` timed out
   * completely even though the page had loaded and rendered 192 real job
   * listings, so the whole candidate URL was silently abandoned via the
   * caller's catch-and-continue). Tries networkidle first (the strongest
   * signal that dynamic content has finished rendering) and, only if that
   * throws, falls back to domcontentloaded + a fixed settle delay instead of
   * giving up on the page entirely. */
  private async gotoAndSettle(page: Page, url: string, timeout = 25000): Promise<void> {
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout });
    } catch {
      // Verified on Autodesk's careers SPA: networkidle sometimes takes just
      // over the timeout (~12-16s, right at the boundary — a genuinely slow
      // but working page, not a page that never idles like Expedia), and a
      // too-short settle delay here (2s) reliably undershoots how long its
      // client-side render actually takes (~5-6s+ after domcontentloaded).
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      await page.waitForTimeout(6000);
    }
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
        include: { _count: { select: { roles: true, contacts: true } } },
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

      // Each page's roles are written to the DB as soon as they're
      // extracted (via this callback, threaded through findRolesForCompany
      // -> paginateRoles/paginateWithClicks) instead of only at the very
      // end of the whole scan — a large board (Amazon: ~2376 roles across
      // dozens of pages) used to lose ALL progress if the scan was
      // interrupted (rate-limited, restarted, stopped) before the last
      // page finished; now every page already fetched is durably saved
      // regardless of how far the scan gets.
      const persistPage = async (pageRoles: DiscoveredRoleDto[]) => {
        await this.persistRoles(company.id, pageRoles);
      };

      const stats: ScanStats = { method: 'links', pages: 0, end: null };
      const { careerPageUrl, roles } = await this.findRolesForCompany(
        name,
        seedUrl,
        knownRoleUrls,
        persistPage,
        stats,
      );
      const confidence = scanConfidence(stats, roles.length, roles.filter((r) => r.postedDate).length);

      await this.prisma.trackedCompany.update({
        where: { id: company.id },
        data: {
          careerPageUrl,
          discoveryStatus: 'DONE',
          lastDiscoveredAt: new Date(),
          lastScanConfidence: confidence.level,
          lastScanConfidenceNote: confidence.note,
        },
      });

      // Scoring is no longer triggered automatically after discovery — it
      // burns one LLM call per role, so it now only runs when the user
      // clicks "Score" on a specific role (see rescoreRole).
    } catch (err) {
      await this.prisma.trackedCompany.update({
        where: { name },
        data: { discoveryStatus: 'FAILED', discoveryError: String(err) },
      });
    }
  }

  /** Upserts one page's worth of roles immediately, filtering out anything
   * past the staleness cutoff first. Called once per page during discovery
   * (see the persistPage callback in discoverForCompany) rather than once
   * for the whole scan's accumulated results, so progress is never lost if
   * the scan is interrupted partway through. */
  private async persistRoles(companyId: string, roles: DiscoveredRoleDto[]): Promise<void> {
    if (roles.length === 0) return;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_ROLE_AGE_DAYS);

    const kept = roles.filter((r) => {
      if (!r.postedDate) return true;
      const posted = new Date(r.postedDate);
      return isNaN(posted.getTime()) || posted >= cutoff;
    });

    for (const role of kept) {
      await this.prisma.discoveredRole.upsert({
        where: { companyId_roleUrl: { companyId, roleUrl: role.url } },
        update: {
          title: role.title,
          postedDate: role.postedDate ? new Date(role.postedDate) : null,
        },
        create: {
          companyId,
          title: role.title,
          roleUrl: role.url,
          postedDate: role.postedDate ? new Date(role.postedDate) : null,
        },
      });
    }
  }

  private async findRolesForCompany(
    name: string,
    seedUrl: string | undefined,
    knownRoleUrls: Set<string>,
    persistPage: (pageRoles: DiscoveredRoleDto[]) => Promise<void>,
    stats: ScanStats,
  ): Promise<{ careerPageUrl?: string; roles: DiscoveredRoleDto[] }> {
    // A known-good URL (derived from a real job posting, or manually
    // entered) is tried before any guess — it's known to work for this
    // company, not a guess, so it goes first in the candidate list.
    const candidates = [...(seedUrl ? [seedUrl] : []), ...CAREER_URL_GUESSES(name)];

    for (const url of candidates) {
      try {
        const { text: pageText, links } = await this.renderPageText(url, {
          expandShowMoreListing: true,
          includeLinks: true,
        });
        if (!pageText || pageText.length < 200) continue;

        const { roles: firstPageRoles, nextPageUrl } = await this.extractRolesWithLlm(pageText, url, links);
        if (firstPageRoles.length === 0) {
          // The LLM found no roles it could match to a real link — this
          // includes both "genuinely no jobs on this page" AND "real jobs,
          // but the per-posting elements have no <a href> at all" (e.g.
          // Netflix's Eightfold board: nav/footer links exist, so links
          // isn't empty, but none of them are job postings — a role-less
          // <div role="button"> card is clicked instead, updating a
          // ?pid=<id> query param). Not gated on links.length === 0: a page
          // can have real (nav-only) links and still need the click
          // fallback. Worth a bounded attempt before giving up on this
          // candidate; a genuinely job-less page still correctly returns
          // nothing from the title extraction either way.
          if (pageText.length > 500) {
            const apiRoles = await this.discoverRolesViaEightfoldApi(url, stats, persistPage);
            if (apiRoles.length > 0) return { careerPageUrl: url, roles: apiRoles };
            const clickedRoles = await this.discoverRolesByClickingCards(url);
            if (clickedRoles.length > 0) {
              stats.method = 'click-cards';
              await persistPage(clickedRoles);
              return { careerPageUrl: url, roles: clickedRoles };
            }
          }
          continue;
        }
        await persistPage(firstPageRoles);

        const roles = nextPageUrl
          ? await this.paginateRoles(firstPageRoles, nextPageUrl, url, knownRoleUrls, persistPage, stats)
          : await this.paginateWithClicks(firstPageRoles, url, knownRoleUrls, persistPage, stats);
        return { careerPageUrl: url, roles };
      } catch (err) {
        // A spent daily budget isn't a bad URL — stop rather than retry every guess.
        if (err instanceof BudgetExceededError) throw err;
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
    persistPage: (pageRoles: DiscoveredRoleDto[]) => Promise<void>,
    stats: ScanStats,
  ): Promise<DiscoveredRoleDto[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_ROLE_AGE_DAYS);
    const isStale = (r: DiscoveredRoleDto) => {
      if (!r.postedDate) return false; // undated — can't judge, don't use it to stop early
      const posted = new Date(r.postedDate);
      return !isNaN(posted.getTime()) && posted < cutoff;
    };
    // Only trust "reached a known role" as the end of what's new when this
    // page's roles are dated: it presumes a newest-first listing, which an
    // undated board (e.g. Meta's job search) gives no evidence of — there,
    // overlapping an earlier scan's roles says nothing about what's left.
    const hitsKnownRole = (pageRoles: DiscoveredRoleDto[]) =>
      pageRoles.some((r) => r.postedDate) && pageRoles.some((r) => knownRoleUrls.has(r.url));

    const allRoles = [...firstPageRoles];
    let currentNextUrl = nextPageUrl;
    let previousUrl = firstPageUrl;
    let pageCount = 1;
    stats.pages = 1;
    const allKnown = (pageRoles: DiscoveredRoleDto[]) => pageRoles.every((r) => knownRoleUrls.has(r.url));
    let knownStreak = allKnown(firstPageRoles) ? 1 : 0;

    if (hitsKnownRole(firstPageRoles)) {
      stats.end = 'known-role';
      return allRoles;
    }

    stats.end = 'no-next-page';
    while (currentNextUrl && pageCount < MAX_LISTING_PAGES) {
      // Guard against a broken pagination link that points back to a page
      // we've already fetched (would otherwise loop until the page cap).
      if (currentNextUrl === previousUrl) {
        stats.end = 'next-link-repeated';
        break;
      }

      try {
        // A blank/failed render or an extraction that finds nothing is often
        // transient on a deep page, so try the page once more before treating
        // it as the end of the listing.
        let pageRoles: DiscoveredRoleDto[] = [];
        let followingUrl: string | undefined;
        for (let attempt = 0; attempt < 2 && pageRoles.length === 0; attempt++) {
          const { text: pageText, links } = await this.renderPageText(currentNextUrl, {
            expandShowMoreListing: true,
            includeLinks: true,
          });
          if (!pageText || pageText.length < 200) continue;
          ({ roles: pageRoles, nextPageUrl: followingUrl } = await this.extractRolesWithLlm(
            pageText,
            currentNextUrl,
            links,
          ));
        }
        if (pageRoles.length === 0) {
          stats.end = 'empty-page';
          break;
        }

        allRoles.push(...pageRoles);
        await persistPage(pageRoles);
        pageCount += 1;
        stats.pages = pageCount;

        if (hitsKnownRole(pageRoles)) {
          stats.end = 'known-role';
          break;
        }
        if (pageRoles.every(isStale)) {
          stats.end = 'stale';
          break;
        }
        knownStreak = allKnown(pageRoles) ? knownStreak + 1 : 0;
        if (knownStreak >= KNOWN_PAGE_STREAK_STOP) {
          stats.end = 'known-role';
          break;
        }

        previousUrl = currentNextUrl;
        currentNextUrl = followingUrl;
        // Falling out of the loop because there's no further link is the
        // natural end; reset in case a previous iteration set something else.
        stats.end = 'no-next-page';
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        stats.end = 'error';
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
    persistPage: (pageRoles: DiscoveredRoleDto[]) => Promise<void>,
    stats: ScanStats,
  ): Promise<DiscoveredRoleDto[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_ROLE_AGE_DAYS);
    const isStale = (r: DiscoveredRoleDto) => {
      if (!r.postedDate) return false;
      const posted = new Date(r.postedDate);
      return !isNaN(posted.getTime()) && posted < cutoff;
    };
    // Only trust "reached a known role" as the end of what's new when this
    // page's roles are dated: it presumes a newest-first listing, which an
    // undated board (e.g. Meta's job search) gives no evidence of — there,
    // overlapping an earlier scan's roles says nothing about what's left.
    const hitsKnownRole = (pageRoles: DiscoveredRoleDto[]) =>
      pageRoles.some((r) => r.postedDate) && pageRoles.some((r) => knownRoleUrls.has(r.url));

    const browser = await this.getBrowser();
    const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (compatible; job-tracker/0.1)' });
    const allRoles = [...firstPageRoles];
    stats.pages = 1;
    const allKnown = (pageRoles: DiscoveredRoleDto[]) => pageRoles.every((r) => knownRoleUrls.has(r.url));
    let knownStreak = allKnown(firstPageRoles) ? 1 : 0;

    if (hitsKnownRole(firstPageRoles)) {
      stats.end = 'known-role';
      await page.close();
      return allRoles;
    }

    // Overwritten below if the loop stops for any reason other than the
    // "next" button being gone/disabled (the natural end).
    stats.end = 'no-next-page';
    try {
      await this.gotoAndSettle(page, url);
      // This is a fresh page/navigation (separate from the one that found
      // firstPageRoles), so any sort selection from that earlier page's
      // client-side state doesn't carry over here — re-apply it.
      await this.sortByDateIfAvailable(page);

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
        const currentUrl = page.url();
        const pageLinks = $('a[href]')
          .map((_, el) => {
            const $el = $(el);
            const text = extractLinkText($el);
            const href = $el.attr('href')?.trim() ?? '';
            return { text, href };
          })
          .get()
          .filter((l) => l.text && l.href && !l.href.startsWith('#') && !l.href.startsWith('javascript:'))
          .map((l) => ({ ...l, href: this.resolveUrl(l.href, currentUrl) }));
        $('script, style, noscript').remove();
        const pageText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 60000);
        if (!pageText || pageText.length < 200 || looksLikeJsonDump(pageText)) {
          stats.end = 'empty-page';
          break;
        }

        const { roles: pageRoles } = await this.extractRolesWithLlm(pageText, currentUrl, pageLinks);
        if (pageRoles.length === 0) {
          stats.end = 'empty-page';
          break;
        }

        allRoles.push(...pageRoles);
        await persistPage(pageRoles);
        stats.pages = pageCount + 1;
        if (hitsKnownRole(pageRoles)) {
          stats.end = 'known-role';
          break;
        }
        if (pageRoles.every(isStale)) {
          stats.end = 'stale';
          break;
        }
        knownStreak = allKnown(pageRoles) ? knownStreak + 1 : 0;
        if (knownStreak >= KNOWN_PAGE_STREAK_STOP) {
          stats.end = 'known-role';
          break;
        }
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      stats.end = 'error';
      this.logger.warn(`Click-based pagination stopped early for ${url}: ${err}`);
    } finally {
      await page.close();
    }

    return allRoles;
  }

  /** Overload used by listing extraction (includeLinks: true) — returns real
   * <a href> links alongside the page text so extractRolesWithLlm can pick
   * actual URLs from a candidate list instead of having to infer/construct
   * one from prose, which some boards' LLM extraction was doing incorrectly
   * (fabricating plausible-but-fake URLs from the job title when no real URL
   * was visible in plain text — verified on Stripe and Microsoft's boards). */
  private async renderPageText(
    url: string,
    opts: { requireSameOrigin?: boolean; expandShowMoreListing?: boolean; includeLinks: true },
  ): Promise<{ text: string; links: { text: string; href: string }[] }>;
  private async renderPageText(
    url: string,
    opts?: { requireSameOrigin?: boolean; expandShowMoreListing?: boolean; includeLinks?: false },
  ): Promise<string>;
  private async renderPageText(
    url: string,
    opts?: { requireSameOrigin?: boolean; expandShowMoreListing?: boolean; includeLinks?: boolean },
  ): Promise<string | { text: string; links: { text: string; href: string }[] }> {
    const browser = await this.getBrowser();
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (compatible; job-tracker/0.1)',
    });
    try {
      await this.gotoAndSettle(page, url);
      // Only listing pages (includeLinks: true) get sorted — a single JD
      // fetch has no sort control to find. Sorting BEFORE expanding/reading
      // matters: the staleness-stop and known-role-stop optimizations both
      // assume newest-first order, so an unsorted (or oldest-first) listing
      // would silently cut off before reaching genuinely new roles.
      if (opts?.includeLinks) {
        await this.sortByDateIfAvailable(page);
      }
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
        if (domainChanged || landedOnGenericListing) {
          return opts?.includeLinks ? { text: '', links: [] } : '';
        }
      }
      const html = await page.content();
      const $ = cheerio.load(html);
      const ogDescription = $('meta[property="og:description"]').attr('content')?.trim();

      let links: { text: string; href: string }[] = [];
      if (opts?.includeLinks) {
        // Resolve relative hrefs against the page's ACTUAL final URL
        // (page.url()), not the originally-requested url — some boards
        // (e.g. Stripe's Greenhouse embed) client-side-redirect to a
        // different domain before rendering the listing, so a root-relative
        // href like "/careers/listing/..." must resolve against the real
        // landing domain (stripe.com) or it silently strips onto the wrong
        // origin entirely (verified: resolving against the original
        // boards.greenhouse.io URL produced boards.greenhouse.io/careers/
        // listing/... — a URL that 404s — instead of the real
        // stripe.com/careers/listing/... one).
        const resolveBase = page.url();
        links = $('a[href]')
          .map((_, el) => {
            const $el = $(el);
            const text = extractLinkText($el);
            const href = $el.attr('href')?.trim() ?? '';
            return { text, href };
          })
          .get()
          .filter((l) => l.text && l.href && !l.href.startsWith('#') && !l.href.startsWith('javascript:'))
          .map((l) => ({ ...l, href: this.resolveUrl(l.href, resolveBase) }));
      }

      $('script, style, noscript').remove();
      const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
      // Some Eightfold-powered boards (e.g. Netflix) render a large JSON app-
      // state blob as literal body text, not inside a <script> tag — it's
      // long, so a length-only check treats it as "real" content, but it's
      // pure garbage for both JD extraction and date parsing. Prefer
      // og:description whenever bodyText is short OR JSON-dominated.
      const useBodyText = bodyText.length > 200 && !looksLikeJsonDump(bodyText);
      const text = (useBodyText ? bodyText : ogDescription || bodyText).slice(0, 60000);
      return opts?.includeLinks ? { text, links } : text;
    } finally {
      await page.close();
    }
  }

  private resolveUrl(href: string, baseUrl: string): string {
    try {
      return new URL(href, baseUrl).toString();
    } catch {
      return href;
    }
  }

  /** Selects a "sort by date/newest" control if the listing page has one,
   * before any content is read — the staleness-cutoff and known-role stop
   * conditions both assume newest-first order, so scanning an unsorted (or
   * oldest-first) listing risks stopping before reaching genuinely new
   * roles, or never reaching the staleness cutoff at all. Handles both
   * common patterns: a <select> dropdown (set its value + fire change), and
   * a clickable sort link/button/menu-item (click it). Best-effort — if no
   * sort control is found or it can't be resolved, leaves the page's default
   * order alone rather than failing the whole scan over it. */
  private async sortByDateIfAvailable(page: Page): Promise<void> {
    try {
      // Some boards (e.g. Microsoft: a button literally labeled "Sort:
      // Latest") already default to date/newest order — verified directly:
      // clicking that button doesn't open a real alternate-options menu (it
      // just re-exposes unrelated page chrome), so attempting the two-step
      // open-menu flow below is both unnecessary and unreliable here. Check
      // for an already-sorted label FIRST and skip everything else if found.
      const alreadySorted = await page.evaluate(() => {
        const alreadySortedPattern = /\bsort\s*[:\-]?\s*(latest|newest|recent|date)\b/i;
        return Array.from(document.querySelectorAll<HTMLElement>('button, a, [role="button"], span, div')).some(
          (el) => el.offsetParent !== null && alreadySortedPattern.test((el.textContent ?? '').trim()),
        );
      });
      if (alreadySorted) return;

      const changedSelect = await page.evaluate(() => {
        const datePattern = /\b(date|newest|recent|new to old)\b/i;
        const selects = Array.from(document.querySelectorAll<HTMLSelectElement>('select'));
        for (const select of selects) {
          const option = Array.from(select.options).find((o) => datePattern.test(o.textContent ?? ''));
          if (option && select.value !== option.value) {
            select.value = option.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      });
      if (changedSelect) {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(500);
        return;
      }

      // Radio-button sort control (e.g. Meta: a "Sort by" section with plain
      // "Relevance"/"Newest" radio inputs, each option's own label just the
      // bare word "Newest" — no "sort" text anywhere near it, so neither the
      // <select> nor the "sort"-containing click matchers below can find it).
      // Meta's markup has no <label> element at all — the option text lives
      // in a plain sibling <div> one level up from the <input>, unassociated
      // by "for"/id or containment — so this walks up a few ancestors
      // looking for one whose OWN text is exactly the option word (verified
      // directly against metacareers.com: the radio's immediate parent's
      // textContent is exactly "Newest").
      const clickedRadio = await page.evaluate(() => {
        const datePattern = /^\s*(newest|latest|most recent|date)\s*$/i;
        const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
        for (const radio of radios) {
          if (radio.offsetParent === null || radio.checked) continue;
          let container: HTMLElement | null = radio.parentElement;
          for (let hops = 0; container && hops < 5; hops++, container = container.parentElement) {
            const text = (container.textContent ?? '').trim();
            if (datePattern.test(text)) {
              radio.click();
              return true;
            }
          }
        }
        return false;
      });
      if (clickedRadio) {
        // Some boards (e.g. Meta) don't auto-apply a radio change — a
        // separate "Apply filters"-labeled button must be clicked too.
        // Best-effort: only clicks if such a button is actually present.
        await page.evaluate(() => {
          const applyPattern = /^\s*apply\s+filters?\s*$/i;
          const buttons = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'));
          const applyButton = buttons.find(
            (el) => el.offsetParent !== null && applyPattern.test((el.textContent ?? '').trim()),
          );
          applyButton?.click();
        });
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        // networkidle can fire before the results list finishes re-rendering
        // — verified directly on Meta: right after networkidle + 500ms, the
        // pagination "next" button exists in the DOM but has a zero-size
        // bounding box (mid-transition), and a caller checking isVisible()
        // right after this returns immediately gets a false negative,
        // stopping pagination after only page 1. Poll for the results list
        // to actually gain real layout instead of a fixed short wait.
        await page
          .waitForFunction(
            () => {
              const jobLinks = document.querySelectorAll('a[href*="job"], [role="listitem"], article');
              return jobLinks.length > 0 && Array.from(jobLinks).some((el) => el.getBoundingClientRect().height > 0);
            },
            { timeout: 4000 },
          )
          .catch(() => {});
        await page.waitForTimeout(1000);
        return;
      }

      // Clickable sort control (button/link/menu-item) — deliberately
      // excludes "old to new" phrasing so we don't pick the reverse sort.
      const clicked = await page.evaluate(() => {
        const datePattern = /\b(sort.{0,15}(date|newest|recent)|new to old|date posted)\b/i;
        const excludePattern = /old to new|oldest/i;
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>('button, a, [role="button"], [role="menuitem"], option'),
        );
        const target = candidates.find((el) => {
          const t = el.textContent ?? '';
          return el.offsetParent !== null && datePattern.test(t) && !excludePattern.test(t);
        });
        if (!target) return false;
        target.click();
        return true;
      });
      if (clicked) {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(500);
        return;
      }

      // Two-step "Sort by" menu (e.g. Amazon: a closed dropdown button whose
      // own label is just "Sort by: Most relevant" — the "Latest"/"Newest"
      // option text only exists once the menu is opened, so the direct
      // single-click match above can never see it). Open the trigger, wait
      // for new content to render, then look for a date option again.
      const opened = await page.evaluate(() => {
        const triggerPattern = /\bsort\b/i;
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>(
            'button, a, [role="button"], [aria-haspopup="true"], [aria-haspopup="listbox"], [aria-haspopup="menu"]',
          ),
        );
        const target = candidates.find(
          (el) => el.offsetParent !== null && triggerPattern.test(el.textContent ?? ''),
        );
        if (!target) return false;
        target.click();
        return true;
      });
      if (!opened) return;

      await page.waitForTimeout(400);

      const clickedMenuOption = await page.evaluate(() => {
        const datePattern = /\b(date|newest|recent|new to old|latest)\b/i;
        const excludePattern = /old to new|oldest/i;
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>(
            'button, a, li, [role="option"], [role="menuitem"], [role="menuitemradio"]',
          ),
        );
        const target = candidates.find((el) => {
          const t = el.textContent ?? '';
          return el.offsetParent !== null && datePattern.test(t) && !excludePattern.test(t);
        });
        if (!target) return false;
        target.click();
        return true;
      });
      if (clickedMenuOption) {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(500);
      }
    } catch {
      // Best-effort — a sort control that exists but can't be resolved is
      // not worth failing the scan over; default order is still usable.
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
   * roles) must not be followed forever.
   *
   * Scrolling document.body is a no-op on boards where the job list lives in
   * its own inner scrollable panel instead of the page itself — verified on
   * Microsoft's board: the real job-card list is a fixed-height <div> with
   * overflow-y:auto (scrollHeight 1947 vs clientHeight 488), independent of
   * the page body, which never grows no matter how much you scroll the page.
   * Finds and scrolls that actual overflow container when body-scrolling
   * produces no height growth, instead of giving up. */
  private async expandShowMoreListing(page: Page): Promise<void> {
    let previousHeight = 0;
    let useInnerScroller = false;

    for (let round = 0; round < MAX_LOAD_MORE_ROUNDS; round++) {
      const scrolledHeight = await page.evaluate((tryInner) => {
        if (tryInner) {
          // Largest-overflow scrollable element on the page, excluding
          // document.documentElement/body themselves.
          const candidates = Array.from(document.querySelectorAll<HTMLElement>('*')).filter((el) => {
            const style = getComputedStyle(el);
            return (
              (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
              el.scrollHeight > el.clientHeight + 50
            );
          });
          const target = candidates.sort((a, b) => b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight))[0];
          if (target) {
            target.scrollTop = target.scrollHeight;
            return target.scrollHeight;
          }
        }
        window.scrollTo(0, document.body.scrollHeight);
        return document.body.scrollHeight;
      }, useInnerScroller);
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

      const newHeight = scrolledHeight;
      if (!clicked && newHeight <= previousHeight) {
        // Body-scroll produced no growth and we haven't tried the inner-
        // container path yet — switch strategies once before giving up,
        // rather than concluding the listing is fully loaded when we may
        // just have been scrolling the wrong element.
        if (!useInnerScroller) {
          useInnerScroller = true;
          previousHeight = 0;
          continue;
        }
        break;
      }
      previousHeight = newHeight;
    }
  }

  /** Batches large link lists into multiple LLM calls instead of one giant
   * request — verified on Okta's careers board (a single flat page with
   * ~370 real job links, all present from initial load, no pagination):
   * a single call asking the model to extract every role from all 370
   * links at once silently under-returned (only ~30 came back, matching
   * the alphabetically-first ones), most plausibly the model's own output
   * hitting a practical length limit for one JSON response rather than any
   * code-side truncation (page text and link-list caps were both confirmed
   * NOT hit — 31KB of page text, 510 total links under the old 500 cap).
   * Each batch gets the FULL page text (cheap to repeat, keeps context for
   * dates/locations near each role) but only its slice of links, with the
   * model told to extract roles ONLY for links in the batch. Batches run
   * sequentially (not Promise.all) to stay within the LLM rate limit that
   * already causes retries elsewhere in this file. */
  private async extractRolesWithLlm(
    pageText: string,
    pageUrl: string,
    links: { text: string; href: string }[] = [],
  ): Promise<{ roles: DiscoveredRoleDto[]; nextPageUrl?: string }> {
    const LINKS_PER_BATCH = 80;
    if (links.length <= LINKS_PER_BATCH) {
      return this.extractRolesWithLlmSingleBatch(pageText, pageUrl, links);
    }

    const allRoles: DiscoveredRoleDto[] = [];
    const seenUrls = new Set<string>();
    let nextPageUrl: string | undefined;

    for (let i = 0; i < links.length; i += LINKS_PER_BATCH) {
      const batch = links.slice(i, i + LINKS_PER_BATCH);
      const result = await this.extractRolesWithLlmSingleBatch(pageText, pageUrl, batch);
      for (const role of result.roles) {
        if (!seenUrls.has(role.url)) {
          seenUrls.add(role.url);
          allRoles.push(role);
        }
      }
      // Only the first batch's nextPageUrl is meaningful — a "Next page"
      // link (if this board even has one) shows up once in the full link
      // list, not per-batch, so whichever batch happens to contain it wins.
      if (!nextPageUrl && result.nextPageUrl) nextPageUrl = result.nextPageUrl;
    }

    return { roles: allRoles, nextPageUrl };
  }

  private async extractRolesWithLlmSingleBatch(
    pageText: string,
    pageUrl: string,
    links: { text: string; href: string }[] = [],
  ): Promise<{ roles: DiscoveredRoleDto[]; nextPageUrl?: string }> {
    const endpoint = process.env.AZURE_LLM_ENDPOINT;
    const apiKey = process.env.AZURE_LLM_API_KEY;
    const deployment = process.env.AZURE_LLM_DEPLOYMENT_NAME ?? 'gpt-4.1';
    const apiVersion = process.env.AZURE_LLM_API_VERSION ?? '2024-12-01-preview';
    if (!endpoint || !apiKey) throw new Error('AZURE_LLM_ENDPOINT / AZURE_LLM_API_KEY not configured');

    // Cap the link list too — some boards have hundreds of nav/footer links;
    // keep it generous but bounded rather than blowing up the prompt size.
    // (This cap is now mostly redundant with the batching above, but stays
    // as a hard backstop for a single batch that's somehow still huge.)
    const linksBlock = links
      .slice(0, 500)
      .map((l) => `"${l.text}" -> ${l.href}`)
      .join('\n');

    const baseEndpoint = endpoint.replace(/\/openai\/?$/, '');
    const url = `${baseEndpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: buildRoleListExtractionPrompt() },
          {
            role: 'user',
            content:
              `Page URL: ${pageUrl}\n\n` +
              (linksBlock
                ? `Real links found on this page (link text -> actual URL) — you MUST pick each ` +
                  `role's url from THIS list verbatim, never construct or guess one:\n${linksBlock}\n\n`
                : '') +
              `Page text:\n${pageText}`,
          },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) throw new Error(`Role extraction request failed: ${response.status}`);

    const data = (await response.json()) as { choices: { message: { content: string } }[]; usage?: ChatUsage };
    await this.llmCalls.recordAzureUsage('role-scan', deployment, data.usage);
    const raw = data.choices[0]?.message?.content ?? '{"roles":[]}';
    const parsed = JSON.parse(raw) as { roles?: DiscoveredRoleDto[]; nextPageUrl?: string | null };

    // Belt-and-suspenders: when we gave the model a real link list, reject
    // any role whose URL isn't actually in it — this is what catches a
    // fabricated URL even if the model ignores the "pick from this list"
    // instruction (verified happening on Stripe's and Microsoft's boards
    // before this fix: plausible-looking but fake /jobs/<slug-from-title>
    // URLs that don't correspond to any real posting).
    const knownHrefs = links.length > 0 ? new Set(links.map((l) => l.href)) : null;

    return {
      roles: (parsed.roles ?? [])
        .filter((r) => r.title && r.url && (!knownHrefs || knownHrefs.has(r.url)))
        .map(({ location, ...r }) => {
          // Postings of one title are posted per location/team, so the
          // location is what tells them apart in the open-roles list.
          const loc = location?.trim();
          const title = loc && !r.title.toLowerCase().includes(loc.toLowerCase()) ? `${r.title} — ${loc}` : r.title;
          return { ...r, title };
        }),
      nextPageUrl: parsed.nextPageUrl ?? undefined,
    };
  }

  private async extractTitlesWithLlm(pageText: string): Promise<string[]> {
    const endpoint = process.env.AZURE_LLM_ENDPOINT;
    const apiKey = process.env.AZURE_LLM_API_KEY;
    const deployment = process.env.AZURE_LLM_DEPLOYMENT_NAME ?? 'gpt-4.1';
    const apiVersion = process.env.AZURE_LLM_API_VERSION ?? '2024-12-01-preview';
    if (!endpoint || !apiKey) throw new Error('AZURE_LLM_ENDPOINT / AZURE_LLM_API_KEY not configured');

    const baseEndpoint = endpoint.replace(/\/openai\/?$/, '');
    const url = `${baseEndpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: buildTitleOnlyExtractionPrompt() },
          { role: 'user', content: `Page text:\n${pageText}` },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) throw new Error(`Title extraction request failed: ${response.status}`);

    const data = (await response.json()) as { choices: { message: { content: string } }[]; usage?: ChatUsage };
    await this.llmCalls.recordAzureUsage('role-scan', deployment, data.usage);
    const raw = data.choices[0]?.message?.content ?? '{"titles":[]}';
    const parsed = JSON.parse(raw) as { titles?: string[] };
    return (parsed.titles ?? []).filter((t) => typeof t === 'string' && t.trim());
  }

  /** Reads a board built on Eightfold (e.g. Netflix) straight from its public
   * job API, which lists every open role with a real URL — far more complete
   * than clicking cards one at a time. The board's own origin is found by
   * loading the listing (these pages redirect client-side); the API's
   * `domain` parameter is the company's website domain. Returns [] when the
   * site doesn't expose that API, so callers fall back to other methods. The
   * API returns 10 roles per request regardless of `num`. */
  private async discoverRolesViaEightfoldApi(
    listingUrl: string,
    stats: ScanStats,
    persistPage: (pageRoles: DiscoveredRoleDto[]) => Promise<void>,
  ): Promise<DiscoveredRoleDto[]> {
    const PAGE_SIZE = 10;
    const MAX_ROLES = 5000;

    let finalUrl = listingUrl;
    let linkHrefs: string[] = [];
    const browser = await this.getBrowser();
    const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (compatible; job-tracker/0.1)' });
    try {
      await this.gotoAndSettle(page, listingUrl);
      finalUrl = page.url();
      linkHrefs = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).map((a) => a.href),
      );
    } catch {
      /* probe the listing URL's own origin below */
    } finally {
      await page.close();
    }

    const registrable = (u: string) =>
      new URL(u).hostname.replace(/^(www|jobs|careers|explore)\./, '').split('.').slice(-2).join('.');
    // The listing is often a marketing page whose "see jobs" link points at
    // the real board's host (jobs.netflix.com -> explore.jobs.netflix.net), so
    // job/career-style hosts that carry the company's name are probed too.
    const companyLabel = registrable(listingUrl).split('.')[0];
    const linkedOrigins = linkHrefs.flatMap((h) => {
      try {
        const u = new URL(h);
        return u.hostname.includes(companyLabel) && /jobs|careers|explore/.test(u.hostname) ? [u.origin] : [];
      } catch {
        return [];
      }
    });
    const origins = [...new Set([new URL(finalUrl).origin, new URL(listingUrl).origin, ...linkedOrigins])].slice(0, 6);
    const domains = [...new Set([registrable(listingUrl), registrable(finalUrl)])];

    type Position = { name?: string; posting_name?: string; location?: string; canonicalPositionUrl?: string; id?: number | string };
    type ApiPage = { positions?: Position[]; count?: number };
    const fetchPage = async (origin: string, domain: string, start: number): Promise<ApiPage | null> => {
      try {
        const res = await fetch(
          `${origin}/api/apply/v2/jobs?domain=${encodeURIComponent(domain)}&start=${start}&num=${PAGE_SIZE}`,
          {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; job-tracker/0.1)' },
            signal: AbortSignal.any([this.killSwitch.signal, AbortSignal.timeout(30_000)]),
          },
        );
        if (!res.ok) return null;
        return (await res.json()) as ApiPage;
      } catch {
        return null;
      }
    };

    let found: { origin: string; domain: string; first: ApiPage } | null = null;
    for (const origin of origins) {
      for (const domain of domains) {
        const first = await fetchPage(origin, domain, 0);
        if (first && Array.isArray(first.positions) && typeof first.count === 'number' && first.count > 0) {
          found = { origin, domain, first };
          break;
        }
      }
      if (found) break;
    }
    if (!found) return [];

    const total = Math.min(found.first.count!, MAX_ROLES);
    const roles: DiscoveredRoleDto[] = [];
    const toRoles = (positions: Position[]): DiscoveredRoleDto[] =>
      positions.flatMap((p) => {
        const name = (p.posting_name || p.name || '').trim();
        const url = p.canonicalPositionUrl || (p.id ? `${found!.origin}/careers/job/${p.id}` : '');
        if (!name || !url) return [];
        const location = p.location?.trim();
        return [{ title: location ? `${name} — ${location}` : name, url }];
      });

    let failed = false;
    for (let start = 0; start < total; start += PAGE_SIZE) {
      const data = start === 0 ? found.first : await fetchPage(found.origin, found.domain, start);
      if (!data?.positions) {
        failed = true;
        break;
      }
      if (data.positions.length === 0) break;
      const pageRoles = toRoles(data.positions);
      roles.push(...pageRoles);
      await persistPage(pageRoles);
      stats.pages = Math.floor(start / PAGE_SIZE) + 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    stats.method = 'api';
    stats.apiTotal = found.first.count;
    stats.end = failed || roles.length < total ? 'error' : 'no-next-page';
    return roles;
  }

  /** Last-resort role discovery for boards with real job listings but zero
   * usable <a href> per-posting links anywhere in the markup (e.g. Netflix's
   * Eightfold board: job cards are <div role="button"> elements with no
   * href, selected via a click that updates a ?pid=<id> query param, behind
   * a one-time "upload your resume" modal that must be dismissed first).
   *
   * Bounded deliberately hard on every axis after an earlier version of
   * this (without these bounds) contributed to a production hang: a fixed
   * WALL_CLOCK_BUDGET_MS caps the whole operation regardless of how many
   * titles were found or how slow individual clicks are, every Playwright
   * call has its own short explicit timeout (nothing waits on a default),
   * and CARD_LIMIT keeps a huge listing from turning into hundreds of
   * sequential clicks. Hitting either bound just returns whatever roles
   * were found so far rather than throwing — partial results from this
   * fallback are still useful. */
  private async discoverRolesByClickingCards(listingUrl: string): Promise<DiscoveredRoleDto[]> {
    const WALL_CLOCK_BUDGET_MS = 45_000;
    const CARD_LIMIT = 15;
    const deadline = Date.now() + WALL_CLOCK_BUDGET_MS;

    const browser = await this.getBrowser();
    const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (compatible; job-tracker/0.1)' });
    const roles: DiscoveredRoleDto[] = [];

    try {
      await this.gotoAndSettle(page, listingUrl);

      // Best-effort dismissal of any blocking modal (e.g. Netflix's
      // "upload your resume" prompt with a SKIP button) — a modal that
      // isn't there or can't be dismissed this way just means the
      // subsequent clicks fail individually, not fatal to the whole thing.
      await page
        .evaluate(() => {
          const dismissPattern = /^(skip|close|no thanks|dismiss|x)$/i;
          const candidates = Array.from(
            document.querySelectorAll<HTMLElement>('button, a, [role="button"]'),
          );
          const target = candidates.find(
            (el) => el.offsetParent !== null && dismissPattern.test((el.textContent ?? '').trim()),
          );
          target?.click();
        })
        .catch(() => {});
      await page.waitForTimeout(300);

      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 60000));
      const titles = await this.extractTitlesWithLlm(bodyText);

      for (const title of titles.slice(0, CARD_LIMIT)) {
        if (Date.now() > deadline) break;

        try {
          const locator = page.getByText(title, { exact: true }).first();
          if ((await locator.count().catch(() => 0)) === 0) continue;

          await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
          await locator.click({ timeout: 3000 });
          await page.waitForTimeout(500);

          const resultUrl = page.url();
          if (resultUrl && resultUrl !== listingUrl) {
            roles.push({ title, url: resultUrl });
          }
        } catch {
          // One card failing to click/resolve shouldn't abort the rest.
        }
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      // Whole-page navigation/setup failed — return whatever was found
      // (likely nothing), same as any other candidate URL failing.
    } finally {
      await page.close().catch(() => {});
    }

    return roles;
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

  /** Forces a role's atsScore to 0 (treated by the UI as "Conditions not
   * valid") without running the LLM — used to manually discard a role the
   * candidate doesn't want to see again, at no LLM cost. */
  async discardRole(roleId: string) {
    const role = await this.prisma.discoveredRole.findUnique({ where: { id: roleId } });
    if (!role) throw new NotFoundException(`Role ${roleId} not found`);
    return this.prisma.discoveredRole.update({
      where: { id: roleId },
      data: { atsScore: 0, atsScoreComputedAt: new Date() },
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

  private extractCandidateMaxYears(profile: unknown): number | null {
    const p = (profile ?? {}) as { maxYearsExperience?: number | null };
    return typeof p.maxYearsExperience === 'number' ? p.maxYearsExperience : null;
  }

  /** Retries a fetch on 429 (rate limit) and 5xx (transient server error)
   * responses with exponential backoff, honoring a Retry-After header when
   * the API sends one. Without this, a single rate-limit hit partway
   * through a large scan (verified happening on Amazon: 429 after ~4 pages)
   * silently ends the ENTIRE pagination loop and discards every page not
   * yet fetched — a scan that should find thousands of roles quietly
   * stopped at 100. Other error types (4xx auth/bad-request) are not
   * retried since retrying won't fix them. */
  private async fetchWithRetry(url: string, init: RequestInit, maxRetries = 5): Promise<Response> {
    let lastResponse: Response | undefined;
    // Every caller of this is an LLM request, so enforce the daily cap here.
    await this.llmCalls.assertWithinBudget();
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await fetch(url, { ...init, signal: this.killSwitch.signal });
      if (response.ok || (response.status < 500 && response.status !== 429)) return response;

      lastResponse = response;
      if (attempt === maxRetries) break;

      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
      const backoffMs = !isNaN(retryAfterMs) ? retryAfterMs : Math.min(1000 * 2 ** attempt, 15000);
      this.logger.warn(
        `LLM request got ${response.status}, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries})`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
    return lastResponse!;
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
    const result = await this.estimateAtsScore(jdText, profile, entries, role.title);
    const candidateLocation = this.extractCandidateLocation(profile);
    const candidateMaxYears = this.extractCandidateMaxYears(profile);

    // A role listed in several places only mismatches if NONE of them fit:
    // prefer a location that matches, then one we can't judge, else the first.
    const evaluated = (result.locations.length ? result.locations : [{ country: null, state: null, city: null }]).map(
      (loc) => ({ loc, mismatch: this.computeLocationMismatch({ isRemote: result.isRemote, ...loc }, candidateLocation) }),
    );
    const chosen =
      evaluated.find((e) => e.mismatch === false) ?? evaluated.find((e) => e.mismatch === null) ?? evaluated[0];

    return this.prisma.discoveredRole.update({
      where: { id: roleId },
      data: {
        jdText: role.jdText || jdText || undefined,
        atsScore: result.score,
        atsScoreComputedAt: new Date(),
        roleIsRemote: result.isRemote,
        roleCountry: chosen.loc.country,
        roleState: chosen.loc.state,
        roleCity: chosen.loc.city,
        locationMismatch: chosen.mismatch,
        roleMinYearsExperience: result.minYearsExperience,
        experienceMismatch: this.computeExperienceMismatch(result.minYearsExperience, candidateMaxYears),
      },
    });
  }

  /** The role's saved JD text, fetching and saving it first if the role has
   * none yet. Returns '' when the posting page can't be read as a real JD. */
  async ensureRoleJd(roleId: string): Promise<string> {
    const role = await this.prisma.discoveredRole.findUnique({ where: { id: roleId } });
    if (!role) throw new NotFoundException(`Role ${roleId} not found`);
    if (role.jdText) return role.jdText;
    const jdText = await this.fetchRoleJd(role.roleUrl);
    if (jdText) await this.prisma.discoveredRole.update({ where: { id: roleId }, data: { jdText } });
    return jdText;
  }

  private async fetchRoleJd(roleUrl: string): Promise<string> {
    try {
      const pageText = await this.renderPageText(roleUrl, { requireSameOrigin: true });
      if (looksLikeSearchResultsFallback(pageText)) return '';
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
    title?: string,
  ): Promise<{
    score: number | null;
    isRemote: boolean | null;
    locations: { country: string | null; state: string | null; city: string | null }[];
    minYearsExperience: number | null;
  }> {
    const empty = {
      score: null,
      isRemote: null,
      locations: [],
      minYearsExperience: null,
    };
    if (!jdText) return empty;

    const endpoint = process.env.AZURE_LLM_ENDPOINT;
    const apiKey = process.env.AZURE_LLM_API_KEY;
    const deployment = process.env.AZURE_LLM_DEPLOYMENT_NAME ?? 'gpt-4.1';
    const apiVersion = process.env.AZURE_LLM_API_VERSION ?? '2024-12-01-preview';
    if (!endpoint || !apiKey) return empty;

    const baseEndpoint = endpoint.replace(/\/openai\/?$/, '');
    const url = `${baseEndpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content:
              'You estimate how well a candidate matches a job description for ATS/recruiter ' +
              'screening purposes, and extract the JD\'s work-location and experience-requirement ' +
              'signals. Return ONLY a JSON object: {"score": <integer 0-100>, "isRemote": ' +
              'boolean|null, "locations": [{"country": string|null, "state": string|null, "city": ' +
              'string|null}], "minYearsExperience": integer|null}. score: base it on keyword/skill overlap, ' +
              "seniority match, and domain relevance between the candidate's background and the " +
              'JD\'s requirements. Be realistic, not generous. isRemote: true if the JD says the ' +
              'role is remote/work-from-home/distributed (even if restricted to certain ' +
              'locations), false if it explicitly requires onsite/hybrid office presence, null if ' +
              'the JD says nothing about work location at all. locations: ONE entry for EVERY place the ' +
              'role can be based — postings are often listed in several (e.g. "Menlo Park, CA +2 ' +
              'locations", or a title/location line naming Menlo Park, Seattle and New York); the ' +
              'role title below may carry the full list, so use it as well as the JD text. Never ' +
              'keep only the first when more are given. For a remote role use a single entry for ' +
              'the geography its remote eligibility is restricted to (or one entry of nulls if ' +
              'unrestricted). Each entry\'s country: full country name (e.g. ' +
              '"United States") the role is based in, or — if remote — the country its remote ' +
              'eligibility is restricted to if the JD states one (e.g. "Remote (US only)" -> ' +
              '"United States"); null if unstated or remote with no country restriction. state: ' +
              'the state/province/region the role is based in, or the specific state remote ' +
              'eligibility is restricted to if the JD states one; null otherwise (including remote ' +
              'roles open anywhere in the country). city: the city the role is based in if stated; ' +
              'null for remote roles or if unstated. Use full names, not abbreviations or codes. ' +
              'minYearsExperience: the minimum years of professional experience the JD requires as ' +
              'an integer — for a range like "3-5 years" use the LOW end (3), since that\'s the ' +
              'actual qualifying bar; for "5+ years" use 5; for a stated experience LEVEL with no ' +
              'number (e.g. "Senior", "Entry-level", "New grad") infer a reasonable typical number ' +
              'of years for that level rather than leaving it null; null only if the JD truly gives ' +
              'no experience signal at all, numeric or level-based.',
          },
          {
            role: 'user',
            content: `Candidate profile:\n${JSON.stringify(profile)}\n\nCandidate background:\n${JSON.stringify(entries)}\n\n${title ? `Role title (as listed, may include every location): ${title}\n\n` : ''}Job description:\n${jdText.slice(0, 12000)}`,
          },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) return empty;

    const data = (await response.json()) as { choices: { message: { content: string } }[]; usage?: ChatUsage };
    await this.llmCalls.recordAzureUsage('role-score', deployment, data.usage);
    const raw = data.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw) as {
      score?: number;
      isRemote?: boolean | null;
      locations?: { country?: string | null; state?: string | null; city?: string | null }[];
      minYearsExperience?: number | null;
    };
    return {
      score: typeof parsed.score === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.score))) : null,
      isRemote: typeof parsed.isRemote === 'boolean' ? parsed.isRemote : null,
      locations: (Array.isArray(parsed.locations) ? parsed.locations : []).slice(0, 12).map((l) => ({
        country: l?.country || null,
        state: l?.state || null,
        city: l?.city || null,
      })),
      minYearsExperience:
        typeof parsed.minYearsExperience === 'number' ? Math.max(0, Math.round(parsed.minYearsExperience)) : null,
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

  /** A role mismatches on experience if it requires MORE years than the
   * candidate's profile maxYearsExperience allows — the candidate having
   * fewer years than a role wants is a real overqualification-in-reverse
   * signal, but having MORE years than a role wants is never treated as a
   * mismatch (a senior candidate can always apply to a less senior role).
   * Null (can't judge) when either side has no number to compare. */
  private computeExperienceMismatch(
    roleMinYears: number | null,
    candidateMaxYears: number | null,
  ): boolean | null {
    if (roleMinYears === null || candidateMaxYears === null) return null;
    return roleMinYears > candidateMaxYears;
  }
}
