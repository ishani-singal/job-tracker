import { forwardRef, Module } from '@nestjs/common';
import { CompanyRolesController } from './company-roles.controller';
import { CompanyRolesService } from './company-roles.service';
import { ApplicationsModule } from '../applications/applications.module';

@Module({
  imports: [forwardRef(() => ApplicationsModule)],
  controllers: [CompanyRolesController],
  providers: [CompanyRolesService],
  exports: [CompanyRolesService],
})
export class CompanyRolesModule {}
