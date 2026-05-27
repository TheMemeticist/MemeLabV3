// Pure-TS incremental (Bowyer-Watson) Delaunay triangulation.
//
// The mesh is stored in flat typed arrays with explicit triangle adjacency, and
// each point is located by *walking* the mesh from the previously inserted
// triangle. For spatially-coherent input this makes insertion O(1) amortized,
// so the whole triangulation runs in ~O(n log n) instead of the O(n²) of a
// naive "scan every triangle per point" implementation. That keeps Voronoi
// topology generation fast enough for large grids (tens of thousands of cells).

export interface DTPoint { x: number; y: number; }
export interface DTTriangle { a: number; b: number; c: number; }

// Super-triangle reach as a multiple of the input bounding-box span.
const SUPER_SCALE = 1000;

function i32grow(a: Int32Array<ArrayBuffer>, cap: number): Int32Array<ArrayBuffer> { const b = new Int32Array(cap); b.set(a); return b; }
function u8grow(a: Uint8Array<ArrayBuffer>, cap: number): Uint8Array<ArrayBuffer> { const b = new Uint8Array(cap); b.set(a); return b; }
function f64grow(a: Float64Array<ArrayBuffer>, cap: number): Float64Array<ArrayBuffer> { const b = new Float64Array(cap); b.set(a); return b; }

