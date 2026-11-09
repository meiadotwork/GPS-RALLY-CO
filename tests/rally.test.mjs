import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePaceNotes, linkFor, chainText, gradeFor, effectiveRadius } from '../pacenotes.js';
import { RouteTracker, CallScheduler, DriveSim } from '../navcore.js';
import { buildStage, STAGE } from '../sample-route.js';

const stage = buildStage();
const gen = generatePaceNotes(stage.points, { steps: stage.steps });

test('demo stage notes match the designed geometry', () => {
  const want = STAGE.map((s) => s[3]).filter((x) => x && !x.startsWith('(')).concat('finish');
  assert.deepEqual(gen.notes.map((n) => n.label), want);
});

test('links: into / and / distances', () => {
  const links = gen.notes.map((n) => linkFor(n.gapNext).say);
  assert.equal(links[1], 'into');   // left 4 -> right 3, 12 m apart
  assert.equal(links[3], 'and');    // left 3 tightens -> hairpin, 40 m
  assert.equal(links[0], '100');
  assert.equal(linkFor(60).say, 'then');
  assert.equal(linkFor(300, 'imperial').say, '300');
  assert.equal(linkFor(1000, 'imperial').say, 'half mile');
});

test('grading scale', () => {
  assert.equal(gradeFor(effectiveRadius(9, 175), 175), 'H');
  assert.equal(gradeFor(effectiveRadius(30, 90), 90), 3);
  assert.equal(gradeFor(effectiveRadius(60, 15), 15), null); // flat kink
  assert.equal(chainText(gen.notes, 1, 2, 'metric', { distances: true }), 'Left 4 into right 3, 200');
});

test('faster driving triggers calls earlier', () => {
  const avgLead = (cap) => {
    const sim = new DriveSim(gen.samples, gen.kappa, cap / 3.6), sch = new CallScheduler(gen.notes);
    const d = [];
    while (!sim.done) { const f = sim.tick(0.5); const c = sch.update(f.s, f.speed); if (c) d.push(c.distToNote); }
    return d.reduce((a, b) => a + b) / d.length;
  };
  assert.ok(avgLead(120) > avgLead(60) * 1.2);
});

test('tracker detects off-route offset', () => {
  const t = new RouteTracker(gen.samples);
  const p = gen.samples[100];
  assert.ok(t.locate(p.lat, p.lon).offset < 1);
  assert.ok(t.locate(p.lat + 0.001, p.lon).offset > 50); // ~110 m north
});

test('circuit: notes wrap the start line and calls keep coming lap after lap', () => {
  const loop = generatePaceNotes(stage.points, { steps: stage.steps, loop: true });
  assert.equal(loop.loop, true);
  assert.ok(!loop.notes.some((n) => n.kind === 'finish'));
  const last = loop.notes.at(-1);
  assert.ok(last.gapNext != null && last.gapNext >= 0); // links round to the first corner
  const sim = new DriveSim(loop.samples, loop.kappa, 90 / 3.6, { loop: true, laps: 3 });
  const tr = new RouteTracker(loop.samples, true);
  const sch = new CallScheduler(loop.notes, { loopLength: loop.total });
  let sU = null, lastS = 0, calls = 0;
  while (!sim.done) {
    const f = sim.tick(0.5), s = tr.locate(f.lat, f.lon).s;
    if (sU == null) sU = s; else { let d = s - lastS; if (d < -loop.total / 2) d += loop.total; sU += d; }
    lastS = s;
    if (sch.update(sU, f.speed)) calls++;
  }
  assert.ok(sU > 2.9 * loop.total);
  const perLap = new Set(loop.notes.map((n) => n.id)).size;
  assert.ok(calls >= 2.5 * Math.ceil(perLap / 4), `only ${calls} calls in 3 laps`);
});

// A Y junction where the route bears ~35° right onto a curving road (the Bronx
// Southern Blvd / Boston Rd case) must not be called "square".
import { offsetPoint, junctionShape } from '../pacenotes.js';
function yJunction(turnDeg, R) {
  let p = [40.8380, -73.8870], brg = 0;
  const pts = [p];
  for (let i = 0; i < 8; i++) { p = offsetPoint(p, brg, 25); pts.push(p); }
  const node = p, before = brg;
  const L = (R * turnDeg * Math.PI) / 180;
  for (let d = 0; d < L; d += 8) { const seg = Math.min(8, L - d); p = offsetPoint(p, brg + (seg / R) * 90 / Math.PI, seg); brg += (seg / R) * 180 / Math.PI; pts.push(p); }
  for (let i = 0; i < 8; i++) { p = offsetPoint(p, brg, 25); pts.push(p); }
  const steps = [{ maneuver: { type: 'turn', modifier: 'slight right', location: [node[1], node[0]], bearing_before: before, bearing_after: 90 } }];
  return generatePaceNotes(pts, { steps }).notes.map((n) => n.label);
}

test('junction calls follow the real shape of the turn', () => {
  assert.match(yJunction(35, 60)[0], /^at junction, right [56]$/);
  assert.match(yJunction(90, 8)[0], /square right/);
  assert.match(yJunction(160, 8)[0], /hairpin right/);
  assert.equal(junctionShape(15), 'keep');
  assert.equal(junctionShape(128), 'acute');
  assert.equal(junctionShape(140), 'hairpin');
});

test('gentle bends are called as flat / kink, and can be switched off', () => {
  const labels = gen.notes.map((n) => n.label);
  assert.ok(labels.includes('kink left'));
  const quiet = generatePaceNotes(stage.points, { steps: stage.steps, flats: false });
  assert.ok(!quiet.notes.some((n) => n.grade === 'F'));
});

test('vocabulary: crests from elevation, blind corners, reversed scale', () => {
  const withHills = generatePaceNotes(stage.points, { steps: stage.steps, elevation: stage.elevation });
  const L = withHills.notes.map((n) => n.label);
  assert.equal(L[0], 'right 6 over crest');
  assert.ok(L.includes('crest') && L.includes('dip'));
  assert.ok(L.includes('double caution, square left')); // tight corner straight after a crest
  const rev = generatePaceNotes(stage.points, { steps: stage.steps, reverse: true });
  assert.equal(rev.notes[0].label, 'right 1');
  assert.equal(rev.notes.find((n) => n.mods.includes('tightens')).label, 'left 2, tightens 4');
});

