'use client';

import { Fragment, useMemo, useState } from 'react';
import type { LlmCall, LlmModelPrice } from '@job-tracker/shared-types';

const usd = (v: number) => `$${v.toFixed(v < 0.01 && v > 0 ? 4 : 2)}`;
const signedUsd = (v: number) => `${v < 0 ? '-' : '+'}${usd(Math.abs(v))}`;

// What this call would have cost on another model, from its own token counts.
function costOn(c: LlmCall, p: LlmModelPrice): number {
  return (
    ((c.inputTokens - c.cachedTokens) * p.inputPer1M +
      c.cachedTokens * p.cachedInputPer1M +
      c.outputTokens * p.outputPer1M) /
    1_000_000
  );
}

// Calls with no runId (recorded before runs were tracked) are grouped by
// time gap instead: same agent, no more than this long between neighbours.
const LEGACY_GAP_MS = 3 * 60 * 1000;

interface Run {
  key: string;
  calls: LlmCall[]; // oldest first
}

function groupRuns(calls: LlmCall[]): Run[] {
  const oldestFirst = [...calls].reverse(); // API returns newest first
  const byId = new Map<string, Run>();
  const runs: Run[] = [];
  let legacy: Run | undefined;
  for (const c of oldestFirst) {
    if (c.runId) {
      let run = byId.get(c.runId);
      if (!run) {
        run = { key: c.runId, calls: [] };
        byId.set(c.runId, run);
        runs.push(run);
      }
      run.calls.push(c);
      continue;
    }
    const last = legacy?.calls[legacy.calls.length - 1];
    if (
      !legacy ||
      !last ||
      last.agent !== c.agent ||
      new Date(c.createdAt).getTime() - new Date(last.createdAt).getTime() > LEGACY_GAP_MS
    ) {
      legacy = { key: `legacy-${c.id}`, calls: [] };
      runs.push(legacy);
    }
    legacy.calls.push(c);
  }
  return runs.sort(
    (a, b) =>
      new Date(b.calls[b.calls.length - 1].createdAt).getTime() -
      new Date(a.calls[a.calls.length - 1].createdAt).getTime(),
  );
}

const sum = (calls: LlmCall[], f: (c: LlmCall) => number) => calls.reduce((s, c) => s + f(c), 0);

