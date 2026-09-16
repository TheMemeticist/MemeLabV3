import type { LongStats, SimStats } from '../types';

export interface OutbreakPhase {
  kind: 'starting' | 'incubating' | 'growing' | 'declining' | 'steady' | 'inactive';
  label: string;
  detail: string;
}

/** Describes observed E+I counts, not a forecast or an R_eff inference.
 * Seven days is a display lookback, not an estimated generation interval. */
export function outbreakPhase(stats: Pick<SimStats, 'tick' | 'e' | 'i'>, history: Pick<LongStats, 'tick' | 'e' | 'i'>): OutbreakPhase {
  // Init/reset frames contain placeholder census zeros until the first tick.
  if (history.tick.length === 0) return { kind: 'starting', label: 'Ready to run', detail: 'No recorded days yet' };
  if (stats.e + stats.i === 0) return { kind: 'inactive', label: 'No active cases', detail: 'No exposed or infectious cells now' };
  if (stats.i === 0) return { kind: 'incubating', label: 'Incubating', detail: 'Exposed cells remain; none infectious now' };
  const from = history.tick.findIndex((t) => t >= stats.tick - 7);
  const days = from < 0 ? 0 : stats.tick - history.tick[from];
  if (days < 3) return { kind: 'starting', label: 'Watching trend', detail: 'Waiting for 3 recorded days' };
  const change = stats.e + stats.i - history.e[from] - history.i[from];
  const span = `over ${days} days · E + I`;
  if (change > 0) return { kind: 'growing', label: 'Growing', detail: `Up ${change.toLocaleString()} ${span}` };
  if (change < 0) return { kind: 'declining', label: 'Declining', detail: `Down ${(-change).toLocaleString()} ${span}` };
  return { kind: 'steady', label: 'Level overall', detail: `Net change 0 ${span}` };
}

export interface ObservedPeak {
  tick: number;
  infectious: number;
  deaths: number;
}

/** Ingest every worker row before rendering is coalesced. Keep the first
 * tied maximum, including after it ages out of the chart's sliding window.
 * Reset explicitly on a new run (a day-zero frame may never be painted). */
export class OutbreakPeak {
  value: ObservedPeak | null = null;
  private lastTick = -1;

  record(history: Pick<LongStats, 'tick' | 'i' | 'dcum'>, reset = false): void {
    const last = history.tick.at(-1);
    if (reset || (last !== undefined && last < this.lastTick)) {
      this.value = null;
      this.lastTick = -1;
    }
    for (let idx = 0; idx < history.tick.length; idx++) {
      const tick = history.tick[idx];
      if (tick <= this.lastTick) continue;
      if (history.i[idx] > (this.value?.infectious ?? 0)) {
        this.value = { tick, infectious: history.i[idx], deaths: history.dcum[idx] };
      }
      this.lastTick = tick;
    }
  }
}