test('vocabulary: chicane and recce notes', () => {
  // two short opposite flicks back to back -> chicane
  let p = [45.0, 7.0], brg = 0; const pts = [p];
  const go = (d) => { for (let x = 0; x < d; x += 10) { p = offsetPoint(p, brg, 10); pts.push(p); } };
  const arc = (R, a) => { const L = R * Math.abs(a) * Math.PI / 180; for (let d = 0; d < L; d += 4) { const st = Math.min(4, L - d), dt = (st / R) * 180 / Math.PI * Math.sign(a); p = offsetPoint(p, brg + dt / 2, st); brg += dt; pts.push(p); } };
  go(300); arc(40, 35); go(8); arc(40, -35); go(300);
  const c = generatePaceNotes(pts).notes;
  assert.match(c[0].label, /^chicane right left/);
  // a recce note on a corner joins that call; one on a straight stands alone
  const apex = gen.notes[2], mid = gen.samples[Math.round(2700 / 5)];
  const r = generatePaceNotes(stage.points, { steps: stage.steps, recce: [
    { id: 'a', lat: apex.lat, lon: apex.lon, words: ['rocks', 'outside'] },
    { id: 'b', lat: mid.lat, lon: mid.lon, words: ['bumps'] }] });
  assert.ok(r.notes.some((n) => n.label === 'right 3, rocks, outside'));
  assert.ok(r.notes.some((n) => n.kind === 'recce' && n.label === 'bumps'));
});

import { segLen, bearing } from '../pacenotes.js';
import { encodePolyline, decodePolyline, specToHash, hashToSpec } from '../share.js';
test('share link round-trips the route, circuit flag and recce', () => {
  const via = [[40.83812, -73.88701], [40.84455, -73.88012], [40.85, -73.9]];
  assert.deepEqual(decodePolyline(encodePolyline(via)), via);
  const h = specToHash({ via }, { loop: true, recce: [{ lat: 40.8401, lon: -73.885, words: ['rocks', "don't cut"] }] });
  const back = hashToSpec('#' + h);
  assert.deepEqual(back.spec.via, via);
  assert.equal(back.loop, true);
  assert.deepEqual(back.recce[0].words, ['rocks', "don't cut"]);
  assert.equal(hashToSpec('#demo=1').spec.demo, true);
  assert.equal(hashToSpec('#nothing=1'), null);
});

test('speed cameras on the route are called, ones off it are ignored', () => {
  const on = gen.samples[Math.round(2700 / 5)], corner = gen.notes[1];
  const r = generatePaceNotes(stage.points, { steps: stage.steps, cameras: [
    { lat: on.lat, lon: on.lon, maxspeed: 50 },
    { lat: corner.lat, lon: corner.lon },
    { lat: on.lat + 0.01, lon: on.lon }] }); // ~1 km away
  assert.ok(r.notes.some((n) => n.kind === 'camera' && n.label === 'speed camera, limit 50'));
  assert.ok(r.notes.some((n) => n.label === 'left 4, speed camera'));
  assert.equal(r.notes.filter((n) => n.cams).length, 2);
});

// ---- regression: city-block 90° turns must be "square", never "left 2" / "hairpin" ----
// City-block circuit with OSRM-style steps: 90° turns at single nodes, plus a "new name" step 3 m after a turn.
function grid({ withSteps = true, dupe = true } = {}) {
  const legs = [[0, 420], [90, 260], [180, 420], [270, 260]];
  let p = [40.8300, -73.9250]; const pts = [p], corners = [];
  for (const [brg, d] of legs) { for (let x = 0; x < d; x += 30) { p = offsetPoint(p, brg, Math.min(30, d - x)); pts.push(p); } corners.push(p); }
  pts.pop(); pts.push(pts[0]); corners.pop();
  // steps with distances like OSRM
  const steps = []; let acc = 0, last = pts[0];
  const cum = []; let c = 0; pts.forEach((q, i) => { if (i) c += segLen(pts[i - 1], q); cum.push(c); });
  const at = (q) => cum[pts.findIndex((x) => x === q)];
  steps.push({ maneuver: { type: 'depart', location: [pts[0][1], pts[0][0]], bearing_before: 0, bearing_after: 0 } });
  const marks = [];
  corners.forEach((q, k) => {
    const i = pts.indexOf(q), b1 = bearing(pts[i - 1], q), b2 = bearing(q, pts[i + 1]);
    marks.push({ s: at(q), m: { type: 'turn', modifier: ((b2 - b1 + 540) % 360) - 180 > 0 ? 'right' : 'left', location: [q[1], q[0]], bearing_before: b1, bearing_after: b2 } });
    if (dupe && k === 1) { const q2 = offsetPoint(q, b2, 3); marks.push({ s: at(q) + 3, m: { type: 'new name', location: [q2[1], q2[0]], bearing_before: b2, bearing_after: b2 } }); }
  });
  marks.push({ s: c, m: { type: 'arrive', location: [pts[0][1], pts[0][0]], bearing_before: 0, bearing_after: 0 } });
  let prevS = 0;
  for (const mk of marks) { steps[steps.length - 1].distance = mk.s - prevS; steps.push({ maneuver: mk.m }); prevS = mk.s; }
  steps[steps.length - 1].distance = 0;
  return { pts, steps: withSteps ? steps : [] };
}

test('street-corner 90° turns are called square, with or without routing steps', () => {
  for (const loop of [false, true]) for (const withSteps of [true, false]) {
    const g = grid({ withSteps });
    const corners = generatePaceNotes(g.pts, { steps: g.steps, loop }).notes.filter((n) => n.kind !== 'finish');
    assert.equal(corners.length, loop ? 4 : 3, `loop=${loop} steps=${withSteps}`);
    for (const n of corners) assert.match(n.label, /square right$/, `loop=${loop} steps=${withSteps}: ${n.label}`);
  }
  // two OSRM steps at the same spot used to derail matching on circuits
  const g = grid(); const k = g.steps.findIndex((s) => s.maneuver.type === 'turn');
  const twice = [...g.steps.slice(0, k + 1), { ...g.steps[k], distance: 0, maneuver: { ...g.steps[k].maneuver, type: 'new name' } }, ...g.steps.slice(k + 1)];
  const n = generatePaceNotes(g.pts, { steps: twice, loop: true }).notes;
  assert.equal(n.filter((x) => x.label === 'at junction, square right').length, 3);
});

