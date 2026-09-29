import { Module } from '@nestjs/common';
import { LinkedinController } from './linkedin.controller';
import { LinkedinService } from './linkedin.service';

@Module({
  controllers: [LinkedinController],
  providers: [LinkedinService],
  exports: [LinkedinService],
})
export class LinkedinModule {}
