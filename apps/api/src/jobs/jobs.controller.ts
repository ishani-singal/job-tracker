import { Body, Controller, Post } from '@nestjs/common';
import { JobsService } from './jobs.service';

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post('parse')
  parse(@Body() body: { url: string }) {
    return this.jobs.parseJobUrl(body.url);
  }
}
