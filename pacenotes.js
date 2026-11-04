// Rally pace note generator. Pure ES module, no DOM — runs in the browser and in Node.
//
// Pipeline: polyline -> resample every STEP m -> heading -> smoothed curvature ->
// corner runs -> grade (1-6 / hairpin) + modifiers -> merge junction calls from
// routing steps -> link words / distances between notes.

const DEG = Math.PI / 180;
const R_EARTH = 6371008.8;

export const DEFAULTS = {
  step: 5,            // resample spacing (m)
  sigma: 8,           // heading smoothing (m), irons out sparse OSM nodes
  kWindow: 2,         // curvature = heading diff over +-kWindow samples
  kMin: 1 / 400,      // anything gentler than R=400 m is straight
  minRunAngle: 4,     // drop curvature blips under this (deg)
  mergeGap: 20,       // same-direction runs closer than this are one corner (m)
  minCornerAngle: 12, // ignore corners with less total turn (deg)
  lineWidth: 3,       // usable road width for the racing line (m)
  flats: true,        // also call gentle bends as 'flat' / 'kink'
  flatLimit: 700,     // ...up to this effective radius (m)
};

// Effective-radius thresholds for the 1-6 scale (m). Speeds at ~0.8 g:
// 2 ≈ 50 km/h, 3 ≈ 70, 4 ≈ 90, 5 ≈ 110, 6 ≈ 140.
const GRADE_LIMITS = [[1, 22], [2, 35], [3, 55], [4, 85], [5, 130], [6, 220]];

// ---------- geometry ----------

export function segLen(a, b) {
  const mlat = ((a[0] + b[0]) / 2) * DEG;
  const dx = (b[1] - a[1]) * DEG * Math.cos(mlat) * R_EARTH;
  const dy = (b[0] - a[0]) * DEG * R_EARTH;
  return Math.hypot(dx, dy);
}

// Compass bearing a -> b, degrees clockwise from north.
export function bearing(a, b) {
  const mlat = ((a[0] + b[0]) / 2) * DEG;
  const dx = (b[1] - a[1]) * Math.cos(mlat);
  const dy = b[0] - a[0];
  return (Math.atan2(dx, dy) / DEG + 360) % 360;
}

// Point at distance d (m) along compass bearing brg (deg) from p.
export function offsetPoint(p, brg, d) {
  const dy = Math.cos(brg * DEG) * d, dx = Math.sin(brg * DEG) * d;
  return [p[0] + dy / R_EARTH / DEG, p[1] + dx / (R_EARTH * Math.cos(p[0] * DEG)) / DEG];
}

export function resample(points, step) {
  const pts = points.filter((p, i) => i === 0 || segLen(points[i - 1], p) > 0.01);
  const out = [{ lat: pts[0][0], lon: pts[0][1], s: 0 }];
  let segStart = 0, nextAt = step;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], L = segLen(a, b);
    while (nextAt <= segStart + L) {
      const t = (nextAt - segStart) / L;
      out.push({ lat: a[0] + (b[0] - a[0]) * t, lon: a[1] + (b[1] - a[1]) * t, s: nextAt });
      nextAt += step;
    }
    segStart += L;
  }
  const last = pts[pts.length - 1];
  if (segStart - out[out.length - 1].s > step * 0.3) out.push({ lat: last[0], lon: last[1], s: segStart });
  return { samples: out, total: segStart };
}

function gaussianSmooth(arr, sigmaSamples) {
  if (sigmaSamples <= 0) return arr.slice();
  const r = Math.ceil(sigmaSamples * 3), w = [];
  for (let k = -r; k <= r; k++) w.push(Math.exp(-(k * k) / (2 * sigmaSamples * sigmaSamples)));
  return arr.map((_, i) => {
    let sum = 0, ws = 0;
    for (let k = -r; k <= r; k++) {
      const j = i + k;
      if (j < 0 || j >= arr.length) continue;
      sum += arr[j] * w[k + r]; ws += w[k + r];
    }
    return sum / ws;
  });
}

// Signed curvature per sample (1/m). Positive = left.
export function curvature(samples, opt = DEFAULTS) {
  const n = samples.length;
  const kappa = new Array(n).fill(0);
  if (n < 4) return kappa;
  const H = [];
  for (let i = 0; i < n - 1; i++) {
    const a = samples[i], b = samples[i + 1];
    const mlat = ((a.lat + b.lat) / 2) * DEG;
    let h = Math.atan2(b.lat - a.lat, (b.lon - a.lon) * Math.cos(mlat)); // math angle, CCW
    if (i > 0) { // unwrap
      while (h - H[i - 1] > Math.PI) h -= 2 * Math.PI;
      while (h - H[i - 1] < -Math.PI) h += 2 * Math.PI;
    }
    H.push(h);
  }
  const Hs = gaussianSmooth(H, opt.sigma / opt.step);
  const k = opt.kWindow;
  for (let i = 0; i < Hs.length; i++) {
    const i0 = Math.max(0, i - k), i1 = Math.min(Hs.length - 1, i + k);
    if (i1 > i0) kappa[i] = (Hs[i1] - Hs[i0]) / ((i1 - i0) * opt.step);
  }
  return kappa;
}

