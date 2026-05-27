import type { VoronoiConfig, VoronoiTopology } from '../types';
import type { Rng } from './rng';
import { triangulate, circumcenter, type DTPoint, type DTTriangle } from './delaunay';

const DEFAULT_MODE = 'jittered';
const DEFAULT_IRREGULARITY = 0.5;
// Toroidal edge: skip edges whose wrapped distance² exceeds this threshold.
const MAX_TORUS_DIST2 = 0.36; // 0.6²

export function buildVoronoi(
  n: number,
  cfg: VoronoiConfig | undefined,
  rng: Rng,
  withPolygons: boolean,
): VoronoiTopology {
  const mode = cfg?.mode ?? DEFAULT_MODE;
  const irregularity = Math.max(0, Math.min(1, cfg?.irregularity ?? DEFAULT_IRREGULARITY));

  // Step 1: Generate n seed points in [0,1]².
  let pts = generatePoints(n, mode, irregularity, rng);

  // Step 2: Mirror the n points 8 times for toroidal topology.
  // Original points occupy indices [0..n); mirror k occupies [(k+1)*n..(k+2)*n).
  const OFFSETS: [number, number][] = [
    [-1, -1], [0, -1], [1, -1],
    [-1,  0],          [1,  0],
    [-1,  1], [0,  1], [1,  1],
  ];
  const mirrored: DTPoint[] = [];
  for (const p of pts) mirrored.push(p);
  for (const [dx, dy] of OFFSETS) {
    for (const p of pts) mirrored.push({ x: p.x + dx, y: p.y + dy });
  }

  // Step 3: Delaunay triangulation on 9n points.
  const tris = triangulate(mirrored);

  // Step 4: Extract adjacency list (CSR) from toroidal edge set. Settlements
  // additionally encode local density into the contact graph (cities → hubs).
  const { adjOffsets, adjList } = mode === 'settlements'
    ? buildSettlementAdjacency(n, pts, tris)
    : buildAdjacency(n, pts, tris);

  // Step 5: (Optional) Voronoi polygon vertices from circumcenters.
  let polyOffsets: Int32Array | null = null;
  let polyVerts: Float32Array | null = null;
  if (withPolygons) {
    ({ polyOffsets, polyVerts } = buildPolygons(n, pts, tris, mirrored));
  }

  const cx = new Float32Array(n);
  const cy = new Float32Array(n);
  for (let i = 0; i < n; i++) { cx[i] = pts[i].x; cy[i] = pts[i].y; }

  return { n, cx, cy, adjOffsets, adjList, polyOffsets, polyVerts };
}

// ─── Point generation ─────────────────────────────────────────────────────────

function generatePoints(n: number, mode: string, irregularity: number, rng: Rng): DTPoint[] {
  if (mode === 'uniform') return uniformPoints(n, rng);
  if (mode === 'relaxed') return relaxedPoints(n, irregularity, rng);
  if (mode === 'settlements') return settlementPoints(n, irregularity, rng);
  return jitteredPoints(n, irregularity, rng); // 'jittered' default
}

// Wrap a coordinate into [0,1) on the torus.
function wrap01(v: number): number {
  const w = v - Math.floor(v);
  return w >= 1 ? 0 : w;
}

