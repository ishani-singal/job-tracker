import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface RecordCallInput {
  agent: string;
  runId?: string;
  model: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
}

export interface PriceInput {
  inputPer1M: number;
  cachedInputPer1M: number;
  outputPer1M: number;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function dayKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

@Injectable()
export class LlmCallsService {
  constructor(private readonly prisma: PrismaService) {}

  record(input: RecordCallInput) {
    return this.prisma.llmCall.create({
      data: { ...input, costUsd: input.inputCostUsd + input.outputCostUsd },
    });
  }

  private async getSettings() {
    return (
      (await this.prisma.appSettings.findFirst()) ??
      (await this.prisma.appSettings.create({ data: {} }))
    );
  }

  private async todayUsd(): Promise<number> {
    const agg = await this.prisma.llmCall.aggregate({
      _sum: { costUsd: true },
      where: { createdAt: { gte: startOfDay(new Date()) } },
    });
    return agg._sum.costUsd ?? 0;
  }

  async getConfig() {
    const [settings, prices, todayUsd] = await Promise.all([
      this.getSettings(),
      this.prisma.llmModelPrice.findMany({ orderBy: { model: 'asc' } }),
      this.todayUsd(),
    ]);
    return { dailyBudgetUsd: settings.llmDailyBudgetUsd, todayUsd, prices };
  }

  async list(limit: number) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const chartStart = startOfDay(new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000));
    const [calls, recent, config] = await Promise.all([
      this.prisma.llmCall.findMany({
        orderBy: { createdAt: 'desc' },
        take: Math.min(Math.max(limit || 200, 1), 1000),
      }),
      this.prisma.llmCall.findMany({
        where: { createdAt: { gte: chartStart < monthStart ? chartStart : monthStart } },
        select: { createdAt: true, agent: true, costUsd: true },
      }),
      this.getConfig(),
    ]);

    const byDayMap = new Map<string, number>();
    const byAgentMap = new Map<string, { calls: number; costUsd: number }>();
    let monthUsd = 0;
    for (const c of recent) {
      if (c.createdAt >= chartStart) {
        const k = dayKey(c.createdAt);
        byDayMap.set(k, (byDayMap.get(k) ?? 0) + c.costUsd);
      }
      if (c.createdAt >= monthStart) {
        monthUsd += c.costUsd;
        const a = byAgentMap.get(c.agent) ?? { calls: 0, costUsd: 0 };
        a.calls += 1;
        a.costUsd += c.costUsd;
        byAgentMap.set(c.agent, a);
      }
    }
    const byDay = Array.from({ length: 30 }, (_, i) => {
      const k = dayKey(new Date(chartStart.getFullYear(), chartStart.getMonth(), chartStart.getDate() + i));
      return { date: k, costUsd: byDayMap.get(k) ?? 0 };
    });

    return {
      calls,
      summary: {
        todayUsd: config.todayUsd,
        monthUsd,
        byAgent: Array.from(byAgentMap, ([agent, v]) => ({ agent, ...v })),
        byDay,
      },
      dailyBudgetUsd: config.dailyBudgetUsd,
      prices: config.prices,
    };
  }

  async setDailyBudget(dailyBudgetUsd: number) {
    if (typeof dailyBudgetUsd !== 'number' || !(dailyBudgetUsd >= 0)) {
      throw new BadRequestException('dailyBudgetUsd must be a non-negative number');
    }
    const settings = await this.getSettings();
    await this.prisma.appSettings.update({
      where: { id: settings.id },
      data: { llmDailyBudgetUsd: dailyBudgetUsd },
    });
    return { dailyBudgetUsd };
  }

  upsertPrice(model: string, price: PriceInput) {
    for (const v of [price.inputPer1M, price.cachedInputPer1M, price.outputPer1M]) {
      if (typeof v !== 'number' || !(v >= 0)) {
        throw new BadRequestException('Prices must be non-negative numbers');
      }
    }
    const data = {
      inputPer1M: price.inputPer1M,
      cachedInputPer1M: price.cachedInputPer1M,
      outputPer1M: price.outputPer1M,
    };
    return this.prisma.llmModelPrice.upsert({
      where: { model },
      create: { model, ...data },
      update: data,
    });
  }

  async deletePrice(model: string) {
    await this.prisma.llmModelPrice.deleteMany({ where: { model } });
    return { deleted: true };
  }
}
