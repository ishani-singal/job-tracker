'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '@/lib/api';

// Categorical slots from the dataviz skill's validated reference palette
// (references/palette.md) — fixed assignment, never cycled/reused across charts.
const COLOR_APPLICATIONS = '#2a78d6'; // slot 1: blue
const COLOR_CALLBACKS = '#1baf7a'; // slot 3: aqua
const COLOR_RUNNING_AVG = '#eb6834'; // slot 2: orange
const COLOR_CALLBACK_RATE = '#4a3aa7'; // slot 7: violet
const GRID_COLOR = 'rgba(128,128,128,0.2)';

export default function DashboardPage() {
  const queryClient = useQueryClient();
  const { data: summary } = useQuery({ queryKey: ['summary'], queryFn: api.getSummary });
  const { data: timeseries } = useQuery({
    queryKey: ['timeseries'],
    queryFn: api.getTimeseries,
  });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });

  const [inactivity, setInactivity] = useState('');
  const [deadline, setDeadline] = useState('');

  async function saveThresholds() {
    await api.updateSettings({
      ...(inactivity && { inactivityThresholdDays: Number(inactivity) }),
      ...(deadline && { deadlineThresholdDays: Number(deadline) }),
    });
    queryClient.invalidateQueries({ queryKey: ['settings'] });
    queryClient.invalidateQueries({ queryKey: ['summary'] });
    queryClient.invalidateQueries({ queryKey: ['applications'] });
  }

  return (
    <div className="max-w-5xl mx-auto flex flex-col gap-8">
      <h1 className="text-xl font-semibold">Dashboard</h1>

      <section className="grid grid-cols-4 gap-4">
        <StatTile label="Unique Companies" value={summary?.uniqueCompanies} />
        <StatTile label="Active Applications" value={summary?.totalActiveApplications} />
        <StatTile label="Applications Done" value={summary?.totalApplicationsDone} />
        <StatTile label="Callbacks" value={summary?.totalCallbacks} />
      </section>

      <section className="flex gap-4 items-end text-sm">
        <label className="flex flex-col gap-1">
          Inactivity threshold (days)
          <input
            type="number"
            className="border rounded px-2 py-1 w-32 bg-transparent"
            placeholder={settings?.inactivityThresholdDays?.toString()}
            value={inactivity}
            onChange={(e) => setInactivity(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          Deadline threshold (days)
          <input
            type="number"
            className="border rounded px-2 py-1 w-32 bg-transparent"
            placeholder={settings?.deadlineThresholdDays?.toString()}
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
          />
        </label>
        <button className="px-3 py-1.5 rounded border" onClick={saveThresholds}>
          Save Thresholds
        </button>
      </section>

      {timeseries && timeseries.length > 0 ? (
        <>
          <ChartCard title="Applications per Day">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={timeseries}>
                <CartesianGrid stroke={GRID_COLOR} vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="applications" fill={COLOR_APPLICATIONS} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="7-Day Running Average of Applications">
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={timeseries}>
                <CartesianGrid stroke={GRID_COLOR} vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Line
                  type="monotone"
                  dataKey="runningAverage7d"
                  stroke={COLOR_RUNNING_AVG}
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Callbacks per Day">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={timeseries}>
                <CartesianGrid stroke={GRID_COLOR} vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="callbacks" fill={COLOR_CALLBACKS} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Cumulative Callback Rate">
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={timeseries}>
                <CartesianGrid stroke={GRID_COLOR} vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v) => `${Math.round(v * 100)}%`}
                />
                <Tooltip formatter={(v: number) => `${(v * 100).toFixed(1)}%`} />
                <Line
                  type="monotone"
                  dataKey="callbackRate"
                  stroke={COLOR_CALLBACK_RATE}
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        </>
      ) : (
        <p className="text-sm opacity-60">No applied applications yet — charts will appear once you have some.</p>
      )}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="border rounded px-4 py-3 flex flex-col gap-1">
      <span className="text-xs opacity-60">{label}</span>
      <span className="text-2xl font-semibold">{value ?? '—'}</span>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border rounded p-4 flex flex-col gap-2">
      <h2 className="text-sm font-medium">{title}</h2>
      {children}
    </div>
  );
}
