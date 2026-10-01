import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { randomBytes } from 'crypto';
import { StoryEntryType } from '@prisma/client';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API_BASE = 'https://api.github.com';

export interface GithubRepoSummary {
  fullName: string;
  description: string | null;
  private: boolean;
  updatedAt: string;
}

@Injectable()
export class GithubService {
  private readonly logger = new Logger(GithubService.name);
  // In-memory CSRF state store — fine for a single-user app with one API process;
  // revisit with a real store if this ever runs behind multiple instances.
  private readonly pendingStates = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  private get clientId() {
    return process.env.GITHUB_OAUTH_CLIENT_ID;
  }

  private get clientSecret() {
    return process.env.GITHUB_OAUTH_CLIENT_SECRET;
  }

  private get callbackUrl() {
    return (
      process.env.GITHUB_OAUTH_CALLBACK_URL ??
      'http://localhost:4100/auth/github/callback'
    );
  }

  buildAuthorizeUrl(): string {
    if (!this.clientId) {
      throw new Error('GITHUB_OAUTH_CLIENT_ID not configured');
    }
    const state = randomBytes(16).toString('hex');
    this.pendingStates.add(state);

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.callbackUrl,
      scope: 'repo read:user',
      state,
    });
    return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
  }

  async handleCallback(code: string, state: string): Promise<void> {
    if (!this.pendingStates.has(state)) {
      throw new UnauthorizedException('Invalid or expired OAuth state');
    }
    this.pendingStates.delete(state);

    if (!this.clientId || !this.clientSecret) {
      throw new Error('GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET not configured');
    }

    const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: this.callbackUrl,
      }),
    });
    if (!tokenResponse.ok) {
      throw new Error(`GitHub token exchange failed: ${tokenResponse.status}`);
    }
    const tokenData = (await tokenResponse.json()) as {
      access_token?: string;
      scope?: string;
      error?: string;
    };
    if (!tokenData.access_token) {
      throw new Error(`GitHub token exchange error: ${tokenData.error ?? 'unknown'}`);
    }

    const userResponse = await fetch(`${GITHUB_API_BASE}/user`, {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (!userResponse.ok) {
      throw new Error(`GitHub user lookup failed: ${userResponse.status}`);
    }
    const user = (await userResponse.json()) as { login: string };

    // Single-user app: replace any existing connection rather than accumulate rows.
    await this.prisma.githubConnection.deleteMany({});
    await this.prisma.githubConnection.create({
      data: {
        githubLogin: user.login,
        accessToken: tokenData.access_token,
        scope: tokenData.scope,
      },
    });
  }

  /** Connection status for the frontend — deliberately omits accessToken. */
  async getConnection(): Promise<{ githubLogin: string; connectedAt: Date } | null> {
    const connection = await this.prisma.githubConnection.findFirst();
    if (!connection) return null;
    return { githubLogin: connection.githubLogin, connectedAt: connection.connectedAt };
  }

  async disconnect() {
    await this.prisma.githubConnection.deleteMany({});
    await this.prisma.connectedRepo.deleteMany({});
  }

  private async requireToken(): Promise<string> {
    const connection = await this.prisma.githubConnection.findFirst();
    if (!connection) {
      throw new UnauthorizedException('GitHub not connected — connect it in Settings first');
    }
    return connection.accessToken;
  }

  async listAvailableRepos(): Promise<GithubRepoSummary[]> {
    const token = await this.requireToken();
    const repos: GithubRepoSummary[] = [];
    let page = 1;
    // Cap at 5 pages (500 repos) — plenty for a personal account, avoids unbounded pagination.
    while (page <= 5) {
      const response = await fetch(
        `${GITHUB_API_BASE}/user/repos?per_page=100&page=${page}&sort=updated`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
          },
        },
      );
      if (!response.ok) {
        throw new Error(`GitHub repo list failed: ${response.status}`);
      }
      const batch = (await response.json()) as {
        full_name: string;
        description: string | null;
        private: boolean;
        updated_at: string;
      }[];
      if (batch.length === 0) break;
      repos.push(
        ...batch.map((r) => ({
          fullName: r.full_name,
          description: r.description,
          private: r.private,
          updatedAt: r.updated_at,
        })),
      );
      if (batch.length < 100) break;
      page += 1;
    }
    return repos;
  }

  listConnectedRepos() {
    return this.prisma.connectedRepo.findMany({ orderBy: { addedAt: 'desc' } });
  }

  listConnectedReposForEntry(entryType: StoryEntryType, entryId: string) {
    return this.prisma.connectedRepo.findMany({ where: { entryType, entryId } });
  }

  /** Pins a connected repo to exactly one entry (almost always a
   * ProjectEntry) — required, same as StoryFile/ResumeFile's
   * entryType/entryId, so resume generation knows which entry's narrative
   * to extract this repo's content into. */
  async connectRepo(fullName: string, entryType: StoryEntryType, entryId: string) {
    return this.prisma.connectedRepo.upsert({
      where: { fullName },
      create: { fullName, entryType, entryId },
      update: { entryType, entryId },
    });
  }

  async disconnectRepo(fullName: string) {
    await this.prisma.connectedRepo.deleteMany({ where: { fullName } });
  }

  /**
   * Fetches README content for every connected repo — used by the resu agent as
   * supplementary "Stories" material (real project descriptions/tech stack)
   * alongside manually uploaded Stories files.
   */
  async fetchConnectedReadmes(): Promise<{ repo: string; readme: string }[]> {
    const token = await this.requireToken();
    const connected = await this.listConnectedRepos();

    const results = await Promise.all(
      connected.map(async ({ fullName }) => {
        try {
          const response = await fetch(`${GITHUB_API_BASE}/repos/${fullName}/readme`, {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github.raw+json',
            },
          });
          if (!response.ok) {
            this.logger.warn(`README fetch failed for ${fullName}: ${response.status}`);
            return null;
          }
          const readme = await response.text();
          return { repo: fullName, readme };
        } catch (err) {
          this.logger.warn(`README fetch error for ${fullName}: ${err}`);
          return null;
        }
      }),
    );

    return results.filter((r): r is { repo: string; readme: string } => r !== null);
  }

  /**
   * Fetches a richer per-repo profile (description/topics/languages/root file
   * listing + README) for every connected repo — fed into the story-extraction
   * pipeline so each repo can be characterized as one candidate ProjectEntry
   * story, not just a README dump. A shallow (non-recursive) root listing is
   * enough to infer "this is a Next.js app" / "this is a CLI tool" without a
   * deep recursive crawl.
   */
  async fetchConnectedRepoDetails(): Promise<GithubRepoDetails[]> {
    const token = await this.requireToken();
    const connected = await this.listConnectedRepos();
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    };

    const results = await Promise.all(
      connected.map(async ({ fullName }): Promise<GithubRepoDetails | null> => {
        try {
          const [repoRes, languagesRes, contentsRes, readmeRes] = await Promise.all([
            fetch(`${GITHUB_API_BASE}/repos/${fullName}`, { headers }),
            fetch(`${GITHUB_API_BASE}/repos/${fullName}/languages`, { headers }),
            fetch(`${GITHUB_API_BASE}/repos/${fullName}/contents`, { headers }),
            fetch(`${GITHUB_API_BASE}/repos/${fullName}/readme`, {
              headers: { ...headers, Accept: 'application/vnd.github.raw+json' },
            }),
          ]);

          if (!repoRes.ok) {
            this.logger.warn(`Repo details fetch failed for ${fullName}: ${repoRes.status}`);
            return null;
          }
          const repo = (await repoRes.json()) as {
            description: string | null;
            topics?: string[];
            html_url: string;
          };

          const languages = languagesRes.ok
            ? Object.keys((await languagesRes.json()) as Record<string, number>)
            : [];

          const rootFiles = contentsRes.ok
            ? ((await contentsRes.json()) as { name: string }[]).map((f) => f.name)
            : [];

          const readme = readmeRes.ok ? await readmeRes.text() : '';

          return {
            repo: fullName,
            url: repo.html_url,
            description: repo.description,
            topics: repo.topics ?? [],
            languages,
            rootFiles,
            readme,
          };
        } catch (err) {
          this.logger.warn(`Repo details fetch error for ${fullName}: ${err}`);
          return null;
        }
      }),
    );

    return results.filter((r): r is GithubRepoDetails => r !== null);
  }

  /** Same shape as fetchConnectedRepoDetails but for exactly one repo — used
   * by document generation (StoriesService.getRawSourcesForEntry), which
   * only ever needs one entry's own connected repos, not every connected
   * repo in the account. */
  async fetchRepoDetail(fullName: string): Promise<GithubRepoDetails | null> {
    const token = await this.requireToken();
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };

    try {
      const [repoRes, languagesRes, contentsRes, readmeRes] = await Promise.all([
        fetch(`${GITHUB_API_BASE}/repos/${fullName}`, { headers }),
        fetch(`${GITHUB_API_BASE}/repos/${fullName}/languages`, { headers }),
        fetch(`${GITHUB_API_BASE}/repos/${fullName}/contents`, { headers }),
        fetch(`${GITHUB_API_BASE}/repos/${fullName}/readme`, {
          headers: { ...headers, Accept: 'application/vnd.github.raw+json' },
        }),
      ]);
      if (!repoRes.ok) {
        this.logger.warn(`Repo detail fetch failed for ${fullName}: ${repoRes.status}`);
        return null;
      }
      const repo = (await repoRes.json()) as { description: string | null; topics?: string[]; html_url: string };
      const languages = languagesRes.ok
        ? Object.keys((await languagesRes.json()) as Record<string, number>)
        : [];
      const rootFiles = contentsRes.ok
        ? ((await contentsRes.json()) as { name: string }[]).map((f) => f.name)
        : [];
      const readme = readmeRes.ok ? await readmeRes.text() : '';

      return {
        repo: fullName,
        url: repo.html_url,
        description: repo.description,
        topics: repo.topics ?? [],
        languages,
        rootFiles,
        readme,
      };
    } catch (err) {
      this.logger.warn(`Repo detail fetch error for ${fullName}: ${err}`);
      return null;
    }
  }
}

export interface GithubRepoDetails {
  repo: string;
  url: string;
  description: string | null;
  topics: string[];
  languages: string[];
  rootFiles: string[];
  readme: string;
}
