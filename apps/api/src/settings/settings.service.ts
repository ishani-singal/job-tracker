import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface UpdateSettingsInput {
  inactivityThresholdDays?: number;
  deadlineThresholdDays?: number;
  minMatchScoreFilter?: number | null;
  postedBeforeTodayFilterOn?: boolean;
  postedWithinDaysFilter?: number;
  hideInvalidConditionRolesFilterOn?: boolean;
  excludeKeywordsFilter?: string;
  locationTextFilter?: string;
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
        ...(input.postedWithinDaysFilter !== undefined && {
          postedWithinDaysFilter: input.postedWithinDaysFilter,
        }),
        ...(input.hideInvalidConditionRolesFilterOn !== undefined && {
          hideInvalidConditionRolesFilterOn: input.hideInvalidConditionRolesFilterOn,
        }),
        ...(input.excludeKeywordsFilter !== undefined && {
          excludeKeywordsFilter: input.excludeKeywordsFilter,
        }),
        ...(input.locationTextFilter !== undefined && {
          locationTextFilter: input.locationTextFilter,
        }),
      },
    });
  }
}
