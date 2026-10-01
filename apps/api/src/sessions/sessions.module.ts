import { forwardRef, Module } from '@nestjs/common';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { StoriesModule } from '../stories/stories.module';
import { LlmKillSwitchModule } from '../llm-kill-switch/llm-kill-switch.module';

@Module({
  imports: [forwardRef(() => StoriesModule), LlmKillSwitchModule],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
