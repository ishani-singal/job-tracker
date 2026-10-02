import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { LlmCallsService, PriceInput, RecordCallInput } from './llm-calls.service';

@Controller('llm-calls')
export class LlmCallsController {
  constructor(private readonly llmCalls: LlmCallsService) {}

  @Post()
  record(@Body() body: RecordCallInput) {
    return this.llmCalls.record(body);
  }

  @Get()
  list(@Query('limit') limit?: string) {
    return this.llmCalls.list(limit ? Number(limit) : 200);
  }

  // Agent-facing: what cost_guard.py needs to price a call and enforce the cap.
  @Get('config')
  config() {
    return this.llmCalls.getConfig();
  }

  @Patch('budget')
  setBudget(@Body() body: { dailyBudgetUsd: number }) {
    return this.llmCalls.setDailyBudget(body.dailyBudgetUsd);
  }

  @Put('prices/:model')
  upsertPrice(@Param('model') model: string, @Body() body: PriceInput) {
    return this.llmCalls.upsertPrice(model, body);
  }

  @Delete('prices/:model')
  deletePrice(@Param('model') model: string) {
    return this.llmCalls.deletePrice(model);
  }
}