test('a very tight 90° is square, not hairpin; real hairpins stay hairpins', () => {
  const mk = (R, ang) => { let p = [45, 7], brg = 0; const pts = [p];
    for (let i = 0; i < 20; i++) { p = offsetPoint(p, brg, 15); pts.push(p); }
    const L = R * ang * Math.PI / 180; for (let d = 0; d < L; d += 2) { const st = Math.min(2, L - d), dt = (st / R) * 180 / Math.PI; p = offsetPoint(p, brg + dt / 2, st); brg += dt; pts.push(p); }
    for (let i = 0; i < 20; i++) { p = offsetPoint(p, brg, 15); pts.push(p); }
    return generatePaceNotes(pts).notes[0].label; };
  assert.match(mk(4, 90), /square right$/);
  assert.match(mk(15, 90), /square right$/);
  assert.match(mk(30, 90), /right 3$/);       // a proper open 90° bend keeps its grade
  assert.match(mk(9, 175), /hairpin right/);
  assert.match(mk(8, 125), /acute right$/);
});

test('street names at junctions are optional; route name travels in the link', () => {
  const said = generatePaceNotes(stage.points, { steps: stage.steps, streets: true }).notes.map((n) => n.label);
  assert.ok(said.includes('at junction, square right, onto Route de Turini'));
  const quiet = generatePaceNotes(stage.points, { steps: stage.steps, streets: false }).notes.map((n) => n.label);
  assert.ok(quiet.includes('at junction, square right'));
  assert.ok(!quiet.some((l) => l.includes('Turini')));
  const back = hashToSpec('#' + specToHash({ demo: true }, { name: 'Bronx night loop' }));
  assert.equal(back.name, 'Bronx night loop');
});

import { Race, fmtRaceTime, routeSvgPath } from '../race.js';
test('race: point-to-point clock stops at the finish with average speed', () => {
  const r = new Race({ total: 3000 });
  r.start(0);
  let ev = [];
  for (let t = 0, s = 0; s <= 3000; t += 1000, s += 25) ev = ev.concat(r.update(t, s, 25)); // 25 m/s = 90 km/h
  const fin = ev.find((e) => e.type === 'finish');
  assert.ok(fin);
  assert.ok(Math.abs(fin.result.avg - 25) < 0.6);
  assert.equal(r.update(999999, 3000, 25).length, 0); // stopped
  assert.equal(fmtRaceTime(119400), '1:59.4');
});

test('race: circuit counts laps from GO on the line and finishes after N laps', () => {
  const L = 2000, r = new Race({ total: L, loop: true, laps: 3 });
  r.start(0);
  const ev = [];
  for (let t = 0, s = 10; ev.every((e) => e.type !== 'finish') && t < 1e6; t += 1000, s += 20) ev.push(...r.update(t, s, 20));
  assert.deepEqual(ev.filter((e) => e.type === 'lap').map((e) => e.n), [1, 2, 3]);
  const res = ev.find((e) => e.type === 'finish').result;
  assert.equal(res.laps.length, 3);
  assert.ok(Math.abs(res.dist - 3 * L) < 60);           // mileage = laps × lap length
  // starting mid-lap: out lap first, then 2 timed laps
  const r2 = new Race({ total: L, loop: true, laps: 2 }); r2.start(0);
  const e2 = []; for (let t = 0, s = 900; e2.every((e) => e.type !== 'finish'); t += 1000, s += 20) e2.push(...r2.update(t, s, 20));
  assert.equal(e2[0].type, 'lapstart');
  assert.equal(e2.filter((e) => e.type === 'lap').length, 2);
  assert.match(routeSvgPath([[40, -73], [40.01, -73.01], [40.02, -73]]).d, /^M[\d.]+ [\d.]+ L/);
});

test('calls come one note at a time by default; read-ahead chains are optional', () => {
  const run = (chain) => {
    const sim = new DriveSim(gen.samples, gen.kappa, 120 / 3.6), sch = new CallScheduler(gen.notes, { chain });
    const calls = [];
    while (!sim.done) { const f = sim.tick(0.5); const c = sch.update(f.s, f.speed); if (c) calls.push(c); }
    return calls;
  };
  const single = run('single');
  // one note per call, except corners that run into each other (< 45 m) which share a call
  for (const c of single) for (let k = c.from; k < c.to; k++) assert.ok(gen.notes[k].gapNext < 45, 'unlinked notes chained');
  assert.equal(single.reduce((n, c) => n + c.to - c.from + 1, 0), gen.notes.length); // every note still called
  assert.ok(single.every((c) => c.distToNote > 0));          // each before its corner
  assert.ok(run('ahead').some((c) => c.to > c.from));         // chaining still available
});

import { findLoops, chooseSmoothest, bestInsertIndex, detourVias } from '../routing.js';
test('routing clean-up: finds around-the-block loops at a via, picks the smoothest alternative', () => {
  // straight north 600 m, but a detour around a 100x100 block in the middle (like a via on a side street)
  const P = []; let p = [40.83, -73.92];
  const go = (brg, d) => { for (let x = 0; x < d; x += 25) { p = offsetPoint(p, brg, 25); P.push(p); } };
  P.push(p); go(0, 800); const junction = p;
  go(90, 100); go(0, 100); go(270, 100); go(180, 100); // around the block back to the junction
  P[P.length - 1] = junction; go(0, 800);
  const loops = findLoops(P);
  assert.equal(loops.length, 1);
  assert.ok(Math.abs(loops[0].len - 400) < 30);
  const via = P[Math.round((loops[0].i + loops[0].j) / 2)];
  assert.deepEqual(detourVias(P, [P[0], via, P.at(-1)]).bad, [1]);
  assert.deepEqual(detourVias(P, [P[0], P[5], P.at(-1)]).bad, []);    // a via on the straight is fine
  // a whole circuit is not a "loop"
  const C = []; p = [40.83, -73.92]; C.push(p);
  for (const b of [0, 90, 180, 270]) for (let x = 0; x < 1000; x += 25) { p = offsetPoint(p, b, 25); C.push(p); }
  assert.equal(findLoops(C).length, 0);
  // alternatives: a 5 % slower route with no U-turn and fewer sharp turns wins
  const leg = (turns) => ({ steps: turns.map((a) => ({ maneuver: { type: 'turn', bearing_before: 0, bearing_after: a } })) });
  const fast = { duration: 600, legs: [leg([90, 180, 270, 90])] }, smooth = { duration: 630, legs: [leg([30])] };
  assert.equal(chooseSmoothest([fast, smooth]), 1);
  assert.equal(chooseSmoothest([fast, { ...smooth, duration: 800 }]), 0); // too slow
  // a tapped via goes between the two points it sits between
  assert.equal(bestInsertIndex([[0, 0], [0, 0.01], [0, 0.02]], [0.001, 0.015]), 2);
});