/** Returns Delaunay triangles for the given points (indices into pts[]). */
export function triangulate(pts: DTPoint[]): DTTriangle[] {
  const n = pts.length;
  if (n < 3) return [];

  // Vertex coordinates: n input points + 3 super-triangle corners, flattened.
  // Deterministic sub-pixel jitter breaks exact collinearity/cocircularity.
  const V = n + 3;
  const X = new Float64Array(V);
  const Y = new Float64Array(V);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = pts[i].x + 1e-9 * i;
    const y = pts[i].y + 1e-9 * (i * 1.618033988);
    X[i] = x; Y[i] = y;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-9);
  const mx = (minX + maxX) * 0.5, my = (minY + maxY) * 0.5;
  const SA = n, SB = n + 1, SC = n + 2;
  X[SA] = mx - SUPER_SCALE * span; Y[SA] = my - SUPER_SCALE * span;
  X[SB] = mx + SUPER_SCALE * span; Y[SB] = my - SUPER_SCALE * span;
  X[SC] = mx;                      Y[SC] = my + SUPER_SCALE * span;

  // Triangle mesh in flat arrays (grown on demand). Vertices are stored CCW.
  // Neighbor opposite each vertex: NA across edge (B,C), NB across (C,A),
  // NC across (A,B). -1 means no neighbor.
  let cap = 2 * V + 16;
  let TA = new Int32Array(cap), TB = new Int32Array(cap), TC = new Int32Array(cap);
  let NA = new Int32Array(cap), NB = new Int32Array(cap), NC = new Int32Array(cap);
  let DEAD = new Uint8Array(cap);
  let CCX = new Float64Array(cap), CCY = new Float64Array(cap), CCR = new Float64Array(cap);
  let nt = 0;

  const grow = (): void => {
    cap *= 2;
    TA = i32grow(TA, cap); TB = i32grow(TB, cap); TC = i32grow(TC, cap);
    NA = i32grow(NA, cap); NB = i32grow(NB, cap); NC = i32grow(NC, cap);
    DEAD = u8grow(DEAD, cap);
    CCX = f64grow(CCX, cap); CCY = f64grow(CCY, cap); CCR = f64grow(CCR, cap);
  };

  // Create a triangle (a,b,c assumed CCW) and precompute its circumcircle.
  const newTri = (a: number, b: number, c: number): number => {
    if (nt >= cap) grow();
    const t = nt++;
    TA[t] = a; TB[t] = b; TC[t] = c;
    NA[t] = -1; NB[t] = -1; NC[t] = -1;
    DEAD[t] = 0;
    const ax = X[a], ay = Y[a], bx = X[b], by = Y[b], cx = X[c], cy = Y[c];
    const ex = bx - ax, ey = by - ay, fx = cx - ax, fy = cy - ay;
    const d = 2 * (ex * fy - ey * fx);
    if (d < 1e-20 && d > -1e-20) {
      CCX[t] = ax; CCY[t] = ay; CCR[t] = Infinity; // degenerate: never satisfied
    } else {
      const e2 = ex * ex + ey * ey, f2 = fx * fx + fy * fy;
      const ux = (fy * e2 - ey * f2) / d;
      const uy = (ex * f2 - fx * e2) / d;
      CCX[t] = ax + ux; CCY[t] = ay + uy; CCR[t] = ux * ux + uy * uy;
    }
    return t;
  };

  const setN = (t: number, code: number, val: number): void => {
    if (code === 0) NA[t] = val; else if (code === 1) NB[t] = val; else NC[t] = val;
  };
  // Repoint whichever neighbor slot of t currently references `from` to `to`.
  const patch = (t: number, from: number, to: number): void => {
    if (t < 0) return;
    if (NA[t] === from) NA[t] = to;
    else if (NB[t] === from) NB[t] = to;
    else if (NC[t] === from) NC[t] = to;
  };

  const inCirc = (t: number, px: number, py: number): boolean => {
    const dx = px - CCX[t], dy = py - CCY[t];
    return dx * dx + dy * dy < CCR[t];
  };
  const orient = (ax: number, ay: number, bx: number, by: number, px: number, py: number): number =>
    (bx - ax) * (py - ay) - (by - ay) * (px - ax);

  // The super-triangle (index 0) initially contains every input point.
  newTri(SA, SB, SC);

  let hint = 0;

  // Locate a triangle containing (px,py) via a remembered visibility walk.
  // Returns -1 if the walk stalls (caller falls back to a linear scan).
  const locate = (px: number, py: number): number => {
    let t = hint;
    if (DEAD[t]) { t = nt - 1; while (t > 0 && DEAD[t]) t--; }
    let prev = -1;
    let guard = nt + 8;
    while (guard-- > 0) {
      const a = TA[t], b = TB[t], c = TC[t];
      const ax = X[a], ay = Y[a], bx = X[b], by = Y[b], cx = X[c], cy = Y[c];
      const na = NA[t], nb = NB[t], nc = NC[t];
      if (na !== prev && na >= 0 && orient(bx, by, cx, cy, px, py) < 0) { prev = t; t = na; continue; }
      if (nb !== prev && nb >= 0 && orient(cx, cy, ax, ay, px, py) < 0) { prev = t; t = nb; continue; }
      if (nc !== prev && nc >= 0 && orient(ax, ay, bx, by, px, py) < 0) { prev = t; t = nc; continue; }
      return t;
    }
    return -1;
  };

  // Scratch buffers reused across insertions.
  const cavity: number[] = [];
  const beU: number[] = [], beV: number[] = [], beExt: number[] = [], beFrom: number[] = [];
  const pendingVert = new Map<number, number>();

  // Fan-link: edge (p, w) is shared by exactly two new triangles; link them.
  const linkFan = (w: number, tri: number, code: number): void => {
    const enc = pendingVert.get(w);
    if (enc === undefined) {
      pendingVert.set(w, tri * 4 + code);
    } else {
      const ot = (enc / 4) | 0, oc = enc & 3;
      setN(tri, code, ot);
      setN(ot, oc, tri);
      pendingVert.delete(w);
    }
  };

  for (let pi = 0; pi < n; pi++) {
    const px = X[pi], py = Y[pi];

    // Find one bad triangle (circumcircle contains p) to seed the cavity.
    let seed = locate(px, py);
    if (seed < 0 || DEAD[seed] || !inCirc(seed, px, py)) {
      seed = -1;
      for (let t = 0; t < nt; t++) {
        if (!DEAD[t] && inCirc(t, px, py)) { seed = t; break; }
      }
      if (seed < 0) continue; // numerically degenerate; skip (jitter makes this rare)
    }

    // Flood-fill the cavity: all triangles whose circumcircle contains p.
    cavity.length = 0;
    cavity.push(seed);
    DEAD[seed] = 1;
    for (let qi = 0; qi < cavity.length; qi++) {
      const t = cavity[qi];
      const na = NA[t], nb = NB[t], nc = NC[t];
      if (na >= 0 && !DEAD[na] && inCirc(na, px, py)) { DEAD[na] = 1; cavity.push(na); }
      if (nb >= 0 && !DEAD[nb] && inCirc(nb, px, py)) { DEAD[nb] = 1; cavity.push(nb); }
      if (nc >= 0 && !DEAD[nc] && inCirc(nc, px, py)) { DEAD[nc] = 1; cavity.push(nc); }
    }

    // Collect the cavity boundary (edges whose far side is outside the cavity).
    // Edge order is taken CCW so each new triangle (u,v,p) is also CCW.
    beU.length = 0; beV.length = 0; beExt.length = 0; beFrom.length = 0;
    for (let ci = 0; ci < cavity.length; ci++) {
      const t = cavity[ci];
      const a = TA[t], b = TB[t], c = TC[t];
      const na = NA[t], nb = NB[t], nc = NC[t];
      if (na < 0 || !DEAD[na]) { beU.push(b); beV.push(c); beExt.push(na); beFrom.push(t); }
      if (nb < 0 || !DEAD[nb]) { beU.push(c); beV.push(a); beExt.push(nb); beFrom.push(t); }
      if (nc < 0 || !DEAD[nc]) { beU.push(a); beV.push(b); beExt.push(nc); beFrom.push(t); }
    }

    // Retriangulate the cavity as a fan from p to each boundary edge.
    pendingVert.clear();
    for (let k = 0; k < beU.length; k++) {
      const u = beU[k], v = beV[k], ext = beExt[k], from = beFrom[k];
      const t = newTri(u, v, pi); // A=u, B=v, C=p
      NC[t] = ext;                // edge (u,v) is opposite C=p
      patch(ext, from, t);        // external neighbor points back to the new tri
      linkFan(v, t, 0);           // NA opposite A=u → edge (v,p), shared vertex v
      linkFan(u, t, 1);           // NB opposite B=v → edge (p,u), shared vertex u
      hint = t;
    }
  }

  // Emit live triangles that don't touch the super-triangle.
  const out: DTTriangle[] = [];
  for (let t = 0; t < nt; t++) {
    if (DEAD[t]) continue;
    const a = TA[t], b = TB[t], c = TC[t];
    if (a >= n || b >= n || c >= n) continue;
    out.push({ a, b, c });
  }
  return out;
}

/** Compute the circumcenter of triangle t given point array pts. */
export function circumcenter(pts: DTPoint[], t: DTTriangle): DTPoint {
  const ax = pts[t.a].x, ay = pts[t.a].y;
  const bx = pts[t.b].x, by = pts[t.b].y;
  const cx = pts[t.c].x, cy = pts[t.c].y;
  const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(D) < 1e-12) {
    return { x: (ax + bx + cx) / 3, y: (ay + by + cy) / 3 };
  }
  const ux =
    ((ax * ax + ay * ay) * (by - cy) +
      (bx * bx + by * by) * (cy - ay) +
      (cx * cx + cy * cy) * (ay - by)) /
    D;
  const uy =
    ((ax * ax + ay * ay) * (cx - bx) +
      (bx * bx + by * by) * (ax - cx) +
      (cx * cx + cy * cy) * (bx - ax)) /
    D;
  return { x: ux, y: uy };
}
