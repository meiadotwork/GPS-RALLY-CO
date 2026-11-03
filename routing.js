// Route clean-up helpers: find around-the-block loops / U-turn spurs, score smoothness,
// insert a via point where it fits best. Pure ES module (no DOM, no network).

import { segLen } from './pacenotes.js';

function cumulative(points) {
  const c = [0];
  for (let i = 1; i < points.length; i++) c.push(c[i - 1] + segLen(points[i - 1], points[i]));
  return c;
}

/**
 * Places where the route comes back to a spot it already passed (same street node):
 * around-the-block loops and out-and-back spurs. Returns non-overlapping [{ i, j, len }].
 * A whole circuit returning to its start is not a loop (maxFrac of the total).
 */
export function findLoops(points, { tol = 3, minLen = 40, maxLen = 2000, maxFrac = 0.4 } = {}) {
  const n = points.length, cum = cumulative(points), total = cum[n - 1] || 1;
  const cap = Math.min(maxLen, total * maxFrac);
  // spatial hash, ~11 m cells
  const key = (p) => `${Math.round(p[0] * 1e4)}|${Math.round(p[1] * 1e4)}`;
  const grid = new Map();
  points.forEach((p, i) => { const k = key(p); (grid.get(k) || grid.set(k, []).get(k)).push(i); });
  const near = (p) => {
    const a = Math.round(p[0] * 1e4), b = Math.round(p[1] * 1e4), out = [];
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) out.push(...(grid.get(`${a + x}|${b + y}`) || []));
    return out;
  };
  const loops = [];
  for (let i = 0; i < n; i++) {
    let best = -1;
    for (const j of near(points[i])) {
      if (j <= i + 1) continue;
      const len = cum[j] - cum[i];
      if (len < minLen || len > cap) continue;
      if (segLen(points[i], points[j]) > tol) continue;
      if (j > best) best = j;
    }
    if (best > 0) { loops.push({ i, j: best, len: cum[best] - cum[i] }); i = best; }
  }
  return loops;
}

const turnAngle = (st) => {
  const m = st.maneuver || {};
  if (m.bearing_before == null || m.bearing_after == null) return 0;
  return Math.abs(((m.bearing_after - m.bearing_before + 540) % 360) - 180);
};

/** Smoothness cost of an OSRM route: time plus penalties for sharp turns and U-turns. */
export function routeCost(route) {
  let sharp = 0, uturns = 0;
  for (const leg of route.legs || []) for (const st of leg.steps || []) {
    const t = st.maneuver?.type;
    if (t === 'depart' || t === 'arrive') continue;
    const a = turnAngle(st);
    if (st.maneuver?.modifier === 'uturn' || a >= 150) uturns++;
    else if (a >= 60) sharp++;
  }
  return { cost: route.duration + 25 * sharp + 120 * uturns, sharp, uturns };
}

/** Index of the smoothest of OSRM's alternatives, as long as it's no more than +15% slower. */
export function chooseSmoothest(routes) {
  if (!routes?.length) return 0;
  const fastest = Math.min(...routes.map((r) => r.duration));
  let bi = 0, bc = Infinity;
  routes.forEach((r, i) => {
    if (r.duration > fastest * 1.15) return;
    const c = routeCost(r).cost;
    if (c < bc) { bc = c; bi = i; }
  });
  return bi;
}

/** Where in the list of points a new via fits with the least extra distance (never before the start or after the end). */
export function bestInsertIndex(pts, p) {
  let bi = 1, bd = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = segLen(pts[i], p) + segLen(p, pts[i + 1]) - segLen(pts[i], pts[i + 1]);
    if (d < bd) { bd = d; bi = i + 1; }
  }
  return bi;
}

/** Nearest geometry index to p. */
export function nearestIndex(points, p) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < points.length; i++) { const d = segLen(points[i], p); if (d < bd) { bd = d; bi = i; } }
  return { idx: bi, dist: bd };
}

/** Which intermediate waypoints (1..n-2) sit inside a loop or next to a U-turn of this route. */
export function detourVias(points, viaSnapped, uturnPts = []) {
  const loops = findLoops(points);
  const bad = [];
  viaSnapped.forEach((v, k) => {
    if (k === 0 || k === viaSnapped.length - 1 || !v) return;
    const { idx } = nearestIndex(points, v);
    const inLoop = loops.some((L) => idx > L.i && idx < L.j);
    const nearU = uturnPts.some((u) => segLen(u, v) < 40);
    if (inLoop || nearU) bad.push(k);
  });
  return { bad, loops };
}

/** Distance from p to the polyline (metres, to the nearest segment, not just the nearest vertex). */
export function distToPolyline(points, p) {
  const cos = Math.cos(p[0] * Math.PI / 180), M = 111320;
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const ax = (points[i][1] - p[1]) * cos * M, ay = (points[i][0] - p[0]) * M;
    const bx = (points[i + 1][1] - p[1]) * cos * M, by = (points[i + 1][0] - p[0]) * M;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2));
    best = Math.min(best, Math.hypot(ax + dx * t, ay + dy * t));
  }
  return best;
}