import { lateralPoint, pickShortest, tollCount, tightCount, smoothScore, smoothCandidates, exploreVias } from '../routing.js';
test('route options: shortest, tolls, smoothness scoring, explore points', () => {
  const A = [40.80, -73.95], B = [40.90, -73.95];          // ~11 km due north
  const m = lateralPoint(A, B, 0.5, 0.2);                   // 20 % to the right (east) of the midpoint
  assert.ok(Math.abs(m[0] - 40.85) < 0.001 && m[1] > -73.95);
  assert.equal(pickShortest([{ distance: 9000 }, { distance: 8000 }, { distance: 8500 }]), 1);
  const tollRoute = { legs: [{ steps: [{ intersections: [{ classes: ['toll'] }, {}] }] }] };
  assert.equal(tollCount(tollRoute), 1);
  assert.equal(tollCount({ legs: [{ steps: [{ intersections: [{}] }] }] }), 0);
  // smooth: a longer route with no tight corners beats a quicker one full of squares
  const city = { duration: 600, notes: Array(8).fill({ kind: 'corner', grade: 2, shape: 'square' }) };
  const sweep = { duration: 840, notes: [{ kind: 'corner', grade: 5 }, { kind: 'corner', grade: 6 }] };
  assert.equal(tightCount(city.notes), 8);
  assert.ok(smoothScore(sweep) < smoothScore(city));
  assert.equal(smoothCandidates(A, B).length, 4);
  // explore: 1–2 points strictly between A and B, different each time
  let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const e1 = exploreVias(A, B, rnd), e2 = exploreVias(A, B, rnd);
  for (const e of [e1, e2]) { assert.ok(e.length === 3 || e.length === 4); for (const p of e.slice(1, -1)) assert.ok(p[0] > 40.82 && p[0] < 40.88); }
  assert.notDeepEqual(e1, e2);
});

import { sharedFraction, roundCandidates } from '../routing.js';
test('round circuits: measure how much of the way back repeats the way out', () => {
  const A = [40.80, -73.95], B = [40.84, -73.95];
  const straight = [A, [40.82, -73.95], B];
  const back = straight.slice().reverse();
  assert.ok(sharedFraction(straight, back) > 0.95);                         // same street back
  const { rets } = roundCandidates(A, B);
  const side = [rets[1][0], rets[1][1], rets[1][2]];                        // back via a point to the side
  assert.ok(sharedFraction(straight, side) < 0.1, `shared ${sharedFraction(straight, side)}`);
  assert.equal(roundCandidates(A, B).outs.length, 3);
});

import { ghostTimeAt, ghostDistAt, ghostDelta, compressTrace } from '../race.js';
test('ghost: a run is recorded, and the live gap says ahead / behind', () => {
  const r = new Race({ total: 2000 }); r.start(0);
  let res;
  for (let t = 0, s = 0; !res; t += 1000, s += 20) for (const e of r.update(t, s, 20)) if (e.type === 'finish') res = e.result;
  const g = res.ghost;
  assert.ok(g && g.trace.length > 10);
  assert.ok(Math.abs(ghostTimeAt(g.trace, 1000) - 50000) < 1500);       // 20 m/s → 1000 m at ~50 s
  assert.ok(Math.abs(ghostDistAt(g.trace, 25000) - 500) < 30);
  assert.ok(ghostDelta(g.trace, 45000, 1000) < 0);                      // got there sooner → ahead (−)
  assert.ok(ghostDelta(g.trace, 55000, 1000) > 0);                      // later → behind (+)
  assert.equal(compressTrace(Array.from({ length: 2000 }, (_, i) => [i * 10, i])).length, 600);
});

test('ghost on a circuit is the best lap, with distance measured from the line', () => {
  const L = 2000, r = new Race({ total: L, loop: true, laps: 2 }); r.start(0);
  let res, t = 0, s = 10;
  while (!res) {                                                         // lap 1 at 20 m/s, lap 2 at 25 m/s
    for (const e of r.update(t, s, 20)) if (e.type === 'finish') res = e.result;
    t += 1000; s += s < L + 10 ? 20 : 25;
  }
  assert.equal(res.laps.length, 2);
  assert.equal(res.ghost.ms, Math.min(...res.laps));
  assert.ok(res.ghost.trace[0][1] < 30);                                 // starts at the line
  assert.ok(Math.abs(res.ghost.trace.at(-1)[1] - L) < 30);               // ends a lap later
  const seg = new Race({ total: L, loop: true, laps: 1 }); seg.start(0); seg.update(0, 5, 0);
  assert.deepEqual(seg.segment(3000, 65), { elapsed: 3000, dist: 65 });
});

test('your fixes change future calls; calibration shifts the rest', () => {
  const r3 = gen.notes[2];                                                // "right 3"
  const fixed = generatePaceNotes(stage.points, { steps: stage.steps, fixes: [{ id: 'f1', lat: r3.lat, lon: r3.lon, grade: 2 }] });
  assert.ok(fixed.notes.some((n) => n.label === 'right 2' && n.fixed === 'f1'));
  const gone = generatePaceNotes(stage.points, { steps: stage.steps, fixes: [{ id: 'f2', lat: r3.lat, lon: r3.lon, none: true }] });
  assert.equal(gone.notes.length, gen.notes.length - 1);
  const sq = generatePaceNotes(stage.points, { steps: stage.steps, fixes: [{ id: 'f3', lat: r3.lat, lon: r3.lon, shape: 'square' }] });
  assert.ok(sq.notes.some((n) => n.label === 'square right'));
  const tighter = generatePaceNotes(stage.points, { steps: stage.steps, gradeOffset: -1 });
  assert.equal(tighter.notes[0].label, 'right 5');                        // right 6 → 5
  assert.ok(tighter.notes.some((n) => n.label === 'hairpin right, don\'t cut')); // hairpins untouched
});

import { buildGraph, planHunt, overpassQuery } from '../parking.js';
// a fake city: N×N grid of streets 100 m apart, every other street one-way (like OSM)
function cityGrid(n = 9, spacing = 100, c0 = [40.8, -73.9]) {
  const els = [], id = (r, c) => r * 1000 + c + 1;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const p = offsetPoint(offsetPoint(c0, 0, (r - (n - 1) / 2) * spacing), 90, (c - (n - 1) / 2) * spacing);
    els.push({ type: 'node', id: id(r, c), lat: p[0], lon: p[1] });
  }
  let wid = 1;
  for (let r = 0; r < n; r++) els.push({ type: 'way', id: wid++, nodes: [...Array(n)].map((_, c) => id(r, c)), tags: { highway: 'residential', name: `${r} Street`, ...(r % 2 ? { oneway: 'yes' } : {}) } });
  for (let c = 0; c < n; c++) els.push({ type: 'way', id: wid++, nodes: [...Array(n)].map((_, r) => id(r, c)), tags: { highway: 'residential', name: `${c} Avenue`, ...(c % 2 ? { oneway: '-1' } : {}) } });
  return { osm: { elements: els }, center: c0 };
}

