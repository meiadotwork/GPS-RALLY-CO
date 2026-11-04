// Parking hunt: drive every street within a radius of the destination, closest first.
// Pure ES module (no DOM, no network): OSM data in, a drivable path out.

import { segLen, bearing } from './pacenotes.js';

const RESIDENTIAL = ['residential', 'living_street', 'unclassified', 'tertiary', 'tertiary_link'];
const MAIN = ['secondary', 'secondary_link', 'primary', 'primary_link'];
// big roads are always loaded so the hunt can drive along them to reach the next neighbourhood; with
// one-way grids (New York…) the small streets alone often can't get you out of a block.
const LINK = ['trunk', 'trunk_link'];

/** Overpass query for the drivable streets around a point (a margin beyond the radius keeps the connections).
 *  Main roads always come too, as connections; whether they're searched is decided in buildGraph. */
export function overpassQuery(lat, lon, radius) {
  const types = [...RESIDENTIAL, ...MAIN, ...LINK].join('|');
  const around = Math.round(radius + Math.min(400, 150 + radius * 0.15));
  const timeout = radius > 1500 ? 90 : 45;
  return `[out:json][timeout:${timeout}];way(around:${around},${lat.toFixed(6)},${lon.toFixed(6)})` +
    `["highway"~"^(${types})$"]["access"!~"^(no|private)$"]["motor_vehicle"!~"^(no|private)$"]["area"!="yes"];(._;>;);out body;`;
}

const onewayOf = (t = {}) => {
  if (t.junction === 'roundabout' || t.junction === 'circular') return 1;
  if (['yes', 'true', '1'].includes(t.oneway)) return 1;
  if (t.oneway === '-1' || t.oneway === 'reverse') return -1;
  return 0;
};

/**
 * Street graph from Overpass JSON.
 * blocks = street stretches between intersections (what we want to drive), each with
 * the directions you're allowed to drive it and whether it lies inside the radius.
 */
export function buildGraph(osm, center, radius, { mainRoads = false } = {}) {
  const nodes = new Map(), ways = [];
  for (const el of osm.elements || []) {
    if (el.type === 'node') nodes.set(el.id, [el.lat, el.lon]);
    else if (el.type === 'way' && el.nodes?.length > 1) ways.push(el);
  }
  // how many distinct streets meet at each node → intersections
  const nbr = new Map();
  const link = (a, b) => { (nbr.get(a) || nbr.set(a, new Set()).get(a)).add(b); };
  for (const w of ways) for (let i = 1; i < w.nodes.length; i++) { link(w.nodes[i - 1], w.nodes[i]); link(w.nodes[i], w.nodes[i - 1]); }

  const adj = new Map();      // node → [{ to, len, name }]
  const edgeBlock = new Map(); // "a>b" → block index
  const blocks = [];
  const addEdge = (a, b, len, name) => (adj.get(a) || adj.set(a, []).get(a)).push({ to: b, len, name });

  for (const w of ways) {
    const ow = onewayOf(w.tags), name = w.tags?.name || w.tags?.ref || '';
    const hw = w.tags?.highway, searchable = !hw || RESIDENTIAL.includes(hw) || (mainRoads && MAIN.includes(hw)); // the rest only connects
    const ids = w.nodes.filter((id) => nodes.has(id));
    let cur = [ids[0]];
    const close = () => {
      if (cur.length < 2) return;
      const pts = cur.map((id) => nodes.get(id));
      let len = 0; for (let i = 1; i < pts.length; i++) len += segLen(pts[i - 1], pts[i]);
      const mid = pts[Math.floor(pts.length / 2)];
      const b = { i: blocks.length, nodes: cur.slice(), fwd: ow >= 0, back: ow <= 0, len, mid, name,
        dist: segLen(mid, center), target: false };
      // inside the radius if its middle (or either end) is
      b.main = !searchable;
      b.target = searchable && (b.dist <= radius || segLen(pts[0], center) <= radius * 0.9 || segLen(pts[pts.length - 1], center) <= radius * 0.9);
      blocks.push(b);
      for (let i = 1; i < cur.length; i++) {
        const a = cur[i - 1], c = cur[i], d = segLen(nodes.get(a), nodes.get(c));
        if (b.fwd) { addEdge(a, c, d, name); edgeBlock.set(`${a}>${c}`, b.i); }
        if (b.back) { addEdge(c, a, d, name); edgeBlock.set(`${c}>${a}`, b.i); }
      }
    };
    for (let i = 1; i < ids.length; i++) {
      cur.push(ids[i]);
      if (i < ids.length - 1 && (nbr.get(ids[i])?.size || 0) >= 3) { close(); cur = [ids[i]]; } // split at intersections
    }
    close();
  }
  return { nodes, adj, blocks, edgeBlock, center, radius };
}

// tiny binary heap for Dijkstra
class Heap {
  constructor() { this.a = []; }
  push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top;
  }
  get size() { return this.a.length; }
}

