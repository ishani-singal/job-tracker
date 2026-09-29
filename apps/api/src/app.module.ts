import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { ApplicationsModule } from './applications/applications.module';
import { ResumesModule } from './resumes/resumes.module';
import { SettingsModule } from './settings/settings.module';
import { JobsModule } from './jobs/jobs.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { GithubModule } from './github/github.module';

@Module({
  imports: [
    PrismaModule,
    ApplicationsModule,
    ResumesModule,
    SettingsModule,
    JobsModule,
    AnalyticsModule,
    GithubModule,
  ],
})
export class AppModule {}