// ---------- grading ----------

// Racing-line radius: a shallow corner can be straightened using the road width.
export function effectiveRadius(r, angleDeg, width = DEFAULTS.lineWidth) {
  const half = Math.min(angleDeg, 180) * DEG / 2;
  return r + width / Math.max(1e-6, 1 - Math.cos(half));
}

export function gradeFor(rEff, angleDeg) {
  if ((angleDeg >= 135 && rEff < 30) || (angleDeg >= 90 && rEff < 15)) return 'H';
  for (const [g, lim] of GRADE_LIMITS) if (rEff < lim) return g;
  return null; // flat
}
export const gradeNum = (g) => (g === 'H' ? 0 : g === 'F' ? 7 : g);

// ---------- corner detection ----------

function findCorners(samples, kappa, opt) {
  const { step } = opt;
  let runs = [];
  let cur = null;
  for (let i = 0; i < kappa.length; i++) {
    const sg = kappa[i] > opt.kMin ? 1 : kappa[i] < -opt.kMin ? -1 : 0;
    if (cur && sg === cur.sign) { cur.i1 = i; continue; }
    if (cur) runs.push(cur);
    cur = sg ? { sign: sg, i0: i, i1: i } : null;
  }
  if (cur) runs.push(cur);

  const angleOf = (r) => { let a = 0; for (let i = r.i0; i <= r.i1; i++) a += kappa[i] * step; return Math.abs(a) / DEG; };
  runs = runs.filter((r) => angleOf(r) >= opt.minRunAngle);

  const merged = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.sign === r.sign && (r.i0 - prev.i1) * step < opt.mergeGap) prev.i1 = r.i1;
    else merged.push({ ...r });
  }

  const corners = [];
  for (const r of merged) {
    const angle = angleOf(r);
    if (angle < (opt.flats ? 8 : opt.minCornerAngle)) continue;
    let peak = 0, apex = r.i0;
    for (let i = r.i0; i <= r.i1; i++) if (Math.abs(kappa[i]) > peak) { peak = Math.abs(kappa[i]); apex = i; }
    // trim the smoothing tails so distances are measured to where the bend really starts
    const cut = Math.max(opt.kMin, 0.25 * peak);
    let a = r.i0, b = r.i1;
    while (a < apex && Math.abs(kappa[a]) < cut) a++;
    while (b > apex && Math.abs(kappa[b]) < cut) b--;

    const rMin = 1 / peak;
    const rEff = effectiveRadius(rMin, angle, opt.lineWidth);
    let grade = gradeFor(rEff, angle);
    if (grade === null) {
      if (!opt.flats || rEff >= opt.flatLimit) continue;
      grade = 'F'; // gentle bend: "flat" if it lasts, "kink" if it's short
    }

    // entry vs exit severity -> tightens / opens
    const len = b - a + 1, third = Math.max(1, Math.round(len * 0.35));
    const avg = (from, to) => { let s = 0; for (let i = from; i <= to; i++) s += Math.abs(kappa[i]); return s / (to - from + 1); };
    const kIn = avg(a, a + third - 1), kOut = avg(b - third + 1, b);
    const gIn = gradeFor(effectiveRadius(1 / kIn, angle, opt.lineWidth), angle);
    const gOut = gradeFor(effectiveRadius(1 / kOut, angle, opt.lineWidth), angle);
    const sStart = samples[a].s, sEnd = samples[Math.min(b + 1, samples.length - 1)].s;

    // Square / acute: a tight or abrupt 65-135° turn (street corners, junction-like bends) is NOT
    // a "left 2" — and a very tight 90° is not a hairpin either. Call its shape.
    const spanM = samples[Math.min(b + 1, samples.length - 1)].s - samples[a].s;
    let shape = null;
    if (grade !== 'F' && angle >= 65 && angle < 135 && (grade === 'H' || gradeNum(grade) <= 2 || spanM <= 40)) {
      shape = angle < 120 ? 'square' : 'acute';
      if (grade === 'H') grade = 1;
    }

    const mods = [];
    const real = grade !== 'H' && grade !== 'F' && !shape;
    let callGrade = grade, toGrade = null;

    // double apex: two clear curvature peaks with a real easing between them
    let dbl = false;
    if (real) {
      const k = (i) => Math.abs(kappa[i]), pk = [];
      for (let i = a + 1; i < b; i++) if (k(i) >= k(i - 1) && k(i) > k(i + 1) && k(i) >= 0.6 * peak) pk.push(i);
      for (let x = 0; x < pk.length && !dbl; x++) for (let y = x + 1; y < pk.length; y++) {
        if ((pk[y] - pk[x]) * step < 25) continue;
        let mn = Infinity; for (let i = pk[x]; i <= pk[y]; i++) mn = Math.min(mn, k(i));
        if (mn < 0.55 * Math.min(k(pk[x]), k(pk[y]))) { dbl = true; break; }
      }
    }
    if (dbl) mods.push('double apex');
    else if (real && len * step >= 30) {
      // called as the entry grade, with where it ends up: "left 5, tightens 3" / "right 2, opens 4"
      const nIn = gIn === null ? 7 : gradeNum(gIn), nOut = gOut === null ? 7 : gradeNum(gOut);
      if (kOut > kIn * 1.5 && nOut < nIn) { mods.push('tightens'); callGrade = gIn ?? 6; toGrade = grade; }
      else if (kIn > kOut * 1.5 && nIn < nOut) { mods.push('opens'); toGrade = gOut; }
    }
    const lengthM = sEnd - sStart;
    if (real && (angle >= 200 || (lengthM >= 300 && angle >= 90))) mods.push('very long');
    else if (real && (angle >= 135 || (lengthM >= 150 && angle >= 90))) mods.push('long');
    if (real && gradeNum(grade) <= 4 && angle < 40) mods.push('short');
    // apex position along the bend (when it isn't already a tightens / double apex)
    const f = (apex - a) / Math.max(1, b - a);
    if (real && !mods.some((m) => ['tightens', 'opens', 'double apex', 'short'].includes(m)) && len * step >= 40 && f > 0.68) mods.push('late');
    if (grade === 'H' || (grade === 1 && angle >= 90 && !shape)) mods.push("don't cut");

    corners.push({
      kind: 'corner', dir: r.sign > 0 ? 'left' : 'right', grade: callGrade, peakGrade: grade, mods, shape, kink: grade === 'F' && lengthM < 60,
      angle: Math.round(angle), rMin: Math.round(rMin), rEff: Math.round(rEff),
      exitGrade: toGrade, sStart, sEnd, sApex: samples[apex].s,
      lat: samples[apex].lat, lon: samples[apex].lon,
    });
  }
  return corners;
}

