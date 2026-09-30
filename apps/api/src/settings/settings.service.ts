import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface UpdateSettingsInput {
  inactivityThresholdDays?: number;
  deadlineThresholdDays?: number;
  minMatchScoreFilter?: number | null;
  postedBeforeTodayFilterOn?: boolean;
}

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get() {
    const existing = await this.prisma.appSettings.findFirst();
    if (existing) return existing;
    return this.prisma.appSettings.create({ data: {} });
  }

  async update(input: UpdateSettingsInput) {
    const existing = await this.get();
    return this.prisma.appSettings.update({
      where: { id: existing.id },
      data: {
        ...(input.inactivityThresholdDays !== undefined && {
          inactivityThresholdDays: input.inactivityThresholdDays,
        }),
        ...(input.deadlineThresholdDays !== undefined && {
          deadlineThresholdDays: input.deadlineThresholdDays,
        }),
        ...(input.minMatchScoreFilter !== undefined && {
          minMatchScoreFilter: input.minMatchScoreFilter,
        }),
        ...(input.postedBeforeTodayFilterOn !== undefined && {
          postedBeforeTodayFilterOn: input.postedBeforeTodayFilterOn,
        }),
      },
    });
  }
}
