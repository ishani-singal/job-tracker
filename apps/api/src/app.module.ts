import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { ApplicationsModule } from './applications/applications.module';
import { ResumesModule } from './resumes/resumes.module';
import { SettingsModule } from './settings/settings.module';
import { JobsModule } from './jobs/jobs.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { GithubModule } from './github/github.module';
import { EntriesModule } from './entries/entries.module';
import { SessionsModule } from './sessions/sessions.module';

@Module({
  imports: [
    PrismaModule,
    ApplicationsModule,
    ResumesModule,
    SettingsModule,
    JobsModule,
    AnalyticsModule,
    GithubModule,
    EntriesModule,
    SessionsModule,
  ],
})
export class AppModule {}