// ---------- junctions (OSRM route steps) ----------

const ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];

function nearestS(samples, lat, lon, fromIdx) {
  let best = Infinity, bi = fromIdx;
  for (let i = fromIdx; i < samples.length; i++) {
    const d = segLen([lat, lon], [samples[i].lat, samples[i].lon]);
    if (d < best) { best = d; bi = i; }
    // found it and moved well past: stop (never run on into a later lap)
    if (best < 15 && d > best + 150) break;
  }
  return { idx: bi, dist: best };
}

// Where along the route is this step? OSRM gives each step's length, so the distance
// already travelled says roughly where to look; search ±150 m around that.
function locateStep(samples, st, fromIdx) {
  const m = st.maneuver;
  if (st._s != null) {
    const step = samples[1].s - samples[0].s;
    const c = Math.round(st._s / step);
    let best = Infinity, bi = -1;
    for (let i = Math.max(0, c - 30); i <= Math.min(samples.length - 1, c + 30); i++) {
      const d = segLen([m.location[1], m.location[0]], [samples[i].lat, samples[i].lon]);
      if (d < best) { best = d; bi = i; }
    }
    if (bi >= 0 && best < 25) return { idx: bi, dist: best };
  }
  return nearestS(samples, m.location[1], m.location[0], fromIdx);
}

// Distance along the route of each step's manoeuvre, from OSRM step lengths (scaled to our length).
export function stepPositions(steps, total) {
  if (!steps?.length || steps.some((st) => typeof st.distance !== 'number')) return steps;
  const sum = steps.reduce((a, st) => a + st.distance, 0), k = sum > 0 ? total / sum : 1;
  let acc = 0;
  return steps.map((st) => { const o = { ...st, _s: acc * k }; acc += st.distance; return o; });
}

// Turn angle actually driven through sample idx: heading over the 40 m before vs the 40 m after.
function turnAt(samples, idx) {
  const n = samples.length, k = 8;
  const i0 = Math.max(0, idx - k), i1 = Math.min(n - 1, idx + k);
  if (i1 - i0 < 4) return null;
  // road heading where the window starts vs where it ends = the whole turn inside it
  const a = samples[i0], a2 = samples[i0 + 1], c2 = samples[i1 - 1], c = samples[i1];
  const h1 = bearing([a.lat, a.lon], [a2.lat, a2.lon]), h2 = bearing([c2.lat, c2.lon], [c.lat, c.lon]);
  return ((h2 - h1 + 540) % 360) - 180; // + right
}

// Junction shape from the turn angle: keep / graded like a corner / square / acute / hairpin.
export function junctionShape(abs) {
  if (abs < 25) return 'keep';
  if (abs < 65) return 'graded';
  if (abs < 120) return 'square';
  if (abs < 135) return 'acute';
  return 'hairpin';
}

