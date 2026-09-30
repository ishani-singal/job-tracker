import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { Browser, chromium } from 'playwright';

export interface ParsedJob {
  company?: string;
  role?: string;
  jdText?: string;
  postedDate?: string;
  applyByDate?: string;
  salaryRange?: string;
  experienceLevel?: string;
  /** The posting's own job/req ID (e.g. Workday's "JR355248", Amazon's
   * "10562837") — used for dedup since the same posting is often reached via
   * different tracking-parameter-laden URLs (utm_*, source=, etc.). */
  jobId?: string;
  fetchFailed: boolean;
}

/** Some career pages (e.g. Netflix's Eightfold-powered board) render a large
 * JSON app-state/theming blob as literal visible body text, not inside a
 * <script> tag — real prose text, so cheerio's text-stripping never removes
 * it, and it can run tens of thousands of characters (long enough to look
 * "real" to a naive length check). Detects this by checking whether the text
 * is dominated by JSON-structural characters — real JD prose has very few
 * brace/bracket/quote characters relative to length; a JSON dump is mostly
 * punctuation and short quoted tokens. */
function looksLikeJsonDump(text: string): boolean {
  const sample = text.slice(0, 2000);
  if (!sample) return false;
  const structuralChars = (sample.match(/[{}[\]":,]/g) ?? []).length;
  return structuralChars / sample.length > 0.15;
}

/**
 * Extracts a platform-native job/req ID straight from the URL structure —
 * deliberately regex-based rather than LLM-inferred, since these IDs are
 * reliably embedded in the URL path/query on every major ATS and a regex
 * match is exact where an LLM guess could hallucinate or normalize it
 * differently across runs, breaking dedup.
 */
function extractJobIdFromUrl(url: string): string | undefined {
  const patterns: RegExp[] = [
    /_(JR\d+)(?:[/?]|$)/i, // Workday: .../Some-Title_JR355248
    /\/jobs\/(\d+)/i, // Amazon, Greenhouse, Lever, SmartRecruiters: /jobs/10562837
    /\/view\/(\d+)/i, // LinkedIn: /jobs/view/1234567890
    /[?&]gh_jid=(\d+)/i, // Greenhouse embedded boards
    /[?&]jobId=([\w-]+)/i, // generic query param some ATSes use
    /-(R\d{4,})(?:[/?]|$)/i, // Workday alt format: ...-R12345
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function buildExtractionSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You extract structured job-posting fields from raw page
text. Today's date is ${today} — use it to resolve any relative date phrasing. Return ONLY a
JSON object with these keys (use null for anything not present):
company (string), role (string, the job title as posted, e.g. "Senior Product Manager" —
not the department or team name), jdText (string, the FULL role description, verbatim —
include every section describing the role, team, and requirements (e.g. "Description", "Key
job responsibilities", "A day in the life", "About the team", "Basic Qualifications",
"Preferred Qualifications", and any equivalent sections under different headings). Preserve
each section's heading and bullet structure rather than summarizing or condensing it — this
text is used verbatim downstream, so dropping or shortening a section loses real information.
Only exclude clearly unrelated boilerplate: equal-opportunity/legal disclaimers, benefits/
perks marketing copy, "how to apply" instructions, and site navigation/footer text), postedDate
(ISO date string YYYY-MM-DD — the page often shows this as RELATIVE text like "Posted 3 days
ago", "Posted today", "30+ days ago", or "Reposted 2 weeks ago" rather than an absolute date;
resolve it against today's date above and return the computed absolute date, don't return null
just because the page didn't show an absolute date — only return null if there's truly no
posting-recency signal on the page at all), applyByDate (ISO date string YYYY-MM-DD, same
relative-phrasing resolution rule if the page shows something like "Apply within 5 days" or a
deadline countdown), salaryRange (string), experienceLevel (string, e.g. "5+ years" or
"Senior"). Do not include any text outside the JSON object.`;
}

@Injectable()
export class JobsService implements OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private browser: Browser | null = null;

  async onModuleDestroy() {
    await this.browser?.close();
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
    }
    return this.browser;
  }

  /**
   * Fetches a job posting URL server-side via a headless browser (many job boards
   * — Eightfold, Greenhouse's newer templates, custom ATS SPAs — render the JD
   * client-side, so a plain fetch() only sees an empty shell), strips markup down
   * to visible text via cheerio, then asks the LLM to extract structured fields.
   * Never throws on a parse/fetch failure — callers fall back to manual entry
   * using whatever partial result (or fetchFailed: true) comes back.
   */
  async parseJobUrl(url: string): Promise<ParsedJob> {
    let pageText: string;
    try {
      const browser = await this.getBrowser();
      const page = await browser.newPage({
        userAgent: 'Mozilla/5.0 (compatible; job-tracker/0.1)',
      });
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
        const html = await page.content();
        const $ = cheerio.load(html);
        // Some SPAs (e.g. Workday) render the visible JD into a client-side
        // root that isn't captured by page.content()'s serialized body, but
        // still populate a full-text og:description meta tag server-side for
        // link previews/SEO — fall back to it when the body has no real text.
        const ogDescription = $('meta[property="og:description"]').attr('content')?.trim();
        $('script, style, nav, footer, header, noscript').remove();
        const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
        // Some boards (e.g. Netflix's Eightfold-powered pages) render a huge
        // JSON app-state blob as literal body text — long enough to pass a
        // length-only check, but pure garbage for extraction. Prefer
        // og:description whenever bodyText is short OR JSON-dominated.
        const useBodyText = bodyText.length > 200 && !looksLikeJsonDump(bodyText);
        pageText = (useBodyText ? bodyText : ogDescription || bodyText).slice(0, 60000);
      } finally {
        await page.close();
      }
    } catch (err) {
      this.logger.warn(`Failed to render job URL ${url}: ${err}`);
      return { fetchFailed: true };
    }

    if (!pageText) return { fetchFailed: true };

    const jobId = extractJobIdFromUrl(url);

    try {
      const extracted = await this.extractWithLlm(pageText);
      return { ...extracted, jobId, fetchFailed: false };
    } catch (err) {
      this.logger.warn(`LLM extraction failed for ${url}: ${err}`);
      return { jobId, fetchFailed: true };
    }
  }

  private async extractWithLlm(pageText: string): Promise<Omit<ParsedJob, 'fetchFailed'>> {
    const endpoint = process.env.AZURE_LLM_ENDPOINT;
    const apiKey = process.env.AZURE_LLM_API_KEY;
    const deployment = process.env.AZURE_LLM_DEPLOYMENT_NAME ?? 'gpt-4.1';
    const apiVersion = process.env.AZURE_LLM_API_VERSION ?? '2024-12-01-preview';

    if (!endpoint || !apiKey) {
      throw new Error('AZURE_LLM_ENDPOINT / AZURE_LLM_API_KEY not configured');
    }

    // Defensive: AZURE_LLM_ENDPOINT should be the bare resource URL (no trailing
    // /openai — this code appends its own /openai/deployments/... path below).
    // Strip it anyway in case it's ever misconfigured with the suffix again.
    const baseEndpoint = endpoint.replace(/\/openai\/?$/, '');
    const url = `${baseEndpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: buildExtractionSystemPrompt() },
          { role: 'user', content: pageText },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM extraction request failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      choices: { message: { content: string } }[];
    };
    const raw = data.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw);

    return {
      company: parsed.company ?? undefined,
      role: parsed.role ?? undefined,
      jdText: parsed.jdText ?? undefined,
      postedDate: parsed.postedDate ?? undefined,
      applyByDate: parsed.applyByDate ?? undefined,
      salaryRange: parsed.salaryRange ?? undefined,
      experienceLevel: parsed.experienceLevel ?? undefined,
    };
  }
}
