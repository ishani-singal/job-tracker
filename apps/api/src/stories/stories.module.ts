import { Module } from '@nestjs/common';
import { StoriesController } from './stories.controller';
import { StoriesService } from './stories.service';
import { ResumesModule } from '../resumes/resumes.module';
import { GithubModule } from '../github/github.module';

@Module({
  imports: [ResumesModule, GithubModule],
  controllers: [StoriesController],
  providers: [StoriesService],
  exports: [StoriesService],
})
export class StoriesModule {}