// Settlement layout: a realistic urban/rural mix. A handful of dense cities
// (Gaussian blobs, Zipf-distributed sizes — a few big cities, many small towns)
// sit in a sparse rural background (evenly-spread jittered grid). `urbanization`
// (the repurposed Irregularity knob, 0..1) shifts the balance: low → many small
// evenly-spread towns; high → a few dense megacities with empty countryside.
// Combined with density-aware adjacency, this produces city hotspots and rural
// fade-outs that uniform lattices cannot represent.
function settlementPoints(n: number, urbanization: number, rng: Rng): DTPoint[] {
  // Fewer, denser cities as urbanization rises; more, smaller towns when low.
  const numCities = Math.max(2, Math.round(Math.sqrt(n) * (0.10 + 0.40 * (1 - urbanization))));
  // Urban share of the population grows with urbanization (40% → ~92%).
  const urbanCount = Math.min(n, Math.round(n * (0.40 + 0.52 * urbanization)));
  const ruralCount = n - urbanCount;

  // City centres: rejection-sampled to stay well separated (Poisson-disk-ish).
  const minSep = 0.7 / Math.sqrt(numCities);
  const minSep2 = minSep * minSep;
  const centers: DTPoint[] = [];
  for (let attempt = 0; centers.length < numCities && attempt < numCities * 40; attempt++) {
    const c = { x: rng.random(), y: rng.random() };
    let ok = true;
    for (const o of centers) {
      if (torusDist2(c.x, c.y, o.x, o.y) < minSep2) { ok = false; break; }
    }
    if (ok) centers.push(c);
  }
  while (centers.length < numCities) centers.push({ x: rng.random(), y: rng.random() });

  // Zipf city sizes: weight ∝ 1/rank → a few big cities, a long tail of towns.
  const weights: number[] = [];
  let wsum = 0;
  for (let i = 0; i < numCities; i++) { const w = 1 / (i + 1); weights.push(w); wsum += w; }

  const pts: DTPoint[] = [];
  for (let i = 0; i < numCities && pts.length < urbanCount; i++) {
    const share = weights[i] / wsum;
    const target = i === numCities - 1 ? urbanCount : Math.min(urbanCount, pts.length + Math.round(urbanCount * share));
    // Bigger cities spread a little more; higher urbanization packs them tighter.
    const sigma = (0.035 + 0.11 * Math.sqrt(share)) * (1.1 - 0.5 * urbanization);
    while (pts.length < target) {
      pts.push({
        x: wrap01(centers[i].x + sigma * rng.gaussian()),
        y: wrap01(centers[i].y + sigma * rng.gaussian()),
      });
    }
  }
  while (pts.length < urbanCount) {
    pts.push({ x: wrap01(centers[0].x + 0.05 * rng.gaussian()), y: wrap01(centers[0].y + 0.05 * rng.gaussian()) });
  }

  // Rural background: sparse, evenly-spread points on a jittered coarse grid.
  if (ruralCount > 0) {
    const rcols = Math.max(1, Math.round(Math.sqrt(ruralCount)));
    const rrows = Math.max(1, Math.ceil(ruralCount / rcols));
    const cw = 1 / rcols, ch = 1 / rrows;
    let placed = 0;
    for (let r = 0; r < rrows && placed < ruralCount; r++) {
      for (let c = 0; c < rcols && placed < ruralCount; c++) {
        pts.push({
          x: wrap01((c + 0.5 + (rng.random() - 0.5) * 0.8) * cw),
          y: wrap01((r + 0.5 + (rng.random() - 0.5) * 0.8) * ch),
        });
        placed++;
      }
    }
  }

  return pts;
}

function uniformPoints(n: number, rng: Rng): DTPoint[] {
  const pts: DTPoint[] = [];
  for (let i = 0; i < n; i++) pts.push({ x: rng.random(), y: rng.random() });
  return pts;
}

function jitteredPoints(n: number, irregularity: number, rng: Rng): DTPoint[] {
  // Hexagonal grid layout, then apply Gaussian jitter proportional to irregularity.
  const cols = Math.ceil(Math.sqrt(n * 1.155));
  const rows = Math.ceil(n / cols);
  const colSpacing = 1 / cols;
  const rowSpacing = 1 / rows;
  const cellRadius = Math.min(colSpacing, rowSpacing) * 0.5;
  const sigma = irregularity * 0.7 * cellRadius;

  const pts: DTPoint[] = [];
  for (let row = 0; row < rows && pts.length < n; row++) {
    for (let col = 0; col < cols && pts.length < n; col++) {
      const baseX = (col + (row & 1) * 0.5) * colSpacing + colSpacing * 0.5;
      const baseY = row * rowSpacing + rowSpacing * 0.5;
      const x = Math.max(0.001, Math.min(0.999, baseX + sigma * rng.gaussian()));
      const y = Math.max(0.001, Math.min(0.999, baseY + sigma * rng.gaussian()));
      pts.push({ x, y });
    }
  }
  return pts;
}

function relaxedPoints(n: number, irregularity: number, rng: Rng): DTPoint[] {
  let pts = uniformPoints(n, rng);
  const iters = Math.max(1, Math.round(15 * (1 - irregularity)));
  for (let it = 0; it < iters; it++) {
    pts = lloydStep(pts);
  }
  return pts;
}

function lloydStep(pts: DTPoint[]): DTPoint[] {
  const n = pts.length;
  const tris = triangulate(pts);

  // Collect circumcenters per point (Voronoi vertices for each cell).
  const ccBuckets: DTPoint[][] = Array.from({ length: n }, () => []);
  for (const t of tris) {
    const cc = circumcenter(pts, t);
    // Clamp circumcenters to [0,1] so centroids don't wander out of bounds.
    const clamped: DTPoint = {
      x: Math.max(0, Math.min(1, cc.x)),
      y: Math.max(0, Math.min(1, cc.y)),
    };
    ccBuckets[t.a].push(clamped);
    ccBuckets[t.b].push(clamped);
    ccBuckets[t.c].push(clamped);
  }

  // Replace each point with the centroid of its Voronoi polygon vertices.
  return pts.map((p, i) => {
    const verts = ccBuckets[i];
    if (verts.length === 0) return p;
    let sumX = 0, sumY = 0;
    for (const v of verts) { sumX += v.x; sumY += v.y; }
    return {
      x: Math.max(0.001, Math.min(0.999, sumX / verts.length)),
      y: Math.max(0.001, Math.min(0.999, sumY / verts.length)),
    };
  });
}