function junctionNotes(samples, steps, corners, opt = {}) {
  const out = [], suppress = [];
  let from = 0;
  junctionNotes.inTunnel = false;
  steps.forEach((st, k) => {
    const m = st.maneuver;
    if (!m || !m.location) return;
    const { idx } = locateStep(samples, st, from);
    from = Math.min(idx + 1, samples.length - 1); // repeated laps: never match the same spot twice
    const s = samples[idx].s, lat = samples[idx].lat, lon = samples[idx].lon;
    // tunnels: OSRM tags intersections inside one with the 'tunnel' class
    for (const ix of st.intersections || []) {
      const inT = (ix.classes || []).includes('tunnel');
      if (inT && !junctionNotes.inTunnel && ix.location) {
        const t = nearestS(samples, ix.location[1], ix.location[0], idx).idx, ts = samples[t].s;
        out.push({ kind: 'feature', dir: null, mods: [], text: 'tunnel', sStart: ts - 10, sEnd: ts + 10, sApex: ts, lat: samples[t].lat, lon: samples[t].lon });
      }
      junctionNotes.inTunnel = inT;
    }
    const osrmTurn = ((m.bearing_after - m.bearing_before + 540) % 360) - 180; // + right
    // OSRM bearings only look at the very first metres of each road; the route
    // geometry tells us what the driver will really feel.
    const geo = turnAt(samples, idx);
    const turn = geo ?? osrmTurn;
    const dir = turn >= 0 ? 'right' : 'left';
    const abs = Math.abs(turn);
    // the geometry corner (if any) that this junction sits in
    const corner = corners.find((c) => c.dir === dir && c.sStart - 30 < s && c.sEnd + 30 > s);
    const base = { kind: 'junction', dir, angle: Math.round(abs), sStart: s - 8, sEnd: s + 8, sApex: s, lat, lon, mods: [] };
    // street names (optional): "…, onto Boston Road" / exits "…, toward Harlem River Drive"
    const road = (st.name || st.ref || '').split(';')[0].trim().slice(0, 40);
    const dest = (st.destinations || '').split(',')[0].split(':').pop().trim().slice(0, 40);
    const onto = !opt.streets ? '' : m.type === 'off ramp' ? (dest ? `, toward ${dest}` : road ? `, onto ${road}` : '') : road ? `, onto ${road}` : '';
    const side = (m.modifier || '').includes('left') ? 'left' : (m.modifier || '').includes('right') ? 'right' : dir;

    switch (m.type) {
      case 'turn': case 'continue': case 'end of road': {
        if (m.type === 'continue' && abs < 45) return;
        if (m.type === 'turn' && abs < 10 && Math.abs(osrmTurn) < 20) return;
        const where = m.type === 'end of road' ? 'T junction' : 'at junction';
        let shape = junctionShape(abs), what;
        if (shape === 'graded') {
          const g = corner && corner.grade !== 'H' && corner.grade !== 'F' ? corner.grade : abs < 40 ? 5 : 4;
          what = `${dir} ${showGrade(g, opt)}`; base.grade = g;
        } else what = shape === 'keep' ? `keep ${side}` : `${shape} ${shape === 'keep' ? side : dir}`;
        if (shape === 'keep') base.dir = side;
        if (corner) { base.sStart = Math.min(base.sStart, corner.sStart); base.sEnd = Math.max(base.sEnd, corner.sEnd); }
        out.push({ ...base, shape, text: `${where}, ${what}${onto}`, street: road || null });
        break;
      }
      case 'fork': out.push({ ...base, dir: side, shape: 'keep', text: `fork, keep ${side}${onto}` }); break;
      case 'merge': out.push({ ...base, dir: side, shape: 'keep', text: `merge ${side}${onto}` }); break;
      case 'on ramp': out.push({ ...base, dir: side, shape: 'keep', text: `slip road ${side}${onto}` }); break;
      case 'off ramp': out.push({ ...base, dir: side, shape: 'keep', text: `exit ${side}${onto}` }); break;
      case 'roundabout': case 'rotary': case 'roundabout turn': {
        const ex = m.exit ? `, ${ORD[m.exit - 1] || m.exit + 'th'} exit` : '';
        out.push({ ...base, dir: null, shape: 'roundabout', text: `roundabout${ex}${onto}` });
        const next = steps[k + 1];
        const exitS = next?.maneuver?.location ? nearestS(samples, next.maneuver.location[1], next.maneuver.location[0], idx).idx : idx;
        suppress.push([s - 25, samples[exitS].s + 25]);
        break;
      }
      case 'arrive': out.push({ ...base, kind: 'finish', dir: null, angle: null, shape: 'finish', text: 'finish', sStart: s, sEnd: s }); break;
      default: return; // depart, new name, notification, exit roundabout...
    }
    if (m.type !== 'arrive') suppress.push([s - 30, s + 30, out.at(-1)?.dir || null, s]);
  });
  return { notes: out, suppress };
}

// ---------- text ----------

// Some crews run the scale the other way round (1 = fastest).
export const showGrade = (g, o = {}) => (o.reverse && typeof g === 'number' ? 7 - g : g);

