'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { LlmCall, LlmModelPrice } from '@job-tracker/shared-types';
import { api } from '@/lib/api';

const COLOR_COST = '#2a78d6'; // slot 1: blue, same as the dashboard's primary series
const GRID_COLOR = 'rgba(128,128,128,0.2)';

const usd = (v: number) => `$${v.toFixed(v < 0.01 && v > 0 ? 4 : 2)}`;

// What this call would have cost on another model, from its own token counts.
function costOn(c: LlmCall, p: LlmModelPrice): number {
  return ((c.inputTokens - c.cachedTokens) * p.inputPer1M + c.cachedTokens * p.cachedInputPer1M + c.outputTokens * p.outputPer1M) / 1_000_000;
}

const signedUsd = (v: number) => `${v < 0 ? '-' : '+'}${usd(Math.abs(v))}`;

const PRICE_KEYS = ['inputPer1M', 'cachedInputPer1M', 'outputPer1M'] as const;

export default function LlmUsagePage() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['llm-usage'],
    queryFn: api.getLlmUsage,
    refetchInterval: 10_000,
  });

  const [budget, setBudget] = useState('');
  const [altModel, setAltModel] = useState<Record<string, string>>({});
  const [newPrice, setNewPrice] = useState({ model: '', inputPer1M: '', cachedInputPer1M: '', outputPer1M: '' });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['llm-usage'] });

  async function saveBudget() {
    if (budget === '') return;
    await api.setLlmDailyBudget(Number(budget));
    setBudget('');
    refresh();
  }

  async function addPrice() {
    if (!newPrice.model.trim()) return;
    await api.upsertLlmPrice(newPrice.model.trim(), {
      inputPer1M: Number(newPrice.inputPer1M) || 0,
      cachedInputPer1M: Number(newPrice.cachedInputPer1M) || 0,
      outputPer1M: Number(newPrice.outputPer1M) || 0,
    });
    setNewPrice({ model: '', inputPer1M: '', cachedInputPer1M: '', outputPer1M: '' });
    refresh();
  }

  const today = data?.summary.todayUsd ?? 0;
  const cap = data?.dailyBudgetUsd ?? 0;
  const fraction = cap > 0 ? today / cap : 0;
  const blocked = data !== undefined && today >= cap;
  const barColor = blocked ? '#d03b3b' : fraction >= 0.8 ? '#e0a020' : '#1baf7a';
  const priceByModel = new Map(data?.prices.map((p) => [p.model, p]));
  const totalImpact = (data?.calls ?? []).reduce((sum, c) => {
    const alt = priceByModel.get(altModel[c.id]);
    return alt ? sum + costOn(c, alt) - c.costUsd : sum;
  }, 0);
  const anyAlt = Object.values(altModel).some(Boolean);
  const pricedModels = new Set(data?.prices.map((p) => p.model));
  const unpriced = Array.from(new Set(data?.calls.map((c) => c.model))).filter((m) => !pricedModels.has(m));

  return (
    <div className="max-w-5xl mx-auto flex flex-col gap-8">
      <h1 className="text-xl font-semibold">LLM Usage</h1>

      <section className="grid grid-cols-3 gap-4">
        <div className="border rounded px-4 py-3 flex flex-col gap-2 col-span-2">
          <div className="flex items-center justify-between">
            <span className="text-xs opacity-60">Today</span>
            {blocked && <span className="text-xs px-2 py-0.5 rounded bg-red-600 text-white">Blocked</span>}
          </div>
          <span className="text-2xl font-semibold">
            {data ? usd(today) : '—'}{' '}
            <span className="text-sm font-normal opacity-60">of {data ? usd(cap) : '—'} daily cap</span>
          </span>
          <div className="h-2 rounded bg-black/10 dark:bg-white/10 overflow-hidden">
            <div className="h-full" style={{ width: `${Math.min(fraction, 1) * 100}%`, background: barColor }} />
          </div>
        </div>
        <div className="border rounded px-4 py-3 flex flex-col gap-1">
          <span className="text-xs opacity-60">This month</span>
          <span className="text-2xl font-semibold">{data ? usd(data.summary.monthUsd) : '—'}</span>
        </div>
      </section>

      {unpriced.length > 0 && (
        <p className="text-sm text-amber-600">
          No price set for: {unpriced.join(', ')} — those calls are counted as $0. Add a price below.
        </p>
      )}

      <section className="flex gap-4 items-end text-sm">
        <label className="flex flex-col gap-1">
          Daily threshold (USD)
          <input
            type="number"
            min="0"
            step="0.5"
            className="border rounded px-2 py-1 w-32 bg-transparent"
            placeholder={data?.dailyBudgetUsd.toString()}
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          />
        </label>
        <button className="px-3 py-1.5 rounded border" onClick={saveBudget}>
          Save Threshold
        </button>
        <span className="opacity-60 text-xs">
          New LLM requests are refused (HTTP 402) once today&apos;s total reaches this.
        </span>
      </section>

      <section className="border rounded p-4 flex flex-col gap-2">
        <h2 className="text-sm font-medium">By agent (this month)</h2>
        <table className="text-sm">
          <thead>
            <tr className="text-left opacity-60">
              <th className="py-1">Agent</th>
              <th>Calls</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {data?.summary.byAgent.map((a) => (
              <tr key={a.agent}>
                <td className="py-1 pr-6">{a.agent}</td>
                <td className="pr-6">{a.calls}</td>
                <td>{usd(a.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="border rounded p-4 flex flex-col gap-2">
        <h2 className="text-sm font-medium">Cost per day (last 30 days)</h2>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data?.summary.byDay ?? []}>
            <CartesianGrid stroke={GRID_COLOR} vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
            <Tooltip formatter={(v: number) => usd(v)} />
            <Bar dataKey="costUsd" fill={COLOR_COST} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </section>

      <section className="border rounded p-4 flex flex-col gap-2">
        <h2 className="text-sm font-medium">Model prices (USD per 1M tokens)</h2>
        <table className="text-sm">
          <thead>
            <tr className="text-left opacity-60">
              <th className="py-1">Model</th>
              <th>Input</th>
              <th>Cached input</th>
              <th>Output</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.prices.map((p) => (
              <PriceRow key={p.model} price={p} onChanged={refresh} />
            ))}
            <tr>
              <td className="py-1 pr-2">
                <input
                  className="border rounded px-2 py-1 w-40 bg-transparent"
                  placeholder="model name"
                  value={newPrice.model}
                  onChange={(e) => setNewPrice({ ...newPrice, model: e.target.value })}
                />
              </td>
              {PRICE_KEYS.map((k) => (
                <td key={k} className="pr-2">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    className="border rounded px-2 py-1 w-24 bg-transparent"
                    value={newPrice[k]}
                    onChange={(e) => setNewPrice({ ...newPrice, [k]: e.target.value })}
                  />
                </td>
              ))}
              <td>
                <button className="px-3 py-1 rounded border" onClick={addPrice}>
                  Add
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="border rounded p-4 flex flex-col gap-2 overflow-x-auto">
        <h2 className="text-sm font-medium">
          Calls
          {anyAlt && (
            <span className="ml-3 font-normal opacity-70">
              What-if total impact of the selected models: {signedUsd(totalImpact)}
            </span>
          )}
        </h2>
        <p className="text-xs opacity-60">
          Pick another model on a row to see what that call would have cost with it (same token counts; nothing is
          actually switched).
        </p>
        <table className="text-sm whitespace-nowrap">
          <thead>
            <tr className="text-left opacity-60">
              <th className="py-1 pr-4">Time</th>
              <th className="pr-4">Agent</th>
              <th className="pr-4">Model</th>
              <th className="pr-4">Input tok</th>
              <th className="pr-4">Cached tok</th>
              <th className="pr-4">Output tok</th>
              <th className="pr-4">Input cost</th>
              <th className="pr-4">Output cost</th>
              <th className="pr-4">Total</th>
              <th className="pr-4">Try model</th>
              <th className="pr-4">Cost on it</th>
              <th>Impact</th>
            </tr>
          </thead>
          <tbody>
            {data?.calls.map((c) => {
              const alt = priceByModel.get(altModel[c.id]);
              const altCost = alt ? costOn(c, alt) : 0;
              return (
              <tr key={c.id}>
                <td className="py-1 pr-4">{new Date(c.createdAt).toLocaleString()}</td>
                <td className="pr-4">{c.agent}</td>
                <td className="pr-4">{c.model}</td>
                <td className="pr-4">{c.inputTokens.toLocaleString()}</td>
                <td className="pr-4">{c.cachedTokens.toLocaleString()}</td>
                <td className="pr-4">{c.outputTokens.toLocaleString()}</td>
                <td className="pr-4">{usd(c.inputCostUsd)}</td>
                <td className="pr-4">{usd(c.outputCostUsd)}</td>
                <td className="pr-4">{usd(c.costUsd)}</td>
                <td className="pr-4">
                  <select
                    className="border rounded px-2 py-1 bg-transparent"
                    value={altModel[c.id] ?? ''}
                    onChange={(e) => setAltModel({ ...altModel, [c.id]: e.target.value })}
                  >
                    <option value="">—</option>
                    {data.prices
                      .filter((p) => p.model !== c.model)
                      .map((p) => (
                        <option key={p.model} value={p.model}>
                          {p.model}
                        </option>
                      ))}
                  </select>
                </td>
                {alt ? (
                  <>
                    <td className="pr-4">{usd(altCost)}</td>
                    <td className={altCost <= c.costUsd ? 'text-green-600' : 'text-red-600'}>
                      {signedUsd(altCost - c.costUsd)} ({(((altCost - c.costUsd) / c.costUsd) * 100).toFixed(0)}%)
                    </td>
                  </>
                ) : (
                  <>
                    <td className="pr-4 opacity-40">—</td>
                    <td className="opacity-40">—</td>
                  </>
                )}
              </tr>
              );
            })}
          </tbody>
        </table>
        {data && data.calls.length === 0 && <p className="text-sm opacity-60">No LLM calls recorded yet.</p>}
      </section>
    </div>
  );
}

function PriceRow({ price, onChanged }: { price: LlmModelPrice; onChanged: () => void }) {
  const [vals, setVals] = useState({
    inputPer1M: String(price.inputPer1M),
    cachedInputPer1M: String(price.cachedInputPer1M),
    outputPer1M: String(price.outputPer1M),
  });
  const dirty = PRICE_KEYS.some((k) => Number(vals[k]) !== price[k]);

  async function save() {
    await api.upsertLlmPrice(price.model, {
      inputPer1M: Number(vals.inputPer1M) || 0,
      cachedInputPer1M: Number(vals.cachedInputPer1M) || 0,
      outputPer1M: Number(vals.outputPer1M) || 0,
    });
    onChanged();
  }

  async function remove() {
    await api.deleteLlmPrice(price.model);
    onChanged();
  }

  return (
    <tr>
      <td className="py-1 pr-2">{price.model}</td>
      {PRICE_KEYS.map((k) => (
        <td key={k} className="pr-2">
          <input
            type="number"
            min="0"
            step="0.01"
            className="border rounded px-2 py-1 w-24 bg-transparent"
            value={vals[k]}
            onChange={(e) => setVals({ ...vals, [k]: e.target.value })}
          />
        </td>
      ))}
      <td className="flex gap-2">
        <button className="px-3 py-1 rounded border disabled:opacity-40" disabled={!dirty} onClick={save}>
          Save
        </button>
        <button className="px-3 py-1 rounded border" onClick={remove}>
          Delete
        </button>
      </td>
    </tr>
  );
}