// ─── Adjacency extraction ─────────────────────────────────────────────────────

function torusDist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx), dy = Math.abs(ay - by);
  const wx = Math.min(dx, 1 - dx), wy = Math.min(dy, 1 - dy);
  return wx * wx + wy * wy;
}

function buildAdjacency(
  n: number,
  pts: DTPoint[],
  tris: DTTriangle[],
): { adjOffsets: Int32Array; adjList: Int32Array } {
  // Collect unique neighbor pairs for the original n cells.
  const sets: Set<number>[] = Array.from({ length: n }, () => new Set<number>());

  for (const t of tris) {
    const edges: [number, number][] = [[t.a, t.b], [t.b, t.c], [t.c, t.a]];
    for (const [u, v] of edges) {
      const ui = u % n, vi = v % n;
      if (ui === vi) continue; // same original cell (different mirror copies)
      // Both endpoints must map to valid original cells.
      // Check toroidal distance to filter spurious long mirror edges.
      const px = pts[ui].x, py = pts[ui].y;
      const qx = pts[vi].x, qy = pts[vi].y;
      if (torusDist2(px, py, qx, qy) > MAX_TORUS_DIST2) continue;
      sets[ui].add(vi);
      sets[vi].add(ui);
    }
  }

  // Pack into CSR.
  const adjOffsets = new Int32Array(n + 1);
  let total = 0;
  for (let i = 0; i < n; i++) { adjOffsets[i] = total; total += sets[i].size; }
  adjOffsets[n] = total;
  const adjList = new Int32Array(total);
  for (let i = 0; i < n; i++) {
    let k = adjOffsets[i];
    for (const nb of sets[i]) adjList[k++] = nb;
  }
  return { adjOffsets, adjList };
}

// Density-aware contact graph for the settlements layout. A pure Delaunay graph
// has ≈6 neighbours everywhere regardless of density, which cannot express the
// heterogeneity of real populations. Here we keep the Delaunay edges (they
// guarantee a connected graph and a rural baseline of ≈6 contacts) and then add
// extra edges to any other cell within a fixed transmission radius. In dense
// cities many cells fall inside that radius → high-degree hubs that amplify
// outbreaks; in sparse countryside few do → low-degree cells that fade out.
// Extra edges are added shortest-first and degree-capped so a single ultra-dense
// blob can't produce pathological degrees.
const SETTLE_RADIUS_C = 1.7; // radius = C / sqrt(n); ~π·C² baseline contacts
const SETTLE_MAX_DEGREE = 24;