test('parking hunt covers every street in the radius, closest first, obeying one-ways', () => {
  const { osm, center } = cityGrid();
  for (const radius of [150, 300, 1000]) {
    const g = buildGraph(osm, center, radius);
    const h = planHunt(g, center, { maxLength: 1e9 });
    assert.equal(h.covered + h.unreachable, h.total, `r=${radius}`);
    assert.equal(h.unreachable, 0, `r=${radius}: one-way trap`);
    assert.ok(h.total > 0);
    // every step is a real street edge, driven in an allowed direction
    for (let i = 1; i < h.nodeIds.length; i++) {
      const ok = (g.adj.get(h.nodeIds[i - 1]) || []).some((e) => e.to === h.nodeIds[i]);
      assert.ok(ok, `r=${radius}: illegal move ${h.nodeIds[i - 1]}→${h.nodeIds[i]}`);
    }
    // starts at the destination and the first streets are the nearest ones
    assert.ok(segLen(h.points[0], center) < 5);
    const targetLen = g.blocks.filter((b) => b.target).reduce((s, b) => s + b.len, 0);
    assert.ok(h.length < targetLen * 2.6, `r=${radius}: ${Math.round(h.length)} m driven for ${Math.round(targetLen)} m of streets`);
  }
  // the first half of the drive stays nearer the destination than the second half (spiral outwards)
  const g = buildGraph(osm, center, 400), h = planHunt(g, center, { maxLength: 1e9 });
  const half = Math.floor(h.points.length / 2), avg = (a) => a.reduce((s, p) => s + segLen(p, center), 0) / a.length;
  assert.ok(avg(h.points.slice(0, half)) < avg(h.points.slice(half)));
  assert.ok(h.turns.length > 5 && h.turns.every((t) => t.name));
  // turns carry their exact position, so a route that passes the same junction twice still gets every call right
  const calls = generatePaceNotes(h.points, { steps: h.turns, streets: true }).notes;
  const junctions = calls.filter((n) => n.kind === 'junction');
  assert.ok(junctions.length >= h.turns.length * 0.9, `${junctions.length} of ${h.turns.length} turns called`);
  assert.ok(junctions.every((n) => / onto /.test(n.label)));
  assert.match(overpassQuery(40.8, -73.9, 1200), /around:1\d{3},/);
});

test('big radius: planned in batches, nearest first, continuing where the last batch stopped', () => {
  const { osm, center } = cityGrid(25);
  const g = buildGraph(osm, center, 1000);
  let h = planHunt(g, center, { maxLength: 5000 }), batches = 1, all = h.covered;
  assert.ok(h.length <= 5400 && h.remaining > 0);
  const firstAvg = h.points.reduce((s, p) => s + segLen(p, center), 0) / h.points.length;
  while (h.remaining > 0 && batches < 50) { h = planHunt(g, h.points.at(-1), { maxLength: 5000, done: h.done }); all += h.covered; batches++; }
  assert.equal(h.remaining, 0);
  assert.equal(all, h.total);                                     // every street, once, across the batches
  assert.ok(firstAvg < 600, `first batch stays near the destination (${Math.round(firstAvg)} m)`);
});

test('S-bends: a junction keeps the bend the other way, and linked corners are read together', () => {
  // straight, junction square right, 25 m later a left bend (an S), straight
  let p = [40.83, -73.92], brg = 0; const pts = [p];
  const go = (d) => { for (let x = 0; x < d; x += 10) { p = offsetPoint(p, brg, Math.min(10, d - x)); pts.push(p); } };
  const arc = (R, a) => { const L = R * Math.abs(a) * Math.PI / 180; for (let d = 0; d < L; d += 3) { const st = Math.min(3, L - d), dt = (st / R) * 180 / Math.PI * Math.sign(a); p = offsetPoint(p, brg + dt / 2, st); brg += dt; pts.push(p); } };
  go(300); const jn = p; const b1 = brg; brg += 90; go(25); arc(25, -80); go(300);
  const steps = [{ maneuver: { type: 'turn', modifier: 'right', location: [jn[1], jn[0]], bearing_before: b1, bearing_after: b1 + 90 } }];
  const N = generatePaceNotes(pts, { steps }).notes.filter((n) => n.kind !== 'finish');
  assert.ok(N.some((n) => n.kind === 'junction' && n.dir === 'right'));
  assert.ok(N.some((n) => n.kind === 'corner' && n.dir === 'left'), N.map((n) => n.label).join(' | '));
  // one-at-a-time still reads the pair in one breath
  const sch = new CallScheduler(N, { chain: 'single' });
  let call = null; for (let s = 0; s < 400 && !call; s += 5) call = sch.update(s, 15);
  assert.ok(call.to > call.from, call.text);
  assert.match(call.text, / (into|and) /);
});

test('review edits: add a call where none was, remove a crest', () => {
  const mid = gen.samples[Math.round(2700 / 5)];                         // on a straight
  const added = generatePaceNotes(stage.points, { steps: stage.steps, fixes: [{ id: 'a1', add: true, dir: 'left', grade: 4, lat: mid.lat, lon: mid.lon }] });
  assert.ok(added.notes.some((n) => n.added && n.label === 'left 4'));
  const withHills = generatePaceNotes(stage.points, { steps: stage.steps, elevation: stage.elevation });
  const crest = withHills.notes.find((n) => n.label === 'crest');
  const noCrest = generatePaceNotes(stage.points, { steps: stage.steps, elevation: stage.elevation, fixes: [{ id: 'r1', none: true, lat: crest.lat, lon: crest.lon }] });
  assert.ok(!noCrest.notes.some((n) => n.label === 'crest'));
});

