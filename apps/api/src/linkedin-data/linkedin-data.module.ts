import { Module } from '@nestjs/common';
import { LinkedinDataController } from './linkedin-data.controller';
import { LinkedinDataService } from './linkedin-data.service';

@Module({
  controllers: [LinkedinDataController],
  providers: [LinkedinDataService],
})
export class LinkedinDataModule {}
