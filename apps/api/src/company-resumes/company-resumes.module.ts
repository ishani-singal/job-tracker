import { Module } from '@nestjs/common';
import { CompanyResumesController } from './company-resumes.controller';
import { CompanyResumesService } from './company-resumes.service';
import { ResumesModule } from '../resumes/resumes.module';

@Module({
  imports: [ResumesModule],
  controllers: [CompanyResumesController],
  providers: [CompanyResumesService],
  exports: [CompanyResumesService],
})
export class CompanyResumesModule {}
