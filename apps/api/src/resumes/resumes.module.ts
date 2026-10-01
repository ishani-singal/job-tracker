import { forwardRef, Module } from '@nestjs/common';
import { ResumesController } from './resumes.controller';
import { ResumesService } from './resumes.service';
import { StoriesModule } from '../stories/stories.module';

@Module({
  imports: [forwardRef(() => StoriesModule)],
  controllers: [ResumesController],
  providers: [ResumesService],
  exports: [ResumesService],
})
export class ResumesModule {}
