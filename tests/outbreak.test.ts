import { describe, expect, it } from 'vitest';
import { outbreakPhase, OutbreakPeak } from '../src/lib/outbreak';

function history(active: number[], firstDay = 0) {
  return { tick: active.map((_, i) => firstDay + i), e: active.map(() => 0), i: active };
}

describe('observed outbreak phase', () => {
  it('treats empty init/reset history as unrecorded, not an extinct seeded outbreak', () => {
    expect(outbreakPhase({ tick: 0, e: 0, i: 0 }, history([]))).toEqual({ kind: 'starting', label: 'Ready to run', detail: 'No recorded days yet' });
  });

  it('does not confuse missing or high R_eff with the observed active-count trend', () => {
    const h = history([10, 7, 5, 1]);
    const latest = { tick: 3, e: 0, i: 1, reff: 0 };
    expect(outbreakPhase(latest, h).kind).toBe('declining');
    latest.reff = 99;
    expect(outbreakPhase(latest, h).kind).toBe('declining');
  });

  it('keeps exposed-only incubation active even with no infectious cells', () => {
    expect(outbreakPhase({ tick: 20, e: 10, i: 0 }, history([0])).kind).toBe('incubating');
    expect(outbreakPhase({ tick: 20, e: 0, i: 0 }, history([10])).kind).toBe('inactive');
  });

  it('waits for a daily trend after reset, regardless of prior R_eff', () => {
    expect(outbreakPhase({ tick: 0, e: 0, i: 10 }, history([10])).kind).toBe('starting');
    expect(outbreakPhase({ tick: 2, e: 0, i: 30 }, history([10, 20, 30])).kind).toBe('starting');
  });

  it('uses exposed plus infectious changes, including when infectious alone falls', () => {
    const h = { tick: [0, 1, 2, 3], e: [0, 5, 10, 20], i: [10, 9, 8, 7] };
    expect(outbreakPhase({ tick: 3, e: 20, i: 7 }, h)).toEqual({ kind: 'growing', label: 'Growing', detail: 'Up 17 over 3 days · E + I' });
  });

  it('describes decline without claiming the outbreak is contained or over', () => {
    expect(outbreakPhase({ tick: 3, e: 0, i: 1 }, history([10, 7, 5, 1])).kind).toBe('declining');
    expect(outbreakPhase({ tick: 3, e: 0, i: 10 }, history([10, 20, 5, 10])).kind).toBe('steady');
  });

  it('recognizes a later growing wave using only the last seven days', () => {
    const h = history([100, 90, 70, 50, 20, 3, 2, 1, 1, 2, 3, 10, 20]);
    expect(outbreakPhase({ tick: 12, e: 0, i: 20 }, h)).toMatchObject({ kind: 'growing', detail: 'Up 17 over 7 days · E + I' });
  });
});

describe('observed infectious peak', () => {
  it('captures intermediate unpainted rows and uses cumulative deaths, with first ties stable', () => {
    const peak = new OutbreakPeak();
    peak.record({ tick: [0, 1, 2, 3], i: [2, 12, 12, 3], dcum: [0, 7, 8, 9] });
    expect(peak.value).toEqual({ tick: 1, infectious: 12, deaths: 7 });
  });

  it('retains an aged-out peak across overlapping history snapshots and smaller waves', () => {
    const peak = new OutbreakPeak();
    peak.record({ tick: [0, 1], i: [1, 100], dcum: [0, 2] });
    peak.record({ tick: [1, 2], i: [100, 30], dcum: [2, 5] });
    peak.record({ tick: [5000, 5001], i: [20, 40], dcum: [80, 90] });
    expect(peak.value).toEqual({ tick: 1, infectious: 100, deaths: 2 });
    peak.record({ tick: [5002], i: [101], dcum: [91] });
    expect(peak.value).toEqual({ tick: 5002, infectious: 101, deaths: 91 });
  });

  it('clears on reset even when no reset frame gets painted, and records a new run', () => {
    const peak = new OutbreakPeak();
    peak.record({ tick: [0, 100], i: [2, 200], dcum: [0, 30] });
    peak.record({ tick: [0], i: [0], dcum: [0] }, true);
    expect(peak.value).toBeNull();
    peak.record({ tick: [1], i: [3], dcum: [0] });
    expect(peak.value).toEqual({ tick: 1, infectious: 3, deaths: 0 });
  });

  it('accepts a changed day-zero seed and rewind without a phantom zero-case peak', () => {
    const peak = new OutbreakPeak();
    peak.record({ tick: [0], i: [4], dcum: [0] });
    peak.record({ tick: [0], i: [8], dcum: [0] }, true);
    expect(peak.value?.infectious).toBe(8);
    peak.record({ tick: [100], i: [20], dcum: [2] });
    peak.record({ tick: [0], i: [0], dcum: [0] });
    expect(peak.value).toBeNull();
  });
});
