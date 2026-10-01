import { forwardRef, Module } from '@nestjs/common';
import { CompanyRolesController } from './company-roles.controller';
import { CompanyRolesService } from './company-roles.service';
import { ApplicationsModule } from '../applications/applications.module';
import { LocationsModule } from '../locations/locations.module';
import { LlmKillSwitchModule } from '../llm-kill-switch/llm-kill-switch.module';

@Module({
  imports: [forwardRef(() => ApplicationsModule), LocationsModule, LlmKillSwitchModule],
  controllers: [CompanyRolesController],
  providers: [CompanyRolesService],
  exports: [CompanyRolesService],
})
export class CompanyRolesModule {}