import { cleanFixes, simplifyTrack, finishRecording } from '../record.js';
test('recording: GPS fixes become a clean track that gives the same calls as the road', () => {
  // drive the demo stage at ~15 m/s, one fix a second, with ±3 m GPS noise, a bad fix and a jump
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  const fixes = [];
  for (let i = 0, t = 0; i < gen.samples.length; i += 3, t += 1000) {
    const s = gen.samples[i];
    fixes.push({ lat: s.lat + rnd() * 5e-5, lon: s.lon + rnd() * 6e-5, t, accuracy: 6 });
    if (i === 300) fixes.push({ lat: s.lat + 0.01, lon: s.lon, t: t + 10, accuracy: 6 });    // jump
    if (i === 600) fixes.push({ lat: s.lat + 0.001, lon: s.lon, t: t + 20, accuracy: 80 });  // poor accuracy
  }
  const rec = finishRecording(fixes);
  assert.ok(Math.abs(rec.length - gen.total) / gen.total < 0.05, `length ${Math.round(rec.length)} vs ${Math.round(gen.total)}`);
  assert.ok(rec.points.length < fixes.length * 0.8);                         // simplified
  assert.equal(rec.loop, false);
  const fromTrack = generatePaceNotes(rec.points).notes.filter((n) => n.kind === 'corner').map((n) => n.dir);
  const fromMap = generatePaceNotes(stage.points).notes.filter((n) => n.kind === 'corner').map((n) => n.dir);
  assert.ok(Math.abs(fromTrack.length - fromMap.length) <= 2, `${fromTrack.length} corners from the track vs ${fromMap.length} from the map`);
  assert.equal(cleanFixes([{ lat: 40, lon: -73, t: 0 }, { lat: 40, lon: -73.00001, t: 1000 }]).length, 1); // standing still
  assert.equal(simplifyTrack([[40, -73], [40.0001, -73], [40.0002, -73]]).length, 2);               // straight line
});

test('recording re-syncs after a real jump (e.g. leaving a tunnel) instead of dropping the rest', () => {
  const fx = [];
  for (let i = 0; i < 30; i++) fx.push({ lat: 40 + i * 0.0001, lon: -73, t: i * 1000 });            // 11 m/s north
  for (let i = 0; i < 30; i++) fx.push({ lat: 40.02 + i * 0.0001, lon: -73, t: 30000 + i * 1000 }); // 2 km further on, 1 s later
  const kept = cleanFixes(fx);
  assert.ok(kept.length > 50, `kept ${kept.length}`);
  // a single spike is still thrown away
  const spike = [...fx.slice(0, 10)]; spike.splice(5, 0, { lat: 40.5, lon: -73, t: 5500 });
  assert.equal(cleanFixes(spike).length, 10);
});

test('bike: no brake calls', () => {
  const car = generatePaceNotes(stage.points, { steps: stage.steps }).notes.map((n) => n.label);
  const bike = generatePaceNotes(stage.points, { steps: stage.steps, bike: true }).notes.map((n) => n.label);
  assert.ok(car.some((l) => l.startsWith('brake')));
  assert.ok(!bike.some((l) => l.includes('brake')));
});

test('time attack: the clock starts when you cross the start line, not before', () => {
  const L = 2000;
  // starting mid-lap: out lap is free, the clock starts at the line
  const r = new Race({ total: L, loop: true, laps: 2, flying: true }); r.start(0);
  const ev = []; let tLine = null;
  for (let t = 0, s = 900; ev.every((e) => e.type !== 'finish'); t += 1000, s += 20) {
    const e = r.update(t, s, 20); ev.push(...e);
    if (e.some((x) => x.type === 'lapstart')) tLine = t;
    if (tLine == null) assert.equal(r.elapsed(t), 0);
  }
  assert.equal(tLine, 55000);                                   // (2000 − 900) / 20 m/s
  const res = ev.find((e) => e.type === 'finish').result;
  assert.equal(res.laps.length, 2);
  assert.equal(res.ms, 2 * 100000);                             // only the two flying laps
  assert.ok(Math.abs(res.dist - 2 * L) < 30);                   // the out lap isn't counted
  // parked on the line: the clock starts as you pull away
  const p = new Race({ total: L, loop: true, laps: 1, flying: true }); p.start(0);
  p.update(0, 0, 0); p.update(5000, 0, 0); assert.equal(p.elapsed(9000), 0);
  assert.equal(p.update(10000, 5, 5)[0].type, 'lapstart');
  assert.equal(p.elapsed(11000), 1000);
  // just before the line: that crossing starts it
  const b = new Race({ total: L, loop: true, laps: 1, flying: true }); b.start(0);
  b.update(0, 1980, 10); assert.ok(b.waiting);
  assert.equal(b.update(3000, 2010, 10)[0].type, 'lapstart');
});

test('parking hunt drives along main roads to reach every neighbourhood, but only searches the small streets', () => {
  // two one-way neighbourhoods that only connect through a main road (like the Bronx between the avenues)
  const els = [], c0 = [40.82, -73.906];
  let wid = 1;
  const hood = (base, dx) => {
    const id = (r, c) => base + r * 10 + c;
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
      const p = offsetPoint(offsetPoint(c0, 0, (r - 2) * 100), 90, dx + (c - 2) * 100);
      els.push({ type: 'node', id: id(r, c), lat: p[0], lon: p[1] });
    }
    for (let r = 0; r < 5; r++) els.push({ type: 'way', id: wid++, nodes: [0, 1, 2, 3, 4].map((c) => id(r, c)), tags: { highway: 'residential', name: `${base} St ${r}`, ...(r % 2 ? { oneway: 'yes' } : {}) } });
    for (let c = 0; c < 5; c++) els.push({ type: 'way', id: wid++, nodes: [0, 1, 2, 3, 4].map((r) => id(r, c)), tags: { highway: 'residential', name: `${base} Av ${c}`, ...(c % 2 ? { oneway: '-1' } : {}) } });
    return id;
  };
  const W = hood(1000, -350), E = hood(2000, 350);
  // the main road: west hood's middle street → east hood's middle street, two-way
  const mids = [1, 2].map((k) => { const p = offsetPoint(c0, 90, -150 + k * 100); els.push({ type: 'node', id: 9000 + k, lat: p[0], lon: p[1] }); return 9000 + k; });
  els.push({ type: 'way', id: wid++, nodes: [W(2, 4), ...mids, E(2, 0)], tags: { highway: 'primary', name: 'Main Avenue' } });
  const osm = { elements: els };
  const g = buildGraph(osm, c0, 900), h = planHunt(g, offsetPoint(c0, 90, -350), { maxLength: 1e9 });
  assert.equal(h.unreachable, 0);
  assert.equal(h.covered, h.total);
  const targets = g.blocks.filter((b) => b.target);
  assert.ok(targets.length === 80 && !targets.some((b) => b.name === 'Main Avenue'), 'main road connects but isn’t searched');
  assert.ok(h.points.some((p) => segLen(p, offsetPoint(c0, 90, 350)) < 250) && h.points.some((p) => segLen(p, offsetPoint(c0, 90, -350)) < 250), 'both sides');
  // ticking "main roads too" searches it as well
  assert.ok(buildGraph(osm, c0, 900, { mainRoads: true }).blocks.some((b) => b.target && b.name === 'Main Avenue'));
  assert.match(overpassQuery(40.8, -73.9, 500), /primary/);
});