export function noteText(n, o = {}) {
  const m = n.mods || [];
  let core;
  if (n.text) core = n.text;
  else if (n.chicane) core = `chicane ${n.chicane}`;
  else if (n.shape) core = `${n.shape} ${n.dir}` + (m.includes('over crest') ? ' over crest' : '');
  else {
    const g = n.grade;
    core = g === 'H' ? `hairpin ${n.dir}` : g === 'F' ? `${n.kink ? 'kink' : 'flat'} ${n.dir}` : `${n.dir} ${showGrade(g, o)}`;
    if (m.includes('over crest')) core += ' over crest';
    if (m.includes('very long')) core += ', very long'; else if (m.includes('long')) core += ', long';
    if (m.includes('short')) core += ', short';
    const to = n.exitGrade === 'H' ? 'hairpin' : n.exitGrade == null ? '' : ' ' + showGrade(n.exitGrade, o);
    if (m.includes('tightens')) core += ', tightens' + (to === 'hairpin' ? ' to hairpin' : to);
    if (m.includes('opens')) core += ', opens' + (to === 'hairpin' ? '' : to);
    if (m.includes('double apex')) core += ', double apex';
    if (m.includes('late')) core += ', late';
    if (m.includes("don't cut")) core += ", don't cut";
  }
  const pre = m.includes('double caution') ? 'double caution, ' : m.includes('caution') ? 'caution, '
    : m.includes('hard brake') ? 'hard brake, ' : m.includes('brake') ? 'brake, ' : '';
  const extra = (n.extra || []).filter((w) => !core.includes(w) && !pre.includes(w));
  return pre + core + (extra.length ? ', ' + extra.join(', ') : '');
}

const round50 = (v) => Math.max(50, Math.round(v / 50) * 50);
// Link from one note to the next given the straight between them.
export function linkFor(gapM, units = 'metric') {
  if (gapM == null) return { type: 'none', say: '' };
  if (gapM < 20) return { type: 'into', say: 'into' };
  if (gapM < 45) return { type: 'and', say: 'and' };
  if (gapM < 75) return { type: 'then', say: 'then' };
  if (units === 'imperial') {
    const yd = gapM * 1.09361;
    if (yd < 175) return { type: 'dist', say: String(round50(yd)) };
    if (yd < 800) return { type: 'dist', say: String(Math.round(yd / 100) * 100) };
    if (yd < 1300) return { type: 'dist', say: 'half mile' };
    if (yd < 2200) return { type: 'dist', say: '1 mile' };
    return { type: 'dist', say: 'long straight' };
  }
  if (gapM < 175) return { type: 'dist', say: String(round50(gapM)) };
  if (gapM < 950) return { type: 'dist', say: String(Math.round(gapM / 100) * 100) };
  if (gapM < 1500) return { type: 'dist', say: '1 k' };
  if (gapM < 2500) return { type: 'dist', say: '2 k' };
  return { type: 'dist', say: 'long straight' };
}

// Join notes[i..j] into one breath, co-driver style. Trailing distance included.
export function chainText(notes, i, j, units = 'metric') {
  let out = '';
  for (let k = i; k <= j; k++) {
    const n = notes[k];
    out += n.label ?? noteText(n);
    const l = linkFor(n.gapNext, units);
    if (l.type === 'none') break;
    if (k < j) out += l.type === 'dist' ? `, ${l.say}, ` : ` ${l.say} `;
    else out += l.type === 'dist' ? `, ${l.say}` : ` ${l.say}`;
  }
  return out.charAt(0).toUpperCase() + out.slice(1);
}

// ---------- speed model (also used by the simulator) ----------

// Plausible speed along the route: limited by corner grip, acceleration and braking.
export function speedProfile(samples, kappa, vmax, { aLat = 5.5, aAcc = 2.5, aDec = 5, loop = false, forwardOnly = false } = {}) {
  const n = samples.length;
  const v = samples.map((_, i) => Math.min(vmax, Math.sqrt(aLat / Math.max(Math.abs(kappa[i]), 1e-6))));
  if (forwardOnly) { // speed you'd carry if you never braked early: grip + acceleration only
    for (let i = 1; i < n; i++) v[i] = Math.min(v[i], Math.sqrt(v[i - 1] ** 2 + 2 * aAcc * (samples[i].s - samples[i - 1].s)));
    return v;
  }
  if (loop) { // no stop at the ends: run the passes round the lap twice
    const ds = (i) => Math.max(0.1, samples[(i + 1) % n].s - samples[i].s || samples[1].s);
    for (let r = 0; r < 2 * n; r++) { const i = r % n, p = (i - 1 + n) % n; v[i] = Math.min(v[i], Math.sqrt(v[p] ** 2 + 2 * aAcc * ds(p))); }
    for (let r = 2 * n; r > 0; r--) { const i = r % n, q = (i + 1) % n; v[i] = Math.min(v[i], Math.sqrt(v[q] ** 2 + 2 * aDec * ds(i))); }
    return v;
  }
  v[0] = 0;
  for (let i = 1; i < n; i++) v[i] = Math.min(v[i], Math.sqrt(v[i - 1] ** 2 + 2 * aAcc * (samples[i].s - samples[i - 1].s)));
  v[n - 1] = 0;
  for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * aDec * (samples[i + 1].s - samples[i].s)));
  return v;
}

// ---------- elevation: crests and dips ----------

/**
 * Crests and dips from an elevation profile [{s, z}] (any spacing).
 * Looks at the change of gradient across ±60 m: going from climbing to falling is a crest.
 */
