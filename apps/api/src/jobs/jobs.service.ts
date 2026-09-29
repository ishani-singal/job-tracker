import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';

export interface ParsedJob {
  company?: string;
  jdText?: string;
  postedDate?: string;
  applyByDate?: string;
  salaryRange?: string;
  experienceLevel?: string;
  fetchFailed: boolean;
}

const EXTRACTION_SYSTEM_PROMPT = `You extract structured job-posting fields from raw page
text. Return ONLY a JSON object with these keys (use null for anything not present):
company (string), jdText (string, the role description/requirements/qualifications only —
exclude compensation/benefits boilerplate), postedDate (ISO date string), applyByDate (ISO
date string), salaryRange (string), experienceLevel (string, e.g. "5+ years" or "Senior").
Do not include any text outside the JSON object.`;

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  /**
   * Fetches a job posting URL server-side, strips markup down to visible text via
   * cheerio, then asks the LLM to extract structured fields. Never throws on a
   * parse/fetch failure — callers fall back to manual entry using whatever partial
   * result (or fetchFailed: true) comes back.
   */
  async parseJobUrl(url: string): Promise<ParsedJob> {
    let pageText: string;
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; job-tracker/0.1)' },
      });
      if (!response.ok) {
        return { fetchFailed: true };
      }
      const html = await response.text();
      const $ = cheerio.load(html);
      $('script, style, nav, footer, header, noscript').remove();
      pageText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 20000);
    } catch (err) {
      this.logger.warn(`Failed to fetch job URL ${url}: ${err}`);
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
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-4.1';

    if (!endpoint || !apiKey) {
      throw new Error('AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY not configured');
    }

    const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`;
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
      jdText: parsed.jdText ?? undefined,
      postedDate: parsed.postedDate ?? undefined,
      applyByDate: parsed.applyByDate ?? undefined,
      salaryRange: parsed.salaryRange ?? undefined,
      experienceLevel: parsed.experienceLevel ?? undefined,
    };
  }
}
