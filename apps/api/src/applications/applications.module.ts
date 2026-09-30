import { forwardRef, Module } from '@nestjs/common';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { AnalyticsModule } from '../analytics/analytics.module';
import { CompanyRolesModule } from '../company-roles/company-roles.module';
import { ResumesModule } from '../resumes/resumes.module';

@Module({
  imports: [AnalyticsModule, forwardRef(() => CompanyRolesModule), ResumesModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsService],
  exports: [ApplicationsService],
})
export class ApplicationsModule {}
