import { Module } from '@nestjs/common';
import { LlmKillSwitchService } from './llm-kill-switch.service';
import { LlmKillSwitchController } from './llm-kill-switch.controller';

@Module({
  controllers: [LlmKillSwitchController],
  providers: [LlmKillSwitchService],
  exports: [LlmKillSwitchService],
})
export class LlmKillSwitchModule {}