export function verticalFeatures(elev) {
  if (!elev || elev.length < 4) return [];
  const step = 10, total = elev[elev.length - 1].s, z = [];
  let j = 0;
  for (let s = 0; s <= total; s += step) {
    while (j < elev.length - 2 && elev[j + 1].s < s) j++;
    const a = elev[j], b = elev[j + 1], t = b.s > a.s ? Math.min(1, Math.max(0, (s - a.s) / (b.s - a.s))) : 0;
    z.push(a.z + (b.z - a.z) * t);
  }
  const zs = gaussianSmooth(z, 3);
  const g = zs.map((_, i) => (zs[Math.min(zs.length - 1, i + 1)] - zs[Math.max(0, i - 1)]) / (2 * step));
  const W = 6, dg = g.map((_, i) => {
    if (i < W || i >= g.length - W) return 0;
    let up = 0, dn = 0;
    for (let k = 1; k <= W; k++) { up += g[i + k]; dn += g[i - k]; }
    return (up - dn) / W;
  });
  const out = [];
  for (let i = 1; i < dg.length - 1; i++) {
    const d = dg[i];
    const isMin = d < -0.035 && d <= dg[i - 1] && d <= dg[i + 1];
    const isMax = d > 0.045 && d >= dg[i - 1] && d >= dg[i + 1];
    if (!isMin && !isMax) continue;
    const f = isMin
      ? { type: 'crest', size: d < -0.10 ? 'big' : d < -0.055 ? '' : 'small', s: i * step, strength: -d }
      : { type: 'dip', size: d > 0.12 ? 'big' : '', s: i * step, strength: d };
    const prev = out[out.length - 1];
    if (prev && f.s - prev.s < 150) { if (f.strength > prev.strength) out[out.length - 1] = f; continue; }
    out.push(f);
  }
  return out;
}

// ---------- notes the map can't know: recce ----------

// Words the crew can add on a recce drive (tap a note, or "+" while driving).
export const RECCE_WORDS = {
  Hazard: ['caution', 'double caution', 'danger', 'care', 'maybe'],
  Line: ["don't cut", 'cut', 'cut late', 'keep left', 'keep middle', 'keep right', 'brake', 'hard brake'],
  Road: ['crest', 'big crest', 'jump', 'big jump', 'dip', 'compression', 'bumps', 'bad bumps', 'narrows', 'widens', 'camber', 'off camber'],
  Surface: ['slippy', 'loose', 'gravel', 'tarmac', 'mud', 'snow', 'ice', 'water', 'ford', 'ruts'],
  Roadside: ['rocks', 'stones', 'ditch', 'bank', 'wall', 'trees', 'logs', 'posts', 'drop', 'big drop', 'exposure', 'gate'],
  Feature: ['bridge', 'over bridge', 'tunnel', 'junction'],
  Side: ['inside', 'outside'],
};

// ---------- decorating notes ----------

function sampleAt(samples, s, step) {
  return samples[Math.max(0, Math.min(samples.length - 1, Math.round(s / step)))];
}

// Grade calibration: shift every numbered call by offset (−1 = call tighter, +1 = call faster), 1..6.
const shiftGrade = (g, off) => (typeof g === 'number' && off ? Math.max(1, Math.min(6, g + off)) : g);

/**
 * Your corrections: [{ id, lat, lon, grade?: 1..6|'H'|'F', shape?: 'square'|'acute', none?: true,
 *   add?: true, dir?: 'left'|'right' }].
 * A fix applies to the corner (or junction) within 25 m of where it was made, on any route that passes.
 * add: a call you added where the app had none (placed on the route within 30 m).
 */
function applyFixes(notes, samples, opt) {
  const off = opt.gradeOffset || 0;
  for (const fx of opt.fixes || []) {
    if (fx.add) {
      const near = notes.find((n) => (n.kind === 'corner' || n.kind === 'junction') && segLen([fx.lat, fx.lon], [n.lat, n.lon]) < 15);
      if (!near) {
        let bi = -1, bd2 = 30;
        for (let i = 0; i < samples.length; i++) { const d = segLen([fx.lat, fx.lon], [samples[i].lat, samples[i].lon]); if (d < bd2) { bd2 = d; bi = i; } }
        if (bi < 0) continue; // not on this route
        const at = samples[bi];
        notes.push({ kind: 'corner', dir: fx.dir, grade: fx.shape ? 1 : fx.grade, shape: fx.shape, mods: [], kink: false, angle: null,
          sStart: Math.max(0, at.s - 10), sEnd: at.s + 10, sApex: at.s, lat: at.lat, lon: at.lon, fixed: fx.id, added: true });
        continue;
      }
    }
    let best = null, bd = 25;
    for (const n of notes) {
      if (n.kind !== 'corner' && n.kind !== 'junction') continue;
      const d = segLen([fx.lat, fx.lon], [n.lat, n.lon]);
      if (d < bd) { bd = d; best = n; }
    }
    if (!best) continue;
    best.fixed = fx.id;
    if (fx.none) { best.removed = true; continue; }
    best.kind = 'corner'; delete best.text; // a fixed junction is called like a corner
    if (fx.dir) best.dir = fx.dir;
    if (fx.shape) { best.shape = fx.shape; best.grade = 1; }
    else { delete best.shape; delete best.chicane; best.grade = fx.grade; }
    best.kink = fx.grade === 'F' && best.kink;
    best.mods = best.mods.filter((m) => !['tightens', 'opens', 'short', 'late'].includes(m));
    best.exitGrade = null;
  }
  for (let i = notes.length - 1; i >= 0; i--) if (notes[i].removed) notes.splice(i, 1);
  notes.sort((a, b) => a.sStart - b.sStart);
  if (off) for (const n of notes) {
    if (n.kind !== 'corner' || n.fixed) continue;
    n.grade = shiftGrade(n.grade, off);
    n.exitGrade = shiftGrade(n.exitGrade, off);
  }
}

