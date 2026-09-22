import snapshots from '../../public/datasets/outbreak-validation.json';
import type { ObservedPoint } from './fit';

/** Sourced first-eight-week snapshots; later observations are deliberately withheld.
 * Population is a documented training-only effective-pool heuristic, not census. */
export const OUTBREAK_DATASETS = snapshots.map((entry) => ({
  ...entry,
  points: entry.points.map((p): ObservedPoint => ({ ...p, category: 'cumulative_infections' })),
}));
