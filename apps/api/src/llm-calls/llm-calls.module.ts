import { Module } from '@nestjs/common';
import { LlmCallsController } from './llm-calls.controller';
import { LlmCallsService } from './llm-calls.service';

@Module({
  controllers: [LlmCallsController],
  providers: [LlmCallsService],
  exports: [LlmCallsService],
})
export class LlmCallsModule {}
