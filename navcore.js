// Live navigation core: map-matching, speed-aware call scheduling, drive simulator.
// Pure ES module (no DOM) so it can be tested in Node.

import { segLen, bearing, chainText, noteText, speedProfile } from './pacenotes.js?v=20261109';
export { speedProfile };

const DEG = Math.PI / 180;

// ---------- map matching ----------

export class RouteTracker {
  constructor(samples, loop = false) {
    this.samples = samples;
    this.loop = loop;
    this.idx = 0;
  }
  // Project a GPS fix onto the route. Searches near the last match first so a
  // road that doubles back on itself doesn't make the position jump.
  locate(lat, lon) {
    const S = this.samples;
    let r = this.loop
      ? this._search(lat, lon, this.idx - 20, this.idx + 400, 15, this.idx - 2)
      : this._search(lat, lon, Math.max(0, this.idx - 20), Math.min(S.length - 1, this.idx + 400), 15, Math.max(0, this.idx - 2));
    if (r.offset > 80) {
      const g = this._search(lat, lon, 0, S.length - 1);
      if (g.offset < r.offset - 20) r = g;
    }
    this.idx = r.idx;
    return r;
  }
  /** Where a point first sits along the route, at or after sample `from` (for checkpoints, in order). */
  firstPass(lat, lon, from = 0, tol = 15) {
    const S = this.samples, hits = [];
    let best = Infinity;
    for (let i = from; i < S.length - 1; i++) { const h = this._search(lat, lon, i, i + 1); hits.push(h); best = Math.min(best, h.offset); }
    let j = hits.findIndex((h) => h.offset <= best + tol);
    if (j < 0) return { s: S[from].s, idx: from, offset: Infinity };
    while (j + 1 < hits.length && hits[j + 1].offset <= hits[j].offset) j++;
    return hits[j];
  }
  // A route that uses the same street twice (or ends where it passed earlier) has two good matches.
  // Take the one you reach FIRST going forward from where you are, never a later pass of the same road:
  // otherwise the position jumps ahead, skips your checkpoints and can even "finish" early.
  _search(lat, lon, from, to, tol = 15, ahead = Infinity) { // ahead: where "forward" starts (just behind the car)
    const S = this.samples, cos = Math.cos(lat * DEG), M = 111320, m = S.length - 1;
    let best = { offset: Infinity, idx: 0, s: 0 };
    const hits = [];
    for (let k = from; k < to; k++) {
      const i = ((k % m) + m) % m; // wraps on a circuit; plain index otherwise
      const a = S[i], b = S[i + 1];
      const ax = (a.lon - lon) * cos * M, ay = (a.lat - lat) * M;
      const bx = (b.lon - lon) * cos * M, by = (b.lat - lat) * M;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2));
      const px = ax + dx * t, py = ay + dy * t, d = Math.hypot(px, py);
      const h = { offset: d, idx: i, s: a.s + (b.s - a.s) * t, k };
      hits.push(h);
      if (d < best.offset) best = h;
    }
    // Best match far ahead (a later pass over the same road)? Stay on this pass if it's about as close.
    // Nearby road (a hairpin's other side, the next 150 m) is matched normally.
    if (best.k - ahead > 30) {
      let near = null;
      for (const h of hits) if (h.k <= ahead + 30 && (!near || h.offset < near.offset)) near = h;
      if (near && near.offset <= best.offset + tol) best = near;
    }
    const a = S[best.idx], b = S[Math.min(best.idx + 1, S.length - 1)];
    best.bearing = bearing([a.lat, a.lon], [b.lat, b.lon]);
    return best;
  }
}

// ---------- call scheduling ----------

export const CALL_AHEAD = { early: 7, normal: 5, late: 3.5 }; // seconds of warning after the call ends

// Rough TTS duration: ~3 words/s at rate 1.
export function speechSeconds(text, rate = 1.3) {
  const words = text.split(/[\s,]+/).filter(Boolean).length;
  return words / (3 * rate) + 0.3 * (text.split(',').length - 1) / rate;
}

