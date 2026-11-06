// Red light timer: learns how long each traffic light stays red, by location and the way you approach it.
// Pure ES module (no DOM) so it can be tested.
//
// lights = [{ id, lat, lon, heading, ms, n }]   ms = learned red time, n = how many stops it's based on

import { segLen } from './pacenotes.js';

export const NEAR_M = 40;        // a stop counts as "at" a light within this distance
export const MIN_MS = 5000;      // shorter: a mis-tap, not a red phase
export const MAX_MS = 180000;    // longer: you weren't waiting at the light
const KEEP = 8;                  // the average follows the last ~8 stops, so it adapts if the timing changes

const angle = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

/** The nearest mapped traffic light within NEAR_M of here, or null. points: [{lat, lon}] */
export function nearLight(points, lat, lon, maxM = NEAR_M) {
  let best = null, bd = maxM;
  for (const p of points || []) { const d = segLen([lat, lon], [p.lat, p.lon]); if (d <= bd) { bd = d; best = p; } }
  return best;
}

/** The learned light for this spot and direction (the same junction from another side is a different light). */
export function findLearned(lights, lat, lon, heading) {
  let best = null, bd = 30;
  for (const l of lights || []) {
    if (heading != null && l.heading != null && angle(heading, l.heading) > 50) continue;
    const d = segLen([lat, lon], [l.lat, l.lon]);
    if (d <= bd) { bd = d; best = l; }
  }
  return best;
}

/** Add one measured red time. Returns the new list (unchanged if the time doesn't look like a red phase). */
export function learn(lights, { lat, lon, heading }, ms) {
  if (!(ms >= MIN_MS && ms <= MAX_MS)) return lights;
  const out = (lights || []).slice(), l = findLearned(out, lat, lon, heading);
  if (!l) { out.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), lat, lon, heading: heading ?? null, ms: Math.round(ms), n: 1 }); return out; }
  const n = Math.min(l.n, KEEP - 1);
  out[out.indexOf(l)] = { ...l, ms: Math.round((l.ms * n + ms) / (n + 1)), n: l.n + 1 };
  return out;
}

/** Nudge a learned time by hand (the −5 / +5 buttons). */
export function adjust(lights, id, deltaMs) {
  return (lights || []).map((l) => (l.id === id ? { ...l, ms: Math.max(MIN_MS, Math.min(MAX_MS, l.ms + deltaMs)) } : l));
}
