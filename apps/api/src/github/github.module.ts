import { forwardRef, Module } from '@nestjs/common';
import { GithubController } from './github.controller';
import { GithubService } from './github.service';
import { StoriesModule } from '../stories/stories.module';

@Module({
  imports: [forwardRef(() => StoriesModule)],
  controllers: [GithubController],
  providers: [GithubService],
  exports: [GithubService],
})
export class GithubModule {}