function decorate(notes, samples, kappa, opt) {
  const step = opt.step;
  const inCorner = (s, pad = 10) => notes.find((n) => n.kind === 'corner' && s >= n.sStart - pad && s <= n.sEnd + pad);

  // your own corrections ("that call was wrong"), pinned by location, then the overall calibration
  applyFixes(notes, samples, opt);

  // crests & dips
  for (const f of verticalFeatures(opt.elevation)) {
    const c = inCorner(f.s);
    if (f.type === 'crest') {
      if (c) { if (!c.mods.includes('over crest')) c.mods.push('over crest'); }
      // a tight corner straight after a crest is blind
      for (const n of notes) if (n.kind === 'corner' && n.sStart > f.s && n.sStart - f.s <= 100 && gradeNum(n.peakGrade ?? n.grade) <= 3)
        n.mods.push(gradeNum(n.peakGrade ?? n.grade) <= 2 ? 'double caution' : 'caution');
      if (c) continue;
    } else if (c) continue;
    if (notes.some((n) => Math.abs(n.sApex - f.s) < 20)) continue;
    const p = sampleAt(samples, f.s, step);
    const text = (f.size ? f.size + ' ' : '') + f.type;
    notes.push({ kind: 'vertical', dir: null, mods: [], text, sStart: f.s - 15, sEnd: f.s + 15, sApex: f.s, lat: p.lat, lon: p.lon });
  }

  // tightens into something nasty
  for (const n of notes) {
    if (!n.mods.includes('tightens')) continue;
    const t = n.exitGrade;
    if (t === 'H' || t === 1) n.mods.push('double caution');
    else if (gradeNum(t) <= 2) n.mods.push('caution');
  }

  // brake / hard brake: speed you'd be carrying in (no early braking) vs. what the corner allows
  const vGrip = speedProfile(samples, kappa, 100 / 3.6, { forwardOnly: true });
  for (const n of opt.bike ? [] : notes) { // no brake calls on a bike
    if (n.kind !== 'corner' || n.grade === 'F' || n.mods.some((m) => m.includes('caution'))) continue;
    const i0 = Math.max(0, Math.round(n.sStart / step)), i1 = Math.min(vGrip.length - 1, Math.round(n.sEnd / step));
    const vIn = vGrip[Math.max(0, i0 - 2)];
    let vc = Infinity; for (let i = i0; i <= i1; i++) vc = Math.min(vc, Math.sqrt(5.5 / Math.max(Math.abs(kappa[i]), 1e-6)));
    const drop = (vIn - Math.min(vc, vIn)) * 3.6;
    if (drop > 80) n.mods.unshift('hard brake'); else if (drop > 50) n.mods.unshift('brake');
  }

  // Pin things at a lat/lon onto the route: join the corner/junction they fall in, else stand alone.
  const pin = (lat, lon, maxDist) => {
    let best = Infinity, bi = 0;
    for (let i = 0; i < samples.length; i++) {
      const d = segLen([lat, lon], [samples[i].lat, samples[i].lon]);
      if (d < best) { best = d; bi = i; }
    }
    if (best > maxDist) return null; // not on this route
    const s = samples[bi].s;
    return { s, i: bi, host: inCorner(s, 15) || notes.find((n) => Math.abs(n.sApex - s) < 20) };
  };
  const standalone = (kind, text, at, extra = {}) => notes.push({ kind, dir: null, mods: [], text, sStart: at.s - 10, sEnd: at.s + 10, sApex: at.s, lat: samples[at.i].lat, lon: samples[at.i].lon, ...extra });

  // recce notes
  for (const r of opt.recce || []) {
    const at = pin(r.lat, r.lon, 25); if (!at) continue;
    if (at.host) { at.host.extra = [...(at.host.extra || []), ...r.words]; (at.host.recce ||= []).push(r.id); }
    else standalone('recce', r.words.join(' '), at, { recce: [r.id] });
  }

  // speed cameras (OpenStreetMap highway=speed_camera), optional
  for (const c of opt.cameras || []) {
    const at = pin(c.lat, c.lon, 40); if (!at) continue;
    const words = ['speed camera', ...(c.maxspeed ? [`limit ${c.maxspeed}`] : [])];
    if (at.host && !at.host.cams) { at.host.extra = [...(at.host.extra || []), ...words]; at.host.cams = [[c.lat, c.lon]]; }
    else if (!at.host) standalone('camera', words.join(', '), at, { cams: [[c.lat, c.lon]] });
  }

  // calls you removed that aren't corners (crest, dip, camera, tunnel): drop them too
  for (const fx of opt.fixes || []) {
    if (!fx.none) continue;
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      if (['vertical', 'camera', 'feature'].includes(n.kind) && segLen([fx.lat, fx.lon], [n.lat, n.lon]) < 25) notes.splice(i, 1);
    }
  }
  notes.sort((a, b) => a.sStart - b.sStart);
  return chicanes(notes);
}

