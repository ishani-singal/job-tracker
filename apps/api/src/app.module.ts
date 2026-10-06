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
import { LocationsModule } from './locations/locations.module';
import { LinkedinModule } from './linkedin/linkedin.module';
import { CompanyResumesModule } from './company-resumes/company-resumes.module';
import { ReferralsModule } from './referrals/referrals.module';
import { LinkedinDataModule } from './linkedin-data/linkedin-data.module';
import { CompanyRolesModule } from './company-roles/company-roles.module';
import { StoriesModule } from './stories/stories.module';
import { LlmKillSwitchModule } from './llm-kill-switch/llm-kill-switch.module';
import { LlmCallsModule } from './llm-calls/llm-calls.module';

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
    LocationsModule,
    LinkedinModule,
    CompanyResumesModule,
    ReferralsModule,
    LinkedinDataModule,
    CompanyRolesModule,
    StoriesModule,
    LlmKillSwitchModule,
    LlmCallsModule,
  ],
})
export class AppModule {}
