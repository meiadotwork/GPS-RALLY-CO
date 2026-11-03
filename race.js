// Race clock: start on GO, laps on a circuit, finish at the destination or after N laps.
// Pure ES module (no DOM) so it can be tested in Node.

export class Race {
  /** @param {{ total: number, loop?: boolean, laps?: number }} o  laps: target on a circuit, 0 = unlimited */
  constructor({ total, loop = false, laps = 1 }) {
    this.total = total; this.loop = loop; this.target = loop ? laps : 1;
    this.state = 'idle';
  }
  start(t) {
    Object.assign(this, { t0: t, state: 'running', init: true, laps: [], lapStart: null, top: 0, dist: 0, lastS: null });
  }
  elapsed(t) { return this.state === 'idle' ? 0 : (this.state === 'done' ? this.result.ms : t - this.t0); }
  lapTime(t) { return this.lapStart == null ? null : t - this.lapStart; }

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
      }
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
          this.laps.push(ms);
          ev.push({ type: 'lap', n: this.laps.length, ms, best: this.laps.length > 1 && ms < prevBest });
        } else ev.push({ type: 'lapstart' });
        this.lapStart = t;
        if (this.target && this.laps.length >= this.target) ev.push(this.finish(t));
      }
    } else if (s >= this.total - 20) ev.push(this.finish(t));
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
