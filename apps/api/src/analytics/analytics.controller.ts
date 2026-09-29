import { Controller, Get } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('summary')
  summary() {
    return this.analytics.getSummary();
  }

  @Get('timeseries')
  timeseries() {
    return this.analytics.getTimeseries();
  }
}
