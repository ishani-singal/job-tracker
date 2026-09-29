import { Module } from '@nestjs/common';
import { CompanyResumesController } from './company-resumes.controller';
import { CompanyResumesService } from './company-resumes.service';

@Module({
  controllers: [CompanyResumesController],
  providers: [CompanyResumesService],
  exports: [CompanyResumesService],
})
export class CompanyResumesModule {}
