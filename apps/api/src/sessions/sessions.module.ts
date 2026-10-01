import { Module } from '@nestjs/common';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { LlmKillSwitchModule } from '../llm-kill-switch/llm-kill-switch.module';
import { StoriesModule } from '../stories/stories.module';

@Module({
  imports: [LlmKillSwitchModule, StoriesModule],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
