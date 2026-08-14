import { DefenseFlag } from '../types';
import type { DefenseSpec } from '../types';

export interface ResolvedDefenses {
  flags: number; // bitmask of DefenseFlag values present in this run
  /** Per-flag derived multipliers, indexed by bit position (0..7). */
  protection: Float64Array;
  sourceControl: Float64Array;
  mortalityReduction: Float64Array;
  uptake: Float64Array;
  /** Combined multipliers indexed directly by a cell's defense bitmask
   *  (products over set flags, in FLAG_ORDER). These are the hot-loop path:
   *  `protByMask[defenses[j] & MASK_ALL]` replaces a per-neighbor flag walk. */
  protByMask: Float64Array;
  srcByMask: Float64Array;
  mortByMask: Float64Array;
}

/** Index bound for the by-mask tables: all defense flags OR'd together. */
export const MASK_ALL = FLAG_ORDER_MASK();
function FLAG_ORDER_MASK(): number {
  return DefenseFlag.Mask | DefenseFlag.Vaccine;
}

const FLAG_ORDER: DefenseFlag[] = [DefenseFlag.Mask, DefenseFlag.Vaccine];
const FLAG_KEYS: Record<string, DefenseFlag> = { mask: DefenseFlag.Mask, vaccine: DefenseFlag.Vaccine };

export function resolveDefenses(specs: DefenseSpec[]): ResolvedDefenses {
  const protection = new Float64Array(8);
  const sourceControl = new Float64Array(8);
  const mortalityReduction = new Float64Array(8);
  const uptake = new Float64Array(8);
  protection.fill(1); // identity multiplier when defense absent
  sourceControl.fill(1);
  mortalityReduction.fill(1);

  let flags = 0;
  for (const spec of specs) {
    const flag = FLAG_KEYS[spec.id] ?? 0;
    if (!flag) continue;
    flags |= flag;
    const idx = bitIndex(flag);
    // Disabled defense: leave multipliers at identity (1) so flagged cells
    // experience no effect. Uptake also clamped to 0 so birth re-rolls don't
    // grant new flags while off.
    if (spec.enabled === false) {
      uptake[idx] = 0;
      continue;
    }
    protection[idx] = 1 - clamp01(spec.protection);
    sourceControl[idx] = 1 - clamp01(spec.sourceControl);
    mortalityReduction[idx] = 1 - clamp01(spec.mortalityReduction);
    uptake[idx] = clamp01(spec.uptake);
  }

  // Precompute the per-bitmask products once per resolve. Same factor order as
  // the old per-flag walk (FLAG_ORDER), so results are bit-identical doubles.
  const protByMask = new Float64Array(MASK_ALL + 1);
  const srcByMask = new Float64Array(MASK_ALL + 1);
  const mortByMask = new Float64Array(MASK_ALL + 1);
  for (let mask = 0; mask <= MASK_ALL; mask++) {
    let p = 1, s = 1, m = 1;
    for (const f of FLAG_ORDER) {
      if (mask & f) {
        const idx = bitIndex(f);
        p *= protection[idx];
        s *= sourceControl[idx];
        m *= mortalityReduction[idx];
      }
    }
    protByMask[mask] = p;
    srcByMask[mask] = s;
    mortByMask[mask] = m;
  }

  return { flags, protection, sourceControl, mortalityReduction, uptake, protByMask, srcByMask, mortByMask };
}

/** Multiplier on attack success against a wearer with the given defense bitmask. */
export function protectionMultiplier(d: ResolvedDefenses, wearerFlags: number): number {
  return d.protByMask[wearerFlags & MASK_ALL];
}

/** Multiplier on attack success outgoing from a wearer with the given defense bitmask. */
export function sourceControlMultiplier(d: ResolvedDefenses, wearerFlags: number): number {
  return d.srcByMask[wearerFlags & MASK_ALL];
}

/** Multiplier on IFR for a wearer. */
export function mortalityMultiplier(d: ResolvedDefenses, wearerFlags: number): number {
  return d.mortByMask[wearerFlags & MASK_ALL];
}

function bitIndex(flag: number): number {
  return Math.log2(flag) | 0;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
