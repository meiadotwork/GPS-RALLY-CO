// A synthetic mountain stage with known geometry, drawn like OSM data:
// sparse, unevenly spaced nodes with a little position noise.
// Used by the Node test and by the app's "Demo stage" button.

import { offsetPoint, segLen } from './pacenotes.js?v=20261109';

// [kind, a, b, expect]  straight: length m | arc: radius m, angle deg (+left / -right)
export const STAGE = [
  ['straight', 250],
  ['arc', 150, -70, 'right 6'],
  ['straight', 120],
  ['arc', 60, 90, 'left 4'],
  ['straight', 12],
  ['arc', 30, -90, 'right 3'],
  ['straight', 200],
  ['arc', 90, 40], ['arc', 32, 50, 'left 5, tightens 3'],
  ['straight', 40],
  ['arc', 9, -175, "hairpin right, don't cut"],
  ['straight', 350],
  ['arc', 20, 100, 'brake, square left'],
  ['straight', 80],
  ['arc', 30, -45], ['arc', 90, -60, 'right 3, opens 5'],
  ['straight', 150],
  ['arc', 110, 150, 'left 5, very long'],
  ['straight', 300],
  ['junction', 'right', null, 'at junction, square right'],
  ['straight', 200],
  ['arc', 60, 20, 'kink left'],
  ['straight', 200],
  ['arc', 45, -60, 'right 4'],
  ['straight', 10],
  ['arc', 45, 60, 'left 4'],
  ['straight', 400],
];

// crest in the right 6, a blind crest just before the left 2, a dip on the straight after the long left
export const HILLS = [[330, 3, 60], [1340, 5, 60], [2200, -4, 50]];

function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296); }

export function buildStage(start = [43.9778, 7.3896], startBearing = 20, seed = 7) {
  const rand = rng(seed);
  const pts = [start];
  let p = start, brg = startBearing;
  const steps = [{ maneuver: { type: 'depart', location: [start[1], start[0]], bearing_before: 0, bearing_after: brg } }];
  const jitter = (q) => offsetPoint(q, rand() * 360, rand() * 0.6);

  for (const [kind, a, b] of STAGE) {
    if (kind === 'straight') {
      let d = 0;
      while (d < a) {
        const seg = Math.min(a - d, 40 + rand() * 110);
        p = offsetPoint(p, brg, seg); d += seg;
        pts.push(d >= a ? p : jitter(p));
      }
    } else if (kind === 'arc') {
      const R = a, ang = b, L = (R * Math.abs(ang) * Math.PI) / 180;
      let d = 0;
      while (d < L) {
        const seg = Math.min(L - d, Math.max(4, (8 + rand() * 18) * Math.min(1, R / 40)));
        const dTheta = (seg / R) * (180 / Math.PI) * Math.sign(ang); // + left
        // chord of the arc piece
        const chord = 2 * R * Math.sin((seg / R) / 2);
        p = offsetPoint(p, brg - dTheta / 2, chord);
        brg = (brg - dTheta + 360) % 360;
        d += seg;
        pts.push(d >= L ? p : jitter(p));
      }
    } else if (kind === 'junction') {
      // a square turn at a single node, like a real intersection in OSM
      const before = brg;
      brg = (brg + (a === 'right' ? 90 : -90) + 360) % 360;
      steps.push({ name: 'Route de Turini', maneuver: { type: 'turn', modifier: a, location: [p[1], p[0]], bearing_before: before, bearing_after: brg } });
    }
  }
  steps.push({ maneuver: { type: 'arrive', location: [p[1], p[0]], bearing_before: brg, bearing_after: 0 } });
  // hills: [centre s (m), height (m), half-width (m)]
  let total = 0; for (let i = 1; i < pts.length; i++) total += segLen(pts[i - 1], pts[i]);
  const elevation = [];
  for (let d = 0; d <= total; d += 20) {
    let z = 900 + d * 0.01;
    for (const [c, h, w] of HILLS) z += h * Math.exp(-(((d - c) / w) ** 2));
    elevation.push({ s: d, z });
  }
  return { points: pts, steps, elevation };
}