/**
 * Plan the hunt: from the start, repeatedly drive to the best not-yet-driven street in the radius and along it.
 * "Best" = driving distance to reach it + wCenter × its distance from the destination, so the streets
 * nearest the destination come first and the search spirals outwards. Every street you pass on the way
 * counts as covered. One-way streets are respected; an immediate U-turn costs extra.
 * Big radii are planned in batches: stop after maxLength metres; pass the returned `done` set back in to continue.
 * @returns { points, nodeIds, length, covered, total, remaining, done, turns, unreachable }
 */
export function planHunt(g, start, { wCenter = 0.8, uturnPenalty = 250, maxLength = 15000, done = null } = {}) {
  const { nodes, adj, blocks, edgeBlock, center } = g;
  // start at the graph node nearest the start point (preferring one on a street in the radius)
  let cur = null, bd = Infinity;
  for (const b of blocks) for (const id of b.nodes) {
    const d = segLen(nodes.get(id), start) + (b.target ? 0 : 50);
    if (d < bd && adj.get(id)?.length) { bd = d; cur = id; }
  }
  if (cur == null) return { points: [], nodeIds: [], length: 0, covered: 0, total: 0, remaining: 0, done: new Set(), turns: [], unreachable: 0 };

  const covered = new Set(done || []), already = covered.size, targets = blocks.filter((b) => b.target);
  const total = targets.length;
  // where each block can be entered: node → [{ b, dir }]
  const entries = new Map();
  for (const b of targets) {
    if (b.fwd) (entries.get(b.nodes[0]) || entries.set(b.nodes[0], []).get(b.nodes[0])).push({ b, dir: 1 });
    if (b.back) { const e = b.nodes[b.nodes.length - 1]; (entries.get(e) || entries.set(e, []).get(e)).push({ b, dir: -1 }); }
  }
  const route = [cur];
  let length = 0, prev = null, unreachable = 0;
  const step = (a, b) => {
    length += segLen(nodes.get(a), nodes.get(b));
    const bi = edgeBlock.get(`${a}>${b}`);
    if (bi != null && blocks[bi].target) covered.add(bi);
    route.push(b);
  };

  while (covered.size + unreachable < total && length < maxLength) {
    // Dijkstra outwards from here, stopping once nothing closer can beat the best street found
    const dist = new Map([[cur, 0]]), from = new Map(), heap = new Heap();
    heap.push([0, cur]);
    let best = null, bestCost = Infinity;
    while (heap.size) {
      const [d, u] = heap.pop();
      if (d > (dist.get(u) ?? Infinity)) continue;
      if (d >= bestCost) break;
      for (const e of entries.get(u) || []) {
        if (covered.has(e.b.i)) continue;
        const c = d + e.b.dist * wCenter; // reach it soon, and stay close to the destination
        if (c < bestCost) { bestCost = c; best = { node: u, ...e }; }
      }
      for (const ed of adj.get(u) || []) {
        const nd = d + ed.len + (u === cur && ed.to === prev ? uturnPenalty : 0);
        if (nd < (dist.get(ed.to) ?? Infinity)) { dist.set(ed.to, nd); from.set(ed.to, u); heap.push([nd, ed.to]); }
      }
    }
    if (!best) { // what's left can't be reached from here (one-way traps): give up on it
      unreachable = total - covered.size;
      break;
    }
    // drive there
    const path = [];
    for (let n = best.node; n !== cur; n = from.get(n)) path.push(n);
    path.reverse();
    let last = cur;
    for (const n of path) { prev = last; step(last, n); last = n; }
    // and along the street
    const seq = best.dir === 1 ? best.b.nodes : best.b.nodes.slice().reverse();
    for (let i = 1; i < seq.length; i++) { prev = last; step(last, seq[i]); last = seq[i]; }
    covered.add(best.b.i);
    cur = last;
  }

  const points = route.map((id) => nodes.get(id));
  return { points, nodeIds: route, length, covered: covered.size - already, total, remaining: total - covered.size - unreachable,
    done: covered, turns: huntTurns(g, route), unreachable };
}

/** Turn instructions where the street changes (OSRM-like steps, so the pace-note engine can say "onto …"). */
export function huntTurns(g, route) {
  const { nodes, adj } = g, out = [];
  const nameOf = (a, b) => (adj.get(a) || []).find((e) => e.to === b)?.name || '';
  // distance along the hunt at each node: the route passes some junctions more than once, so each
  // turn carries its exact position (_s) instead of being found by "nearest point"
  const cum = [0];
  for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + segLen(nodes.get(route[i - 1]), nodes.get(route[i])));
  for (let i = 1; i < route.length - 1; i++) {
    const a = route[i - 1], m = route[i], c = route[i + 1];
    const n1 = nameOf(a, m), n2 = nameOf(m, c);
    const pa = nodes.get(a), pm = nodes.get(m), pc = nodes.get(c);
    const before = bearing(pa, pm), after = bearing(pm, pc);
    const turn = Math.abs(((after - before + 540) % 360) - 180);
    if ((n1 !== n2 && turn >= 20) || turn >= 60) {
      out.push({ name: n2, _s: cum[i], maneuver: { type: turn >= 170 ? 'continue' : 'turn', location: [pm[1], pm[0]], bearing_before: before, bearing_after: after } });
    }
  }
  return out;
}