test('a route that passes its own finish (or a street) twice: the position never jumps to the later pass', () => {
  // a neighbourhood lap: east along a street, round a block, back along the SAME street, finishing mid-way along it
  const c0 = [40.82, -73.906], P = (e, n) => offsetPoint(offsetPoint(c0, 90, e), 0, n);
  const pts = [P(0, 0), P(300, 0), P(600, 0), P(600, 200), P(300, 200), P(300, 0), P(450, 0)]; // finish at 450 m east, passed first at ~450 m
  const gen = generatePaceNotes(pts, {});
  const sim = new DriveSim(gen.samples, gen.kappa, 40 / 3.6), tr = new RouteTracker(gen.samples);
  let maxJump = 0, last = 0, early = false;
  while (!sim.done) {
    const f = sim.tick(0.5), s = tr.locate(f.lat, f.lon).s;
    maxJump = Math.max(maxJump, s - last); last = s;
    if (s >= gen.total - 20 && f.s < gen.total - 100) early = true;  // "finished" while really on the first pass
  }
  assert.ok(!early, 'finished early on the first pass over the finish');
  assert.ok(maxJump < 30, `position jumped ${Math.round(maxJump)} m ahead`);
});

test('circuit whose last stretch runs beside its first: the position never jumps to the end of the lap', () => {
  const loop = generatePaceNotes(stage.points, { steps: stage.steps, loop: true });
  const sim = new DriveSim(loop.samples, loop.kappa, 120 / 3.6, { loop: true, laps: 2 }), tr = new RouteTracker(loop.samples, true);
  let sU = null, last = null, worst = 0;
  while (!sim.done) {
    const s = tr.locate(...Object.values((({ lat, lon }) => ({ lat, lon }))(sim.tick(0.5)))).s;
    if (last != null) { let d = s - last; if (d < -loop.total / 2) d += loop.total; else if (d > loop.total / 2) d -= loop.total; worst = Math.min(worst, d); sU += d; } else sU = s;
    last = s;
  }
  assert.ok(worst > -5, `went backwards ${Math.round(-worst)} m`);
  assert.ok(sU > 1.9 * loop.total);
});

test('a locked finish (checkpoints still to pass) doesn’t end the run; it finishes once unlocked', () => {
  const r = new Race({ total: 1000 }); r.start(0); r.update(0, 0, 10);
  r.locked = true;
  assert.equal(r.update(5000, 990, 10).length, 0);
  assert.equal(r.state, 'running');
  r.locked = false;
  assert.equal(r.update(6000, 995, 10)[0].type, 'finish');
});

import { addRun, removeRun, removeBoard, ranked, boardList, mergeBoards } from '../board.js';
test('leaderboard: ranks runs, circuits by best lap, delete one or all, merge backups', () => {
  let B = {};
  const meta = { name: 'Morning stage', loop: false, total: 5000 };
  let r = addRun(B, 'k1', meta, { id: 'a', ms: 300000, date: 1 }); B = r.boards;
  assert.equal(r.rank, 1); assert.ok(r.isBest);
  r = addRun(B, 'k1', meta, { id: 'b', ms: 280000, date: 2 }); B = r.boards;
  assert.equal(r.rank, 1); assert.equal(r.prevBest.id, 'a');
  r = addRun(B, 'k1', meta, { id: 'c', ms: 290000, date: 3 }); B = r.boards;
  assert.equal(r.rank, 2); assert.equal(r.of, 3);
  assert.deepEqual(ranked(B.k1).map((e) => e.id), ['b', 'c', 'a']);
  // circuits: best lap wins, not total time
  const lap = { name: 'Block', loop: true, total: 1200 };
  B = addRun(B, 'k2', lap, { id: 'x', ms: 400000, best: 95000, lapsN: 4, date: 4 }).boards;
  B = addRun(B, 'k2', lap, { id: 'y', ms: 200000, best: 99000, lapsN: 2, date: 5 }).boards;
  assert.deepEqual(ranked(B.k2).map((e) => e.id), ['x', 'y']);
  assert.equal(boardList(B)[0].key, 'k2');                         // most recently driven first
  B = removeRun(B, 'k1', 'b');
  assert.deepEqual(ranked(B.k1).map((e) => e.id), ['c', 'a']);
  B = removeRun(removeRun(B, 'k1', 'c'), 'k1', 'a');
  assert.ok(!B.k1);                                                // last run gone → board gone
  B = removeBoard(B, 'k2'); assert.deepEqual(B, {});
  const m = mergeBoards({ k: { loop: false, entries: [{ id: '1', ms: 5, date: 1 }] } }, { k: { loop: false, entries: [{ id: '1', ms: 5, date: 1 }, { id: '2', ms: 3, date: 2 }] } });
  assert.deepEqual(ranked(m.k).map((e) => e.id), ['2', '1']);
});

test('calls: no distance numbers between notes unless switched on', () => {
  assert.equal(chainText(gen.notes, 1, 2), 'Left 4 into right 3');            // default: no "200"
  assert.equal(chainText(gen.notes, 1, 2, 'metric', { distances: true }), 'Left 4 into right 3, 200');
  assert.equal(chainText(gen.notes, 0, 0), chainText(gen.notes, 0, 0).replace(/, \d+$/, ''));
});

test('simulator at a constant speed: exactly what you pick, 1 to 300 km/h', () => {
  for (const kmh of [1, 300]) {
    const sim = new DriveSim(gen.samples, gen.kappa, kmh / 3.6, { constant: true });
    for (let i = 0; i < 20; i++) assert.ok(Math.abs(sim.tick(0.5).speed * 3.6 - kmh) < 1e-9);
  }
  // 300 km/h: the calls still come, and early enough
  const sim = new DriveSim(gen.samples, gen.kappa, 300 / 3.6, { constant: true }), sch = new CallScheduler(gen.notes);
  let calls = 0, late = 0;
  while (!sim.done) { const f = sim.tick(0.5); const c = sch.update(f.s, f.speed); if (c) { calls++; if (c.distToNote < 0) late++; } }
  assert.ok(calls > 3 && late === 0, `${calls} calls, ${late} late`);
});

test('on foot: plain walking calls, only real turns, no brake calls, survives a share link', () => {
  const car = generatePaceNotes(stage.points, { steps: stage.steps });
  const foot = generatePaceNotes(stage.points, { steps: stage.steps, foot: true, flats: false });
  const labels = foot.notes.map((n) => n.label);
  assert.ok(labels.every((l) => !/\b[1-6]\b|hairpin|brake|caution|flat|kink|chicane/.test(l)), labels.join(' | '));
  assert.ok(labels.some((l) => /^(turn|sharp|slight|keep) (left|right)/.test(l)));
  assert.ok(foot.notes.length < car.notes.length, 'gentle bends are left out on foot');
  assert.equal(labels.at(-1), 'finish');
  const back = hashToSpec('#' + specToHash({ via: [[40.8, -73.9], [40.81, -73.91]], vehicle: 'foot' }));
  assert.equal(back.spec.vehicle, 'foot');
});

