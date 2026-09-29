import { Controller, Get, Query } from '@nestjs/common';
import { LocationsService } from './locations.service';

@Controller('locations')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get('search')
  search(@Query('q') q: string) {
    return this.locations.search(q ?? '');
  }
}
