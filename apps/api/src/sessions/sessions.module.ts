import { forwardRef, Module } from '@nestjs/common';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { StoriesModule } from '../stories/stories.module';

@Module({
  imports: [forwardRef(() => StoriesModule)],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
