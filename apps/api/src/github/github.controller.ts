import {
  Body,
  Controller,
  Delete,
  forwardRef,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { GithubService } from './github.service';
import { StoriesService } from '../stories/stories.service';
import { StoryEntryType } from '@prisma/client';

const WEB_APP_URL = process.env.WEB_APP_URL ?? 'http://localhost:3100';

@Controller()
export class GithubController {
  constructor(
    private readonly github: GithubService,
    @Inject(forwardRef(() => StoriesService))
    private readonly stories: StoriesService,
  ) {}

  @Get('auth/github/start')
  start(@Res() res: FastifyReply) {
    const url = this.github.buildAuthorizeUrl();
    return res.status(302).redirect(url);
  }

  @Get('auth/github/callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: FastifyReply,
  ) {
    try {
      await this.github.handleCallback(code, state);
      return res.status(302).redirect(`${WEB_APP_URL}/resumes?github=connected`);
    } catch {
      return res.status(302).redirect(`${WEB_APP_URL}/resumes?github=error`);
    }
  }

  @Get('github/connection')
  getConnection() {
    return this.github.getConnection();
  }

  @Delete('github/connection')
  disconnect() {
    return this.github.disconnect();
  }

  @Get('github/repos/available')
  listAvailable() {
    return this.github.listAvailableRepos();
  }

  @Get('github/repos/connected')
  listConnected() {
    return this.github.listConnectedRepos();
  }

  @Post('github/repos/connected')
  connect(@Body() body: { fullName: string; entryType: StoryEntryType; entryId: string }) {
    return this.github.connectRepo(body.fullName, body.entryType, body.entryId);
  }

  @Delete('github/repos/connected/:fullName')
  async disconnectRepo(@Param('fullName') fullName: string) {
    const decoded = decodeURIComponent(fullName);
    await this.github.disconnectRepo(decoded);
    await this.stories.invalidateNarrativeForSource({ repoFullName: decoded });
  }

  @Get('github/readmes')
  fetchReadmes() {
    return this.github.fetchConnectedReadmes();
  }

  @Get('github/repo-details')
  fetchRepoDetails() {
    return this.github.fetchConnectedRepoDetails();
  }
}
