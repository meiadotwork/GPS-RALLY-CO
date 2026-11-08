// Recording a drive: turn raw GPS fixes into a clean track for pace notes.
// Pure ES module (no DOM) so it can be tested in Node.

import { segLen } from './pacenotes.js?v=20261109';

/**
 * Keep a fix if it's accurate enough, not a jump, and far enough from the last kept one.
 * @param {{lat, lon, t, accuracy?}[]} fixes   t in ms
 */
export function cleanFixes(fixes, { maxAccuracy = 35, minSpacing = 4, maxSpeed = 70 } = {}) {
  const out = [];
  let cand = null; // a fix rejected as a jump — if the next one agrees with it, it was real movement
  const fast = (a, b) => segLen([a.lat, a.lon], [b.lat, b.lon]) / Math.max(0.001, (b.t - a.t) / 1000) > maxSpeed;
  for (const f of fixes) {
    if (f.accuracy != null && f.accuracy > maxAccuracy) continue;
    const last = out[out.length - 1];
    if (last) {
      if (segLen([last.lat, last.lon], [f.lat, f.lon]) < minSpacing) continue; // standing still / jitter
      if (fast(last, f)) {                                                   // a jump (> 250 km/h)…
        if (cand && !fast(cand, f)) { out.push(cand); cand = null; }         // …unless two in a row agree: re-sync
        else { cand = f; continue; }
      }
    }
    cand = null;
    out.push(f);
  }
  return out.map((f) => [f.lat, f.lon]);
}

/** Light smoothing (moving average over 3 points) to take the GPS wobble out; ends stay put. */
export function smoothTrack(pts) {
  if (pts.length < 3) return pts.slice();
  return pts.map((p, i) => (i === 0 || i === pts.length - 1 ? p
    : [(pts[i - 1][0] + p[0] + pts[i + 1][0]) / 3, (pts[i - 1][1] + p[1] + pts[i + 1][1]) / 3]));
}

/** Douglas–Peucker simplification (tolerance in metres): fewer points, same shape. */
export function simplifyTrack(pts, tol = 2.5) {
  if (pts.length < 3) return pts.slice();
  const cos = Math.cos(pts[0][0] * Math.PI / 180), M = 111320;
  const xy = pts.map(([la, lo]) => [lo * cos * M, la * M]);
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let md = 0, mi = -1;
    const [ax, ay] = xy[a], [bx, by] = xy[b], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(0, Math.min(1, ((xy[i][0] - ax) * dx + (xy[i][1] - ay) * dy) / L2));
      const d = Math.hypot(xy[i][0] - (ax + dx * t), xy[i][1] - (ay + dy * t));
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Raw fixes → the track to save, plus its length and whether it ends where it started (a circuit). */
export function finishRecording(fixes) {
  const pts = simplifyTrack(smoothTrack(cleanFixes(fixes)));
  let length = 0; for (let i = 1; i < pts.length; i++) length += segLen(pts[i - 1], pts[i]);
  const loop = pts.length > 3 && length > 500 && segLen(pts[0], pts[pts.length - 1]) < 60;
  return { points: pts, length, loop };
}