// Quick direction changes: two or more short alternating bends linked "into".
function chicanes(notes) {
  const ok = (n) => n && n.kind === 'corner' && !n.chicane && !n.shape && n.grade !== 'H' && gradeNum(n.grade) >= 3 && n.angle <= 45 && !n.extra;
  const out = [];
  for (let i = 0; i < notes.length; i++) {
    let j = i;
    while (ok(notes[j]) && ok(notes[j + 1]) && notes[j + 1].dir !== notes[j].dir &&
      notes[j + 1].sStart - notes[j].sEnd < 20 && notes[j + 1].sEnd - notes[i].sStart <= 110) j++;
    if (j > i) {
      const run = notes.slice(i, j + 1);
      out.push({ ...run[0], chicane: run.map((n) => n.dir).join(' '), mods: [], sEnd: run.at(-1).sEnd, exitGrade: null,
        grade: Math.min(...run.map((n) => gradeNum(n.grade))), angle: Math.max(...run.map((n) => n.angle)) });
      i = j;
    } else out.push(notes[i]);
  }
  return out;
}

// ---------- main ----------

function rawNotes(samples, kappa, steps, opt) {
  let corners = findCorners(samples, kappa, opt);
  let junctions = [];
  if (steps && steps.length) {
    const j = junctionNotes(samples, steps, corners, opt);
    junctions = j.notes;
    // a junction replaces its own corner, not the bend the other way right after it (S-bends)
    corners = corners.filter((c) => !j.suppress.some(([a, b, dir, at]) => c.sEnd > a && c.sStart < b &&
      (!dir || c.dir === dir || Math.abs(c.sApex - at) < 12)));
  }
  return [...corners, ...junctions].sort((a, b) => a.sStart - b.sStart);
}

function finalize(notes, loopLength, opt = {}) {
  notes.forEach((note, i) => {
    const next = notes[i + 1];
    let gapNext = next ? next.sStart - note.sEnd : null;
    if (loopLength && !next) gapNext = notes[0].sStart + loopLength - note.sEnd; // wrap round the start line
    note.id = i;
    note.gapNext = gapNext == null ? null : Math.max(0, gapNext);
    note.mods = [...new Set(note.mods || [])];
  });
  notes.forEach((note) => { note.label = noteText(note, opt); });
  return notes;
}

/**
 * @param {Array<[lat,lon]>} points route polyline
 * @param {object} [o] { steps: OSRM steps (optional), loop: closed circuit, ...DEFAULTS overrides }
 * @returns {{ samples, kappa, total, notes, loop }}
 */
export function generatePaceNotes(points, o = {}) {
  const opt = { ...DEFAULTS, ...o };
  if (o.loop) return generateLoop(points, opt);
  const { samples, total } = resample(points, opt.step);
  const kappa = curvature(samples, opt);
  const notes = decorate(rawNotes(samples, kappa, stepPositions(o.steps, total), opt), samples, kappa, opt);
  if (!notes.some((n) => n.kind === 'finish')) {
    const L = samples[samples.length - 1];
    notes.push({ kind: 'finish', dir: null, text: 'finish', mods: [], sStart: total, sEnd: total, sApex: total, lat: L.lat, lon: L.lon });
  }
  return { samples, kappa, total, notes: finalize(notes, 0, opt), loop: false };
}

// Closed circuit: analyse three laps back to back and keep the notes from the
// middle one, so corners that straddle the start line are measured properly.
function generateLoop(points, opt) {
  const pts = points.slice();
  if (segLen(pts[0], pts[pts.length - 1]) > 1) pts.push(pts[0]);
  const { samples, total: L } = resample(pts, opt.step);
  const triple = [...pts, ...pts.slice(1), ...pts.slice(1)];
  const lapSteps = (stepPositions(opt.steps, L) || []).filter((s) => !['arrive', 'depart'].includes(s.maneuver?.type));
  const lapAt = (c) => lapSteps.map((st) => (st._s == null ? st : { ...st, _s: st._s + c * L }));
  const tri = resample(triple, opt.step);
  const kTri = curvature(tri.samples, opt);
  const notes = rawNotes(tri.samples, kTri, [...lapAt(0), ...lapAt(1), ...lapAt(2)], opt)
    .filter((n) => n.kind !== 'finish' && n.sStart >= L && n.sStart < 2 * L)
    .map((n) => ({ ...n, sStart: n.sStart - L, sEnd: n.sEnd - L, sApex: n.sApex - L }));
  const kappa = samples.map((p) => kTri[Math.min(kTri.length - 1, Math.round((p.s + L) / opt.step))]);
  const deco = decorate(notes, samples, kappa, { ...opt, loop: true });
  return { samples, kappa, total: L, notes: finalize(deco, L, opt), loop: true };
}
