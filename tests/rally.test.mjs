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
  assert.equal(chainText(gen.notes, 1, 2), 'Left 4 into right 3, 200');
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
  assert.ok(single.every((c) => c.from === c.to), 'a call carried more than one note');
  assert.equal(single.length, gen.notes.length);              // every note still called
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
