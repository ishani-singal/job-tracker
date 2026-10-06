import { Module } from '@nestjs/common';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { LlmCallsModule } from '../llm-calls/llm-calls.module';

@Module({
  imports: [LlmCallsModule],
  controllers: [JobsController],
  providers: [JobsService],
})
export class JobsModule {}
