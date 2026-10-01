import { forwardRef, Module } from '@nestjs/common';
import { StoriesController } from './stories.controller';
import { StoriesService } from './stories.service';
import { ResumesModule } from '../resumes/resumes.module';
import { EntriesModule } from '../entries/entries.module';
import { GithubModule } from '../github/github.module';
import { SessionsModule } from '../sessions/sessions.module';

@Module({
  imports: [
    forwardRef(() => ResumesModule),
    EntriesModule,
    GithubModule,
    forwardRef(() => SessionsModule),
  ],
  controllers: [StoriesController],
  providers: [StoriesService],
  exports: [StoriesService],
})
export class StoriesModule {}
