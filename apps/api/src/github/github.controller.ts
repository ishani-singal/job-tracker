import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { GithubService } from './github.service';

const WEB_APP_URL = process.env.WEB_APP_URL ?? 'http://localhost:3100';

@Controller()
export class GithubController {
  constructor(private readonly github: GithubService) {}

  @Get('auth/github/start')
  start(@Res() res: FastifyReply) {
    const url = this.github.buildAuthorizeUrl();
    return res.redirect(url);
  }

  @Get('auth/github/callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: FastifyReply,
  ) {
    try {
      await this.github.handleCallback(code, state);
      return res.redirect(`${WEB_APP_URL}/resumes?github=connected`);
    } catch {
      return res.redirect(`${WEB_APP_URL}/resumes?github=error`);
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
  connect(@Body() body: { fullName: string }) {
    return this.github.connectRepo(body.fullName);
  }

  @Delete('github/repos/connected/:fullName')
  disconnectRepo(@Param('fullName') fullName: string) {
    return this.github.disconnectRepo(decodeURIComponent(fullName));
  }

  @Get('github/readmes')
  fetchReadmes() {
    return this.github.fetchConnectedReadmes();
  }
}
