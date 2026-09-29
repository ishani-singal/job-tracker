import { Module } from '@nestjs/common';
import { CompanyRolesController } from './company-roles.controller';
import { CompanyRolesService } from './company-roles.service';
import { ApplicationsModule } from '../applications/applications.module';

@Module({
  imports: [ApplicationsModule],
  controllers: [CompanyRolesController],
  providers: [CompanyRolesService],
})
export class CompanyRolesModule {}
