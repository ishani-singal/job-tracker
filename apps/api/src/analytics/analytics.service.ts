import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Application } from '@prisma/client';

export type DerivedStatus = 'active' | 'inactive' | 'stale' | 'rejected';

export interface DerivedApplication {
  application: Application;
  status: DerivedStatus;
  daysSincePosting: number;
  counted: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_PER_COMPANY = 3;

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / MS_PER_DAY);
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  private async getThresholds() {
    const settings = await this.prisma.appSettings.findFirst();
    return {
      inactivityThresholdDays: settings?.inactivityThresholdDays ?? 14,
      deadlineThresholdDays: settings?.deadlineThresholdDays ?? 30,
    };
  }

  /**
   * Derives status per application and applies the 3-per-company cap: beyond the
   * first 3 (earliest by applied/created date) within a company, later applications
   * are excluded entirely from all aggregate counts.
   */
  async deriveAll(): Promise<DerivedApplication[]> {
    const [apps, thresholds] = await Promise.all([
      this.prisma.application.findMany(),
      this.getThresholds(),
    ]);
    const today = new Date();

    const byCompany = new Map<string, Application[]>();
    for (const app of apps) {
      const key = app.company.trim().toLowerCase();
      const group = byCompany.get(key) ?? [];
      group.push(app);
      byCompany.set(key, group);
    }

    const countedIds = new Set<string>();
    for (const group of byCompany.values()) {
      const sorted = [...group].sort((a, b) => {
        const aDate = a.appliedDate ?? a.createdAt;
        const bDate = b.appliedDate ?? b.createdAt;
        return aDate.getTime() - bDate.getTime();
      });
      for (const app of sorted.slice(0, MAX_PER_COMPANY)) {
        countedIds.add(app.id);
      }
    }

    return apps.map((app) => {
      const counted = countedIds.has(app.id);

      if (app.rejectedDate) {
        return {
          application: app,
          status: 'rejected',
          daysSincePosting: daysBetween(app.rejectedDate, app.postedDate ?? app.createdAt),
          counted,
        };
      }

      const effectiveAppliedDate = app.appliedDate ?? today;
      const effectivePostedDate = app.postedDate ?? app.createdAt;
      const daysSincePosting = daysBetween(effectiveAppliedDate, effectivePostedDate);

      let status: DerivedStatus;
      if (app.appliedDate) {
        status = daysSincePosting > thresholds.inactivityThresholdDays ? 'inactive' : 'active';
      } else {
        status = daysSincePosting > thresholds.deadlineThresholdDays ? 'stale' : 'active';
      }

      return { application: app, status, daysSincePosting, counted };
    });
  }

  async getSummary() {
    const derived = await this.deriveAll();
    const counted = derived.filter((d) => d.counted);

    const uniqueCompanies = new Set(
      counted
        .filter((d) => d.application.status === 'APPLIED')
        .map((d) => d.application.company.trim().toLowerCase()),
    );

    const totalActive = counted.filter((d) => d.status === 'active').length;
    const totalApplied = counted.filter((d) => d.application.status === 'APPLIED').length;
    const totalCallbacks = counted.filter((d) => d.application.lastMessageReceivedDate).length;

    return {
      uniqueCompanies: uniqueCompanies.size,
      totalActiveApplications: totalActive,
      totalApplicationsDone: totalApplied,
      totalCallbacks,
    };
  }

  /**
   * Daily series: applications per day, 7-day running average, callbacks per day,
   * and cumulative callback rate (cumulative callbacks / cumulative applications).
   */
  async getTimeseries() {
    const derived = await this.deriveAll();
    const counted = derived
      .filter((d) => d.counted && d.application.status === 'APPLIED' && d.application.appliedDate)
      .map((d) => d.application);

    if (counted.length === 0) return [];

    const byDate = new Map<string, { applications: number; callbacks: number }>();
    for (const app of counted) {
      const dateKey = app.appliedDate!.toISOString().slice(0, 10);
      const entry = byDate.get(dateKey) ?? { applications: 0, callbacks: 0 };
      entry.applications += 1;
      if (app.lastMessageReceivedDate) entry.callbacks += 1;
      byDate.set(dateKey, entry);
    }

    const sortedDates = [...byDate.keys()].sort();
    const start = new Date(sortedDates[0]);
    const end = new Date(sortedDates[sortedDates.length - 1]);

    const allDates: string[] = [];
    for (let d = new Date(start); d <= end; d = new Date(d.getTime() + MS_PER_DAY)) {
      allDates.push(d.toISOString().slice(0, 10));
    }

    let cumulativeApplications = 0;
    let cumulativeCallbacks = 0;
    const last7: number[] = [];

    return allDates.map((date) => {
      const entry = byDate.get(date) ?? { applications: 0, callbacks: 0 };
      cumulativeApplications += entry.applications;
      cumulativeCallbacks += entry.callbacks;

      last7.push(entry.applications);
      if (last7.length > 7) last7.shift();
      const runningAverage7d = last7.reduce((a, b) => a + b, 0) / last7.length;

      const callbackRate =
        cumulativeApplications > 0 ? cumulativeCallbacks / cumulativeApplications : 0;

      return {
        date,
        applications: entry.applications,
        callbacks: entry.callbacks,
        runningAverage7d,
        callbackRate,
      };
    });
  }
}