// ---------- route options: shortest / no tolls / smooth / explore ----------

import { offsetPoint, bearing } from './pacenotes.js';

/** A point part-way from a to b (t = 0..1), pushed sideways by frac × the A–B distance (+ right, − left). */
export function lateralPoint(a, b, t, frac) {
  const d = segLen(a, b), brg = bearing(a, b);
  const mid = offsetPoint(a, brg, d * t);
  return offsetPoint(mid, brg + 90, d * frac);
}

/** Index of the shortest route (by distance). */
export function pickShortest(routes) {
  let bi = 0; routes.forEach((r, i) => { if (r.distance < routes[bi].distance) bi = i; }); return bi;
}

/** How many toll intersections an OSRM route passes. */
export function tollCount(route) {
  let n = 0;
  for (const leg of route.legs || []) for (const st of leg.steps || []) for (const ix of st.intersections || []) if ((ix.classes || []).includes('toll')) n++;
  return n;
}

/** Tight corners in a set of pace notes: hairpin, 1, 2, square, acute (what "smooth" avoids). */
export function tightCount(notes) {
  return notes.filter((n) => n.grade === 'H' || n.shape === 'square' || n.shape === 'acute' || n.shape === 'hairpin' ||
    (typeof n.grade === 'number' && n.grade <= 2)).length;
}
/** Medium corners (3 and 4). */
export function midCount(notes) {
  return notes.filter((n) => !n.shape && typeof n.grade === 'number' && n.grade >= 3 && n.grade <= 4).length;
}

/** Smoothness score for a candidate (lower is better): tight corners cost most, then medium ones, then time. */
export function smoothScore({ notes, duration }) {
  return tightCount(notes) * 60 + midCount(notes) * 15 + duration;
}

/** Side-detour candidates for the "smooth" search: via points left and right of the straight line. */
export function smoothCandidates(a, b) {
  return [0.15, -0.15, 0.3, -0.3].map((f) => [a, lateralPoint(a, b, 0.5, f), b]);
}

/** One or two random points between a and b for "explore" (rand: () => 0..1). */
export function exploreVias(a, b, rand = Math.random) {
  const k = rand() < 0.5 ? 1 : 2, side = rand() < 0.5 ? -1 : 1, pts = [];
  for (let i = 0; i < k; i++) {
    const t = k === 1 ? 0.35 + rand() * 0.3 : (i ? 0.6 + rand() * 0.15 : 0.25 + rand() * 0.15);
    const frac = (0.12 + rand() * 0.28) * (k === 2 && rand() < 0.4 ? -side : side);
    pts.push(lateralPoint(a, b, t, frac));
  }
  return [a, ...pts, b];
}

/** The point a fraction t (0..1) of the way along a polyline. */
export function pointAlong(points, t) {
  let total = 0; for (let i = 1; i < points.length; i++) total += segLen(points[i - 1], points[i]);
  let goal = total * t;
  for (let i = 1; i < points.length; i++) {
    const d = segLen(points[i - 1], points[i]);
    if (goal <= d) { const f = d ? goal / d : 0; return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * f, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * f]; }
    goal -= d;
  }
  return points[points.length - 1];
}

/** Share of route b's length that runs within tol metres of route a (0..1): how much of the way back repeats the way out. */
export function sharedFraction(a, b, tol = 20) {
  let total = 0, shared = 0;
  for (let i = 1; i < b.length; i++) {
    const d = segLen(b[i - 1], b[i]);
    if (!d) continue;
    const n = Math.max(1, Math.ceil(d / 25));                 // check every ~25 m
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n, p = [b[i - 1][0] + (b[i][0] - b[i - 1][0]) * t, b[i - 1][1] + (b[i][1] - b[i - 1][1]) * t];
      total += d / n;
      if (distToPolyline(a, p) <= tol) shared += d / n;
    }
  }
  return total ? shared / total : 0;
}

/** Ways out and ways back for a round circuit from a to b: plain, and detours on either side. */
export function roundCandidates(a, b, rand = null) {
  const f = (x) => (rand ? Math.sign(x) * (0.15 + rand() * 0.3) : x);
  return {
    outs: [[a, b], [a, lateralPoint(a, b, 0.5, f(0.25)), b], [a, lateralPoint(a, b, 0.5, f(-0.25)), b]],
    rets: [[b, a], [b, lateralPoint(b, a, 0.5, f(0.25)), a], [b, lateralPoint(b, a, 0.5, f(-0.25)), a],
      [b, lateralPoint(b, a, 0.5, f(0.45)), a], [b, lateralPoint(b, a, 0.5, f(-0.45)), a]],
  };
}
