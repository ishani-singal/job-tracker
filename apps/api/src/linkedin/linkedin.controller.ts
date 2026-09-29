import { Controller, Get } from '@nestjs/common';
import { LinkedinService } from './linkedin.service';

const AGENT_SERVICE_URL = process.env.RESU_AGENT_URL ?? 'http://localhost:8743';

@Controller('linkedin')
export class LinkedinController {
  constructor(private readonly linkedin: LinkedinService) {}

  @Get('profile')
  getProfile() {
    return this.linkedin.getProfile();
  }

  @Get('staleness')
  getStaleness() {
    return this.linkedin.getStaleness();
  }

  @Get('prompt-preview')
  async promptPreview() {
    const response = await fetch(`${AGENT_SERVICE_URL}/linkedin/prompt-preview`);
    if (!response.ok) {
      throw new Error(`LinkedIn prompt preview request failed: ${response.status}`);
    }
    return response.json();
  }
}