export class CallScheduler {
  // opts.loopLength set -> notes repeat every lap; pass an unwrapped s that keeps growing.
  constructor(notes, opts = {}) {
    this.notes = notes;
    this.next = 0;            // first note (virtual index) not yet called
    this.up = 0;
    this.opts = { callAhead: 'normal', rate: 1.3, units: 'metric', loopLength: 0, chain: 'single', ...opts };
  }
  set(opts) { Object.assign(this.opts, opts); }
  get count() { return this.opts.loopLength ? Infinity : this.notes.length; }
  noteAt(k) {
    const N = this.notes, L = this.opts.loopLength;
    if (!L) return N[k];
    const b = N[k % N.length], off = Math.floor(k / N.length) * L;
    return { ...b, sStart: b.sStart + off, sEnd: b.sEnd + off, sApex: b.sApex + off };
  }
  // Skip everything already behind the car (after a reroute or GPS jump).
  seek(s) {
    this.next = 0;
    while (this.next < this.count && this.noteAt(this.next).sApex < s) this.next++;
    this.up = this.next;
  }
  // Which notes would be read in one breath starting at i, at speed v.
  chainFrom(i, v) {
    if (this.opts.chain !== 'ahead') {
      // one call at a time — but corners that run straight into each other (S-bends) are read
      // together, like a co-driver does ("left 4 into right 3"); otherwise the second one is missed
      let j = i;
      while (j < this.count - 1 && j - i < 2 && (this.noteAt(j).gapNext ?? Infinity) < 45) j++;
      return j;
    }
    const window = Math.max(100, v * 3);
    let j = i;
    while (j < this.count - 1 && j - i < 3) {
      const g = this.noteAt(j).gapNext;
      if (g == null || g > window) break;
      j++;
    }
    return j;
  }
  // Distance before the first note at which this chain must start being spoken.
  triggerDistance(text, v) {
    const lead = CALL_AHEAD[this.opts.callAhead] ?? 5;
    const t = lead + speechSeconds(text, this.opts.rate);
    return Math.min(900, Math.max(60, v * t + 15));
  }
  /** @returns null or { from, to, text, triggerDist, distToNote } */
  update(s, v) {
    if (!this.notes.length) return null;
    // missed notes (passed the apex without a call) are dropped silently
    while (this.next < this.count && this.noteAt(this.next).sApex < s - 5) this.next++;
    if (this.next >= this.count) return null;
    const i = this.next, j = this.chainFrom(i, v);
    const chain = [];
    for (let k = i; k <= j; k++) chain.push(this.noteAt(k));
    const text = chainText(chain, 0, chain.length - 1, this.opts.units, { distances: this.opts.dists === 'on' });
    const dist = chain[0].sStart - s;
    const trig = this.triggerDistance(text, v);
    if (dist > trig) return null;
    this.next = j + 1;
    return { from: i, to: j, text, triggerDist: Math.round(trig), distToNote: Math.round(dist) };
  }
  // The note the driver is approaching right now (called or not), for the screen.
  upcoming(s) {
    if (!this.notes.length) return null;
    if (this.up > 0 && this.noteAt(this.up - 1).sEnd >= s) this.up = 0; // went backwards: rescan
    while (this.up < this.count && this.noteAt(this.up).sEnd < s) this.up++;
    if (this.up >= this.count) return null;
    const n = this.noteAt(this.up), nx = this.up + 1 < this.count ? this.noteAt(this.up + 1) : null;
    return { note: n, next: nx, dist: Math.max(0, n.sStart - s), label: n.label ?? noteText(n) };
  }
}

// ---------- simulator ----------

export class DriveSim {
  // constant: drive exactly vmax the whole way (the app's simulator: any speed, 1–300 km/h);
  // otherwise vmax is a top speed, slowing for corners like a real car
  constructor(samples, kappa, vmax, { loop = false, laps = Infinity, constant = false } = {}) {
    this.samples = samples; this.constant = constant; this.vmax = vmax;
    this.loop = loop; this.laps = laps; this.lap = 0;
    this.v = constant ? samples.map(() => vmax) : speedProfile(samples, kappa, vmax, { loop });
    this.s = 0; this.i = 0; this.done = false; this.cur = 0;
  }
  tick(dt) {
    const S = this.samples, L = S[S.length - 1].s;
    if (this.loop && this.s >= L - 0.5) {
      this.s -= L; this.i = 0; this.lap++;
      if (this.lap >= this.laps) this.done = true;
    }
    while (this.i < S.length - 2 && S[this.i + 1].s <= this.s) this.i++;
    const a = S[this.i], b = S[this.i + 1] || a;
    const t = b.s > a.s ? (this.s - a.s) / (b.s - a.s) : 0;
    const v0 = this.v[this.i], v1 = this.v[this.i + 1] ?? v0;
    const speed = this.constant ? this.vmax : Math.max(1.5, Math.min(v0 + (v1 - v0) * t, this.cur + 2.5 * dt)); // standing start
    this.cur = speed;
    this.s = this.loop ? this.s + speed * dt : Math.min(L, this.s + speed * dt);
    if (!this.loop && this.s >= L - 0.5) this.done = true;
    return {
      lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t,
      speed, heading: bearing([a.lat, a.lon], [b.lat, b.lon]), accuracy: 3, s: this.s,
    };
  }
}

export { segLen };

// ---------- GPS sanity: speed and distance driven, without glitches ----------
export const MAX_SPEED = 90; // m/s (324 km/h): anything faster between two fixes is a GPS jump, not driving

/**
 * One GPS update → { v: speed m/s, dd: metres actually driven since the last good fix, jump }.
 * prev: { lat, lon, t (GPS ms), now (phone ms) } or null; f: the fix (speed in m/s if the device gives it).
 * A position jump (impossible speed, or very poor accuracy) adds no distance and keeps the last speed;
 * a device speed that is impossible is ignored too.
 */
export function gpsStep(prev, f, now, lastSpeed = 0) {
  if (!prev) return { v: validSpeed(f.speed) ?? 0, dd: 0, jump: false };
  const dG = (f.t || now) - prev.t, dN = now - prev.now;
  const dt = (dG > 0 && Math.abs(dG - dN) < Math.max(300, dN * 0.3) ? dG : dN) / 1000;
  const d = segLen([prev.lat, prev.lon], [f.lat, f.lon]);
  const vCalc = dt > 0 ? d / dt : Infinity;
  const jump = (vCalc > MAX_SPEED && d > 25) || (f.accuracy != null && f.accuracy > 60);
  let v = validSpeed(f.speed);
  if (v == null) v = jump || dt < 0.4 ? lastSpeed : vCalc; // too close in time to measure: keep the last speed
  return { v: Math.min(v, MAX_SPEED), dd: jump ? 0 : d, jump };
}
const validSpeed = (v) => (v == null || isNaN(v) || v < 0 || v > MAX_SPEED ? null : v);
