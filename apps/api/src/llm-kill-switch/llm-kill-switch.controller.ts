import { Controller, Post } from '@nestjs/common';
import { LlmKillSwitchService } from './llm-kill-switch.service';

@Controller('llm')
export class LlmKillSwitchController {
  constructor(private readonly killSwitch: LlmKillSwitchService) {}

  @Post('stop')
  stop() {
    this.killSwitch.stop();
    return { stopped: true };
  }
}
