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
  fetchFailed: boolean;
}

const EXTRACTION_SYSTEM_PROMPT = `You extract structured job-posting fields from raw page
text. Return ONLY a JSON object with these keys (use null for anything not present):
company (string), role (string, the job title as posted, e.g. "Senior Product Manager" —
not the department or team name), jdText (string, the role description/requirements/
qualifications only — exclude compensation/benefits boilerplate), postedDate (ISO date
string), applyByDate (ISO date string), salaryRange (string), experienceLevel (string, e.g.
"5+ years" or "Senior"). Do not include any text outside the JSON object.`;

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
        $('script, style, nav, footer, header, noscript').remove();
        pageText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 20000);
      } finally {
        await page.close();
      }
    } catch (err) {
      this.logger.warn(`Failed to render job URL ${url}: ${err}`);
      return { fetchFailed: true };
    }

    if (!pageText) return { fetchFailed: true };

    try {
      const extracted = await this.extractWithLlm(pageText);
      return { ...extracted, fetchFailed: false };
    } catch (err) {
      this.logger.warn(`LLM extraction failed for ${url}: ${err}`);
      return { fetchFailed: true };
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

    // AZURE_LLM_ENDPOINT may already include a trailing /openai (as Soma's own env
    // does) — strip it so we don't end up with .../openai/openai/deployments/...
    const baseEndpoint = endpoint.replace(/\/openai\/?$/, '');
    const url = `${baseEndpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
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
