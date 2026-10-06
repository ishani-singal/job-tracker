import { Module } from '@nestjs/common';
import { ReferralsController } from './referrals.controller';
import { ReferralsService } from './referrals.service';
import { ResumesModule } from '../resumes/resumes.module';
import { SessionsModule } from '../sessions/sessions.module';

@Module({
  imports: [ResumesModule, SessionsModule],
  controllers: [ReferralsController],
  providers: [ReferralsService],
})
export class ReferralsModule {}