import { buildCues, planMapPages, renderPrint } from '../print.js';
test('print: directions match the turns; poster prints only sheets the route crosses, labelled to fit together', () => {
  const r = { ...gen, points: stage.points, loop: false, checkpoints: [], spec: { name: 'Test' } };
  const cues = buildCues(r);
  assert.equal(cues[0].kind, 'start'); assert.equal(cues.at(-1).kind, 'end');
  assert.ok(cues.filter((c) => c.kind === 'turn').length >= 5);
  assert.ok(cues.every((c, i) => !i || c.s >= cues[i - 1].s), 'in order along the route');
  const fit = planMapPages(r, { mode: 'fit', paper: 'letter', orient: 'portrait' });
  assert.equal(fit.pages.length, 1);
  const a = planMapPages(r, { mode: 'poster', z: 16, paper: 'letter', orient: 'portrait' }), b = planMapPages(r, { mode: 'poster', z: 18, paper: 'letter', orient: 'portrait' });
  assert.ok(b.pages.length > a.pages.length, 'more detail → more sheets');
  assert.ok(b.pages.length < b.cols * b.rows, 'empty sheets are skipped');
  assert.equal(new Set(b.pages.map((p) => p.label)).size, b.pages.length);
  const out = renderPrint(r, { what: 'both', mode: 'poster', z: 17, paper: 'a4', orient: 'portrait', background: 'none', units: 'metric' }, { fmtDist: (m) => `${Math.round(m)} m` });
  assert.ok(out.html.includes('Poster index') && out.html.includes('Then go') && /@page \{ size: A4 portrait/.test(out.pageCss));
});

import { gpsStep, MAX_SPEED } from '../navcore.js';
test('GPS glitches: a position jump gives no crazy top speed and adds no distance', () => {
  const c0 = [40.7, -73.99], at = (m) => offsetPoint(c0, 90, m);
  const fix = (m, t, extra = {}) => ({ lat: at(m)[0], lon: at(m)[1], t, ...extra });
  let prev = null, v = 0, dist = 0, top = 0;
  const feed = (f, now) => { const r = gpsStep(prev, f, now, v); v = r.v; dist += r.dd; top = Math.max(top, v); if (!r.jump || !prev) prev = { lat: f.lat, lon: f.lon, t: f.t, now }; return r; };
  for (let i = 0; i <= 10; i++) feed(fix(i * 15, i * 1000), i * 1000);            // 15 m/s for 10 s = 150 m
  const j = feed(fix(2400, 11000), 11000);                                          // GPS jumps 2.25 km in 1 s
  assert.ok(j.jump); assert.equal(j.dd, 0);
  for (let i = 12; i <= 15; i++) feed(fix(150 + (i - 11) * 15, i * 1000), i * 1000); // back on track
  assert.ok(top <= MAX_SPEED && top < 20, `top ${top * 3.6} km/h`);
  assert.ok(Math.abs(dist - 210) < 5, `distance ${dist}`);
  assert.ok(Math.abs(gpsStep(prev, fix(225, 16000, { speed: 2222 }), 16000, 15).v - 15) < 0.01); // an impossible device speed is ignored
});

import { fuelCost, fmtMoney, sayMoney } from '../fuel.js';
test('gas cost: mpg, km/L and L/100 km agree; money is formatted and said', () => {
  const a = fuelCost(160934.4, { eff: 25, effUnit: 'mpg', price: 3.5 });        // 100 miles at 25 mpg = 4 gal = $14
  assert.ok(Math.abs(a.gallons - 4) < 1e-9 && Math.abs(a.cost - 14) < 1e-9 && a.unit === 'gal');
  const b = fuelCost(100000, { eff: 12.5, effUnit: 'kml', price: 1.8 });         // 100 km at 12.5 km/L = 8 L
  assert.ok(Math.abs(b.litres - 8) < 1e-9 && Math.abs(b.cost - 14.4) < 1e-9);
  const c = fuelCost(100000, { eff: 8, effUnit: 'l100', price: 1.8 });           // the same car in L/100 km
  assert.ok(Math.abs(c.litres - b.litres) < 1e-9);
  assert.equal(fuelCost(1000, { eff: 0, price: 3 }), null);
  assert.equal(fmtMoney(3.204, '$'), '$3.20'); assert.equal(fmtMoney(14.4, 'R$'), 'R$14.40');
  assert.equal(sayMoney(2.85, '$'), 'about 2 dollars 85'); assert.equal(sayMoney(0.4, '$'), 'about 40 cents');
});

test('a route with several destinations keeps its named stops in a share link', () => {
  const spec = { via: [[40.7, -73.99], [40.71, -73.98], [40.72, -73.97]], stops: [{ ll: [40.71, -73.98], name: 'Gas station' }] };
  const back = hashToSpec('#' + specToHash(spec, { name: 'Home → Gas station → Work' }));
  assert.equal(back.spec.stops.length, 1); assert.equal(back.spec.stops[0].name, 'Gas station'); assert.deepEqual(back.spec.stops[0].ll, [40.71, -73.98]);
});

test('your notes are called a set distance before the spot, not as you reach it', () => {
  const c0 = [40.7, -73.99], P = (m) => offsetPoint(c0, 90, m);
  const pts = [P(0), P(1500)];
  const recce = [{ id: 'p1', lat: P(800)[0], lon: P(800)[1], words: ['pothole'] }];
  const g = generatePaceNotes(pts, { recce, flats: false });
  const pot = g.notes.find((n) => n.kind === 'recce');
  for (const [warn, kmh] of [[150, 30], [250, 50], [400, 90]]) {
    const sim = new DriveSim(g.samples, g.kappa, kmh / 3.6, { constant: true }), sch = new CallScheduler(g.notes, { noteWarn: String(warn) });
    let calledAt = null;
    while (!sim.done && calledAt == null) { const f = sim.tick(0.5); const c = sch.update(f.s, f.speed); if (c && /pothole/i.test(c.text)) calledAt = f.s; }
    const before = pot.sApex - calledAt;
    assert.ok(before >= warn - 5 && before <= Math.max(warn, kmh / 3.6 * 6 + 30) + 10, `${warn} m setting at ${kmh} km/h: called ${Math.round(before)} m before`);
  }
});
