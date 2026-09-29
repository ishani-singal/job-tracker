import { Body, Controller, Get, Patch } from '@nestjs/common';
import { SettingsService, UpdateSettingsInput } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  get() {
    return this.settings.get();
  }

  @Patch()
  update(@Body() body: UpdateSettingsInput) {
    return this.settings.update(body);
  }
}
