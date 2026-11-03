// Race clock: start on GO, laps on a circuit, finish at the destination or after N laps.
// Pure ES module (no DOM) so it can be tested in Node.

export class Race {
  /** @param {{ total: number, loop?: boolean, laps?: number }} o  laps: target on a circuit, 0 = unlimited */
  constructor({ total, loop = false, laps = 1 }) {
    this.total = total; this.loop = loop; this.target = loop ? laps : 1;
    this.state = 'idle';
  }
  start(t) {
    Object.assign(this, { t0: t, state: 'running', init: true, laps: [], lapStart: null, top: 0, dist: 0, lastS: null,
      segT: null, segS: 0, cur: [], lapTraces: [] });
  }
  elapsed(t) { return this.state === 'idle' ? 0 : (this.state === 'done' ? this.result.ms : t - this.t0); }
  lapTime(t) { return this.lapStart == null ? null : t - this.lapStart; }
  /** Where we are in the timed part (the run, or the current lap): { elapsed ms, dist m } — null on an out lap. */
  segment(t, s) { return this.segT == null ? null : { elapsed: t - this.segT, dist: s - this.segS }; }
  _record(t, s, force = false) { // [ms, m] since the segment started, ~every 5 m or 1 s
    if (this.segT == null) return;
    const last = this.cur[this.cur.length - 1], e = t - this.segT, d = s - this.segS;
    if (force || !last || d - last[1] >= 5 || e - last[0] >= 1000) this.cur.push([e, d]);
  }

  /**
   * @param t  time (ms)   @param s  distance along route (unwrapped on a circuit)   @param v  speed (m/s)
   * @returns events: { type: 'lapstart' } | { type: 'lap', n, ms, best } | { type: 'finish', result }
   */
  update(t, s, v = 0) {
    if (this.state !== 'running') return [];
    if (this.init) { // first position after GO
      this.init = false; this.lastS = s; this.s0 = s;
      if (this.loop) {
        const L = this.total, m = ((s % L) + L) % L;
        this.lapStart = m < 50 || m > L - 50 ? this.t0 : null; // on the line: lap 1 runs from GO
        this.skipUntil = s + 100; // ignore the line if we start just before it
        if (this.lapStart != null) { this.segT = this.t0; this.segS = m < 50 ? s - m : s + (L - m); }
      } else { this.segT = this.t0; this.segS = s; }
      this._record(t, s, true);
      return [];
    }
    const ev = [];
    this.top = Math.max(this.top, v || 0);
    if (s > this.lastS) this.dist += s - this.lastS;
    if (this.loop) {
      const L = this.total;
      if (Math.floor(s / L) > Math.floor(this.lastS / L) && s > this.skipUntil) {
        if (this.lapStart != null) {
          const ms = t - this.lapStart, prevBest = this.laps.length ? Math.min(...this.laps) : Infinity;
          this._record(t, s, true);
          this.lapTraces.push(this.cur);
          this.laps.push(ms);
          ev.push({ type: 'lap', n: this.laps.length, ms, best: this.laps.length > 1 && ms < prevBest });
        } else ev.push({ type: 'lapstart' });
        this.lapStart = t;
        this.segT = t; this.segS = Math.floor(s / L) * L; this.cur = []; this._record(t, s, true);
        if (this.target && this.laps.length >= this.target) ev.push(this.finish(t));
      }
    } else if (s >= this.total - 20) { this._record(t, s, true); ev.push(this.finish(t)); }
    if (this.state === 'running') this._record(t, s);
    this.lastS = s;
    return ev;
  }
  finish(t) {
    this.state = 'done';
    const ms = t - this.t0;
    this.result = {
      ms, dist: this.dist, avg: this.dist / Math.max(1, ms / 1000), top: this.top,
      laps: this.laps.slice(), best: this.laps.length ? Math.min(...this.laps) : null,
    };
    // the ghost to beat next time: the whole run, or the best lap on a circuit
    if (this.loop) {
      if (this.laps.length) { const i = this.laps.indexOf(this.result.best); this.result.ghost = { ms: this.result.best, trace: compressTrace(this.lapTraces[i]) }; }
    } else this.result.ghost = { ms, trace: compressTrace(this.cur) };
    return { type: 'finish', result: this.result };
  }
}

// Time as 1:23.4 or 1:02:03.4
export function fmtRaceTime(ms) {
  const t = Math.max(0, ms) / 1000, h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const ss = s.toFixed(1).padStart(4, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// The route's shape as an SVG path fitted into w×h (for the results card).
export function routeSvgPath(points, w = 300, h = 170, pad = 12) {
  if (!points?.length) return { d: '', start: [0, 0], end: [0, 0] };
  const lat0 = points[0][0] * Math.PI / 180, k = Math.cos(lat0);
  const xy = points.map(([la, lo]) => [lo * k, -la]);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of xy) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const sc = Math.min((w - 2 * pad) / Math.max(1e-9, x1 - x0), (h - 2 * pad) / Math.max(1e-9, y1 - y0));
  const ox = (w - (x1 - x0) * sc) / 2, oy = (h - (y1 - y0) * sc) / 2;
  const P = xy.map(([x, y]) => [ox + (x - x0) * sc, oy + (y - y0) * sc]);
  const step = Math.max(1, Math.floor(P.length / 400)); // keep the path light
  const pts = P.filter((_, i) => i % step === 0 || i === P.length - 1);
  return { d: 'M' + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L'), start: P[0], end: P[P.length - 1] };
}

// ---------- ghost ----------

/** Keep a trace small for storage (≤ max points, always keeping the last one). */
export function compressTrace(trace, max = 600) {
  if (!trace || trace.length <= max) return (trace || []).map(([t, d]) => [Math.round(t), Math.round(d * 10) / 10]);
  const step = trace.length / max, out = [];
  for (let i = 0; i < max - 1; i++) out.push(trace[Math.floor(i * step)]);
  out.push(trace[trace.length - 1]);
  return out.map(([t, d]) => [Math.round(t), Math.round(d * 10) / 10]);
}

/** When did the ghost reach distance d? (ms, interpolated) — null if it never got that far. */
export function ghostTimeAt(trace, d) {
  if (!trace?.length || d < trace[0][1]) return trace?.length ? trace[0][0] : null;
  for (let i = 1; i < trace.length; i++) {
    const [t1, d1] = trace[i];
    if (d1 >= d) { const [t0, d0] = trace[i - 1]; return d1 > d0 ? t0 + (t1 - t0) * (d - d0) / (d1 - d0) : t1; }
  }
  return null;
}

/** How far had the ghost got after ms? (m, interpolated; stops at its finish). */
export function ghostDistAt(trace, ms) {
  if (!trace?.length) return null;
  if (ms <= trace[0][0]) return trace[0][1];
  for (let i = 1; i < trace.length; i++) {
    const [t1, d1] = trace[i];
    if (t1 >= ms) { const [t0, d0] = trace[i - 1]; return t1 > t0 ? d0 + (d1 - d0) * (ms - t0) / (t1 - t0) : d1; }
  }
  return trace[trace.length - 1][1];
}

/** Live gap to the ghost at this point: + behind, − ahead (ms). */
export function ghostDelta(trace, elapsed, dist) {
  const tg = ghostTimeAt(trace, dist);
  return tg == null ? null : elapsed - tg;
}
