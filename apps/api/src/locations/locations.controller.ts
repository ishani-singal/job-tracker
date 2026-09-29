import { Controller, Get, Query } from '@nestjs/common';
import { LocationsService } from './locations.service';

@Controller('locations')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get('search')
  search(@Query('q') q: string, @Query('country') country?: string, @Query('state') state?: string) {
    return this.locations.search(q ?? '', { country, state });
  }

  @Get('countries')
  listCountries() {
    return this.locations.listCountries();
  }

  @Get('states')
  listStates(@Query('country') country: string) {
    return this.locations.listStates(country ?? '');
  }
}