export function CallsSection({ calls, prices }: { calls: LlmCall[]; prices: LlmModelPrice[] }) {
  // Per-call what-if model. A run-level pick just sets it for every call in the run.
  const [altModel, setAltModel] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const runs = useMemo(() => groupRuns(calls), [calls]);
  const priceByModel = new Map(prices.map((p) => [p.model, p]));

  const altCostOf = (c: LlmCall) => {
    const alt = priceByModel.get(altModel[c.id]);
    return alt ? costOn(c, alt) : undefined;
  };
  const impactOf = (cs: LlmCall[]) =>
    cs.reduce((s, c) => {
      const alt = altCostOf(c);
      return alt === undefined ? s : s + alt - c.costUsd;
    }, 0);
  const anyAlt = calls.some((c) => altCostOf(c) !== undefined);

  function pickForRun(run: Run, model: string) {
    const next = { ...altModel };
    for (const c of run.calls) next[c.id] = model;
    setAltModel(next);
  }

  function toggle(key: string) {
    const next = new Set(open);
    if (!next.delete(key)) next.add(key);
    setOpen(next);
  }

  const picker = (value: string, exclude: string | null, onChange: (m: string) => void) => (
    <select
      className="border rounded px-2 py-1 bg-transparent"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">—</option>
      {prices
        .filter((p) => p.model !== exclude)
        .map((p) => (
          <option key={p.model} value={p.model}>
            {p.model}
          </option>
        ))}
    </select>
  );

  const impactCells = (actual: number, alt: number | undefined) =>
    alt === undefined ? (
      <>
        <td className="pr-4 opacity-40">—</td>
        <td className="opacity-40">—</td>
      </>
    ) : (
      <>
        <td className="pr-4">{usd(alt)}</td>
        <td className={alt <= actual ? 'text-green-600' : 'text-red-600'}>
          {signedUsd(alt - actual)} ({actual > 0 ? (((alt - actual) / actual) * 100).toFixed(0) : '0'}%)
        </td>
      </>
    );

  return (
    <section className="border rounded p-4 flex flex-col gap-2 overflow-x-auto">
      <h2 className="text-sm font-medium">
        Runs
        {anyAlt && (
          <span className="ml-3 font-normal opacity-70">
            What-if total impact of the selected models: {signedUsd(impactOf(calls))}
          </span>
        )}
      </h2>
      <p className="text-xs opacity-60">
        Each row is one agent run; click it to see its individual LLM calls. Pick another model on a run (or on a
        single call) to see what it would have cost with it — same token counts; nothing is actually switched.
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
          {runs.map((run) => {
            const isOpen = open.has(run.key);
            const first = run.calls[0];
            const last = run.calls[run.calls.length - 1];
            const total = sum(run.calls, (c) => c.costUsd);
            const picks = new Set(run.calls.map((c) => altModel[c.id] ?? ''));
            const runPick = picks.size === 1 ? Array.from(picks)[0] : '';
            const anyPicked = run.calls.some((c) => altCostOf(c) !== undefined);
            const altTotal = sum(run.calls, (c) => altCostOf(c) ?? c.costUsd);
            const models = Array.from(new Set(run.calls.map((c) => c.model)));
            return (
              <Fragment key={run.key}>
              <tr className="font-medium bg-black/5 dark:bg-white/5 cursor-pointer" onClick={() => toggle(run.key)}>
                <td className="py-1 pr-4">
                  {isOpen ? '▾' : '▸'} {new Date(last.createdAt).toLocaleString()}
                  <span className="ml-2 font-normal opacity-60">
                    ({run.calls.length} call{run.calls.length === 1 ? '' : 's'})
                  </span>
                </td>
                <td className="pr-4">{first.agent}</td>
                <td className="pr-4">{models.join(', ')}</td>
                <td className="pr-4">{sum(run.calls, (c) => c.inputTokens).toLocaleString()}</td>
                <td className="pr-4">{sum(run.calls, (c) => c.cachedTokens).toLocaleString()}</td>
                <td className="pr-4">{sum(run.calls, (c) => c.outputTokens).toLocaleString()}</td>
                <td className="pr-4">{usd(sum(run.calls, (c) => c.inputCostUsd))}</td>
                <td className="pr-4">{usd(sum(run.calls, (c) => c.outputCostUsd))}</td>
                <td className="pr-4">{usd(total)}</td>
                <td className="pr-4" onClick={(e) => e.stopPropagation()}>
                  {picker(runPick, models.length === 1 ? models[0] : null, (m) => pickForRun(run, m))}
                </td>
                {impactCells(total, anyPicked ? altTotal : undefined)}
              </tr>
              {isOpen
                && run.calls.map((c) => {
                    const alt = altCostOf(c);
                    return (
                      <tr key={c.id} className="opacity-90">
                        <td className="py-1 pr-4 pl-6">{new Date(c.createdAt).toLocaleTimeString()}</td>
                        <td className="pr-4">{c.agent}</td>
                        <td className="pr-4">{c.model}</td>
                        <td className="pr-4">{c.inputTokens.toLocaleString()}</td>
                        <td className="pr-4">{c.cachedTokens.toLocaleString()}</td>
                        <td className="pr-4">{c.outputTokens.toLocaleString()}</td>
                        <td className="pr-4">{usd(c.inputCostUsd)}</td>
                        <td className="pr-4">{usd(c.outputCostUsd)}</td>
                        <td className="pr-4">{usd(c.costUsd)}</td>
                        <td className="pr-4">
                          {picker(altModel[c.id] ?? '', c.model, (m) => setAltModel({ ...altModel, [c.id]: m }))}
                        </td>
                        {impactCells(c.costUsd, alt)}
                      </tr>
                    );
                  })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {calls.length === 0 && <p className="text-sm opacity-60">No LLM calls recorded yet.</p>}
    </section>
  );
}