function buildSettlementAdjacency(
  n: number,
  pts: DTPoint[],
  tris: DTTriangle[],
): { adjOffsets: Int32Array; adjList: Int32Array } {
  const base = buildAdjacency(n, pts, tris);
  const r = SETTLE_RADIUS_C / Math.sqrt(n);
  const r2 = r * r;

  const adj: number[][] = Array.from({ length: n }, () => []);
  const deg = new Int32Array(n);
  const seen = new Set<number>();
  const edgeKey = (a: number, b: number): number => (a < b ? a * n + b : b * n + a);

  // 1. Delaunay edges (connectivity + rural baseline degree).
  for (let i = 0; i < n; i++) {
    for (let k = base.adjOffsets[i]; k < base.adjOffsets[i + 1]; k++) {
      const j = base.adjList[k];
      if (i < j) {
        const key = edgeKey(i, j);
        if (!seen.has(key)) { seen.add(key); adj[i].push(j); adj[j].push(i); deg[i]++; deg[j]++; }
      }
    }
  }

  // 2. Toroidal spatial grid (cell ≥ r so the 3×3 window covers the radius).
  const gK = Math.max(1, Math.floor(1 / r));
  const cellOf = (v: number): number => {
    let c = (v * gK) | 0; if (c >= gK) c = gK - 1; else if (c < 0) c = 0; return c;
  };
  const startIdx = new Int32Array(gK * gK + 1);
  const cellId = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const b = cellOf(pts[i].y) * gK + cellOf(pts[i].x);
    cellId[i] = b; startIdx[b + 1]++;
  }
  for (let b = 0; b < gK * gK; b++) startIdx[b + 1] += startIdx[b];
  const order = new Int32Array(n);
  const cursor = Int32Array.from(startIdx.subarray(0, gK * gK));
  for (let i = 0; i < n; i++) order[cursor[cellId[i]]++] = i;

  // 3. Collect radius-only candidate edges (parallel arrays, no per-edge object).
  const ci: number[] = [], cj: number[] = [], cd: number[] = [];
  for (let i = 0; i < n; i++) {
    const bx = cellOf(pts[i].x), by = cellOf(pts[i].y);
    for (let dy = -1; dy <= 1; dy++) {
      let gy = by + dy; if (gy < 0) gy += gK; else if (gy >= gK) gy -= gK;
      const rowBase = gy * gK;
      for (let dx = -1; dx <= 1; dx++) {
        let gx = bx + dx; if (gx < 0) gx += gK; else if (gx >= gK) gx -= gK;
        const b = rowBase + gx;
        const e = startIdx[b + 1];
        for (let k = startIdx[b]; k < e; k++) {
          const j = order[k];
          if (j <= i) continue;
          const d2 = torusDist2(pts[i].x, pts[i].y, pts[j].x, pts[j].y);
          if (d2 > r2) continue;
          if (seen.has(edgeKey(i, j))) continue;
          ci.push(i); cj.push(j); cd.push(d2);
        }
      }
    }
  }

  // 4. Add candidates shortest-first, respecting the per-cell degree cap.
  const idx = Array.from({ length: ci.length }, (_, k) => k);
  idx.sort((a, b) => cd[a] - cd[b]);
  for (const t of idx) {
    const i = ci[t], j = cj[t];
    if (deg[i] >= SETTLE_MAX_DEGREE || deg[j] >= SETTLE_MAX_DEGREE) continue;
    const key = edgeKey(i, j);
    if (seen.has(key)) continue;
    seen.add(key); adj[i].push(j); adj[j].push(i); deg[i]++; deg[j]++;
  }

  // 5. Pack into CSR.
  const adjOffsets = new Int32Array(n + 1);
  let total = 0;
  for (let i = 0; i < n; i++) { adjOffsets[i] = total; total += adj[i].length; }
  adjOffsets[n] = total;
  const adjList = new Int32Array(total);
  for (let i = 0; i < n; i++) {
    let k = adjOffsets[i];
    for (const j of adj[i]) adjList[k++] = j;
  }
  return { adjOffsets, adjList };
}

// ─── Voronoi polygon computation ──────────────────────────────────────────────

function buildPolygons(
  n: number,
  pts: DTPoint[],
  tris: DTTriangle[],
  mirrored: DTPoint[],
): { polyOffsets: Int32Array; polyVerts: Float32Array } {
  // For each original cell, collect circumcenters of incident triangles.
  // A triangle is "incident" to original cell i if any of its vertices maps to i.
  const ccBuckets: { x: number; y: number }[][] = Array.from({ length: n }, () => []);

  for (const t of tris) {
    const cc = circumcenter(mirrored, t);
    // Only include circumcenters that are reasonably close to [0,1] space.
    if (cc.x < -0.5 || cc.x > 1.5 || cc.y < -0.5 || cc.y > 1.5) continue;
    const { a, b, c } = t;
    const ia = a % n, ib = b % n, ic = c % n;
    for (const i of new Set([ia, ib, ic])) {
      ccBuckets[i].push(cc);
    }
  }

  // Sort each cell's polygon vertices by angle around the centroid, then pack.
  const allVerts: number[] = [];
  const polyOffsets = new Int32Array(n + 1);
  let offset = 0;

  for (let i = 0; i < n; i++) {
    polyOffsets[i] = offset;
    const raw = ccBuckets[i];
    if (raw.length === 0) { continue; }

    const cx = pts[i].x, cy = pts[i].y;
    // Deduplicate by rounding to 6 decimal places.
    const seen = new Set<string>();
    const unique: DTPoint[] = [];
    for (const v of raw) {
      const key = `${v.x.toFixed(6)},${v.y.toFixed(6)}`;
      if (!seen.has(key)) { seen.add(key); unique.push(v); }
    }

    // Sort by angle around centroid.
    unique.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));

    // Clamp to [-0.1, 1.1] for rendering (allow slight overflow at edges).
    for (const v of unique) {
      allVerts.push(Math.max(-0.1, Math.min(1.1, v.x)));
      allVerts.push(Math.max(-0.1, Math.min(1.1, v.y)));
    }
    offset += unique.length;
  }
  polyOffsets[n] = offset;

  return { polyOffsets, polyVerts: new Float32Array(allVerts) };
}
