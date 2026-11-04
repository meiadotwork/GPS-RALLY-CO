import { generatePaceNotes, linkFor, offsetPoint, segLen, RECCE_WORDS, showGrade } from './pacenotes.js';
import { RouteTracker, CallScheduler, DriveSim } from './navcore.js';
import { buildStage } from './sample-route.js';
import { specToHash, hashToSpec } from './share.js';
import { Race, fmtRaceTime, routeSvgPath, ghostDelta, ghostDistAt, compressTrace } from './race.js';
import { overpassQuery, buildGraph, planHunt } from './parking.js';
import { finishRecording } from './record.js';
import { chooseSmoothest, detourVias, bestInsertIndex, distToPolyline, pickShortest, tollCount, smoothScore, smoothCandidates, exploreVias, tightCount, pointAlong, sharedFraction, roundCandidates } from './routing.js';

const $ = (id) => document.getElementById(id);
const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
// 🚲 bike: OpenStreetMap's "foot" router ignores one-way streets and uses paths and parks — shortest way, any direction
const ROUTERS = { car: OSRM, bike: 'https://routing.openstreetmap.de/routed-foot/route/v1/driving/' };
let VEHICLE = 'car';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const ELEVATION = 'https://api.open-meteo.com/v1/elevation';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=';

// ---------- settings ----------
const settings = { callAhead: 'normal', rate: 1.3, units: 'metric', voice: '', flats: 'on', scale: 'wrc', cams: 'off', streets: 'on', laps: 3, start: 'go', huntRadius: 400, huntMain: 'off', vehicle: 'car', labels: 'off', cal: '0', chain: 'single', smooth: 'on', noToll: false, round: 'on' };
try { Object.assign(settings, JSON.parse(localStorage.getItem('codriver.settings') || '{}')); } catch {}
// recce notes: words the crew added, pinned to a spot on the road (kept on this phone)
let recce = [];
// your corrections to calls ("that call was wrong"), pinned by location, on this phone
let fixes = [];
try { fixes = JSON.parse(localStorage.getItem('codriver.fixes') || '[]'); } catch {}
const saveFixes = () => { try { localStorage.setItem('codriver.fixes', JSON.stringify(fixes)); } catch {} };
try { recce = JSON.parse(localStorage.getItem('codriver.recce') || '[]'); } catch {}
const saveRecce = () => { try { localStorage.setItem('codriver.recce', JSON.stringify(recce)); } catch {} };
const saveSettings = () => { try { localStorage.setItem('codriver.settings', JSON.stringify(settings)); } catch {} };

// ---------- state ----------
const S = {
  route: null, nav: false, mode: 'idle', tracker: null, sched: null,
  follow: true, headingUp: true, heading: 0, rot: 0, speed: 0,
  fix: null, prevFix: null, offCount: 0, lastReroute: 0, lastOnRouteS: 0,
  watch: null, simTimer: null, wake: null, draw: [], drawLayer: null,
  routeLayer: null, noteLayer: null, meMarker: null,
  loop: false, sU: 0, lastS: null, lap: 0, lapStart: null, laps: [],
};

// ---------- map (oversized square so it can rotate without blank corners) ----------
const map = L.map('map', { zoomControl: false, attributionControl: false, zoomSnap: 0.25 }).setView([46, 8], 5);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, subdomains: 'abc' }).addTo(map);
function sizeMap() {
  const w = innerWidth, h = innerHeight, d = Math.ceil(Math.hypot(w, h));
  Object.assign($('map').style, { width: d + 'px', height: d + 'px', left: (w - d) / 2 + 'px', top: (h - d) / 2 + 'px' });
  map.invalidateSize(false);
}
sizeMap();
addEventListener('resize', sizeMap);
map.on('zoomend', () => document.body.classList.toggle('zfar', map.getZoom() < 15));
window.codriverMap = map; // handy for debugging / automated tests

// Fit bounds into the visible screen (the map element is a bigger square so it can rotate).
function fitVisible(bounds, top = 150, bottom = 130, side = 30) {
  const r = $('map').getBoundingClientRect();
  const ox = Math.max(0, -r.left), oy = Math.max(0, -r.top);
  map.fitBounds(bounds, { paddingTopLeft: [ox + side, oy + top], paddingBottomRight: [ox + side, oy + bottom] });
}
function setRotation(deg) {
  const d = ((deg - S.rot + 540) % 360) - 180; // shortest way round
  S.rot += d;
  $('map').style.transform = `rotate(${S.rot}deg)`;
}

// Your position is always on the map (not just while driving). Navigation has its own GPS feed.
let firstFix = true;
navigator.geolocation?.watchPosition((p) => {
  if (S.nav) return;
  const c = p.coords, f = { lat: c.latitude, lon: c.longitude, heading: c.heading, speed: c.speed, accuracy: c.accuracy };
  S.fix = f;
  const moving = f.speed != null && f.speed > 1 && f.heading != null && !isNaN(f.heading);
  drawMe(f.lat, f.lon, moving ? f.heading : null);
  if (!S.accCircle) S.accCircle = L.circle([f.lat, f.lon], { radius: f.accuracy || 20, color: '#4aa3ff', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
  else S.accCircle.setLatLng([f.lat, f.lon]).setRadius(f.accuracy || 20);
  if (firstFix && !S.route) map.setView([f.lat, f.lon], 15);
  firstFix = false;
}, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });

// ---------- helpers ----------
function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}
const kmh = (ms) => (settings.units === 'imperial' ? ms * 2.23694 : ms * 3.6);
function fmtDist(m) {
  if (settings.units === 'imperial') {
    const yd = m * 1.09361;
    return yd < 1000 ? `${Math.round(yd / 10) * 10} yd` : `${(m / 1609.34).toFixed(1)} mi`;
  }
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}
function openSheet(id) { document.querySelectorAll('.sheet').forEach((s) => (s.hidden = s.id !== id)); }
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => (b.closest('.sheet').hidden = true)));

// ---------- voice ----------
let voices = [];
function loadVoices() {
  voices = (speechSynthesis?.getVoices() || []).filter((v) => v.lang.startsWith('en'));
  const sel = $('setVoice');
  sel.innerHTML = voices.map((v) => `<option value="${v.name}">${v.name} (${v.lang})</option>`).join('');
  if (!settings.voice) {
    const pref = voices.find((v) => /Daniel|UK English Male|Arthur|Oliver|George/i.test(v.name)) || voices.find((v) => v.lang === 'en-GB') || voices[0];
    settings.voice = pref?.name || '';
  }
  sel.value = settings.voice;
}
if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }

function spoken(text) {
  return text.replace(/\b1 k\b/g, 'one K').replace(/\b2 k\b/g, 'two K').replace(/\bT junction\b/g, 'tee junction');
}
// Only one thing is ever said at a time: nothing is queued behind a call that's still talking.
let talkingUntil = 0;
const isTalking = () => Date.now() < talkingUntil;
function speak(text, urgent = false) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(spoken(text));
  const v = voices.find((x) => x.name === settings.voice);
  if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-GB';
  u.rate = settings.rate; u.pitch = 0.95; u.volume = 1;
  speechSynthesis.cancel(); // drop anything stale rather than read it late
  // estimated length as a safety net in case the browser never fires 'end'
  talkingUntil = Date.now() + 1000 * (0.4 + text.split(/[\s,]+/).length / (3 * settings.rate));
  u.onend = u.onerror = () => { talkingUntil = 0; };
  speechSynthesis.speak(u);
}

// ---------- routing ----------
async function fetchJSON(url, ms = 12000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error(r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
async function osrmFetch(coords, startBearing, alternatives = false, noToll = false) {
  const pts = coords.map((c) => `${c[1].toFixed(6)},${c[0].toFixed(6)}`).join(';');
  let url = `${ROUTERS[VEHICLE] || OSRM}${pts}?overview=full&geometries=geojson&steps=true&continue_straight=true`;
  if (alternatives) url += '&alternatives=3';
  if (noToll) url += '&exclude=toll';
  if (startBearing != null) url += `&bearings=${Math.round(startBearing)},60` + ';'.repeat(coords.length - 1);
  const j = await fetchJSON(url);
  if (j.code !== 'Ok' || !j.routes?.length) throw new Error(j.message || 'no route');
  return j;
}
const geomPts = (r) => r.geometry.coordinates.map(([lo, la]) => [la, lo]);
// Fetch honouring the "avoid tolls" filter. If the server can't exclude tolls, fetch normally and
// put the routes with the fewest toll points first.
async function fetchFiltered(coords, startBearing, alternatives, noToll) {
  if (!noToll || VEHICLE === 'bike') return osrmFetch(coords, startBearing, alternatives); // no tolls on a bike
  try { return await osrmFetch(coords, startBearing, alternatives, true); }
  catch {
    const j = await osrmFetch(coords, startBearing, alternatives || coords.length === 2);
    j.routes.sort((a, b) => tollCount(a) - tollCount(b));
    return j;
  }
}

// Route through the points. With "smooth routes" on:
//  - A→B: ask for alternatives and take the smoothest (fewest sharp turns / U-turns, ≤ +15 % time)
//  - with points in between: a point that only makes the route loop round a block or U-turn
//    (usually it landed on a side street or the far side of the road) is skipped, as long as
//    the route without it still passes within 60 m of it.
// droppable: Set of points the APP added (Smooth/Explore/round pins). Your own checkpoints are never
// dropped or reordered; if one makes the route loop round a block it's kept and reported in loopWarn.
async function osrmRoute(coords, startBearing, mode = 'fastest', noToll = false, droppable = null) {
  const smooth = settings.smooth !== 'off';
  const wantAlt = coords.length === 2 && (smooth || mode === 'shortest');
  let j = await fetchFiltered(coords, startBearing, wantAlt, noToll);
  // with the toll filter on, only consider the least-toll routes
  let routes = j.routes;
  if (noToll) { const min = Math.min(...routes.map(tollCount)); routes = routes.filter((r) => tollCount(r) === min); }
  let r = routes[mode === 'shortest' ? pickShortest(routes) : smooth ? chooseSmoothest(routes) : 0];
  let used = coords, dropped = 0;
  const warn = new Set();
  if (coords.length > 2) {
    const keep = new Set();
    for (let it = 0; it < 4; it++) {
      const uturns = r.legs.flatMap((l) => l.steps)
        .filter((st) => st.maneuver?.modifier === 'uturn' && st.maneuver.type !== 'depart')
        .map((st) => [st.maneuver.location[1], st.maneuver.location[0]]);
      const snapped = (j.waypoints || []).map((w) => [w.location[1], w.location[0]]);
      const { bad } = detourVias(geomPts(r), snapped, uturns);
      for (const x of bad) if (!droppable?.has(used[x])) warn.add(used[x]); // yours: keep, but tell
      const k = smooth ? bad.find((x) => droppable?.has(used[x]) && !keep.has(used[x].join())) : null;
      if (k == null) break;
      const trial = used.filter((_, i) => i !== k);
      try {
        const j2 = await fetchFiltered(trial, startBearing, false, noToll), r2 = j2.routes[0];
        if (distToPolyline(geomPts(r2), used[k]) < 60) { used = trial; j = j2; r = r2; dropped++; }
        else keep.add(used[k].join()); // the route really has to go there: keep the point
      } catch { keep.add(used[k].join()); }
    }
  }
  const legs = r.legs;
  const steps = legs.flatMap((l, li) => l.steps.filter((s) => s.maneuver.type !== 'arrive' || li === legs.length - 1));
  const tolls = tollCount(r);
  const tollNote = noToll && tolls ? `No toll-free way found — this route passes ${tolls} toll point${tolls > 1 ? 's' : ''}` : '';
  const loopWarn = [...warn].filter((p) => used.includes(p));
  return { points: geomPts(r), steps, duration: r.duration, distance: r.distance, dropped, used, tollNote, tolls, loopWarn };
}
const asResult = (r, used) => {
  const legs = r.legs;
  const steps = legs.flatMap((l, li) => l.steps.filter((s) => s.maneuver.type !== 'arrive' || li === legs.length - 1));
  return { points: geomPts(r), steps, duration: r.duration, distance: r.distance, dropped: 0, used };
};

// Circuits, and A→B with your own points: choose each leg's way for the route type, pin it with a
// hidden point, then route the whole thing in one go (keeps loop/U-turn smoothing across joints).
async function planLegs(coords, mode, noToll = false) {
  const out = [coords[0]], pins = new Set();
  for (let k = 0; k < coords.length - 1; k++) {
    const a = coords[k], b = coords[k + 1];
    if (segLen(a, b) < 300) { out.push(b); continue; }            // too short to have options
    if (mode === 'explore') { const ev = exploreVias(a, b).slice(1, -1); ev.forEach((p) => pins.add(p)); out.push(...ev, b); continue; }
    const j = await fetchFiltered([a, b], null, true, noToll);
    let routes = j.routes;
    if (noToll) { const min = Math.min(...routes.map(tollCount)); routes = routes.filter((r) => tollCount(r) === min); }
    let pin = null;
    if (mode === 'shortest') {
      const i = pickShortest(routes);
      if (routes[i] !== j.routes[0]) pin = pointAlong(geomPts(routes[i]), 0.5);
    } else if (mode === 'smooth') {
      const cands = routes.map((r) => ({ ...asResult(r, [a, b]), pin: r === j.routes[0] ? null : pointAlong(geomPts(r), 0.5) }));
      const side = await Promise.allSettled(smoothCandidates(a, b).map((c) => osrmRoute(c, null, 'fastest', noToll, new Set([c[1]])).then((x) => ({ ...x, pin: c[1] }))));
      side.forEach((x) => { if (x.status === 'fulfilled') cands.push(x.value); });
      const fastest = Math.min(...cands.map((c) => c.duration));
      let bs = Infinity;
      for (const c of cands) {
        if (c.duration > fastest * 1.6) continue;
        const sc = smoothScore({ notes: generatePaceNotes(c.points, { steps: c.steps, flats: false }).notes, duration: c.duration });
        if (sc < bs) { bs = sc; pin = c.pin; }
      }
    }
    if (pin) { out.push(pin); pins.add(pin); }
    out.push(b);
  }
  return osrmRoute(out, null, 'fastest', noToll, pins); // only the app's pins may be dropped
}

// Round circuit from a to b and back without reusing the same roads: try ways out and ways back
// (plain + detours either side), keep pairs whose way back shares < 12 % with the way out, then
// pick by route type. Explore uses random detours, so every tap is a different loop.
async function planRound(a, b, mode, noToll = false) {
  const { outs, rets } = roundCandidates(a, b, mode === 'explore' ? Math.random : null);
  // plain legs use the route type's own pick (e.g. shortest) and get pinned at their midpoint so the final route keeps them
  const run = (c) => osrmRoute(c, null, c.length === 2 && mode === 'shortest' ? 'shortest' : 'fastest', noToll, c.length === 3 ? new Set([c[1]]) : null)
    .then((r) => ({ ...r, pin: c.length === 3 ? c[1] : pointAlong(r.points, 0.5) }));
  const settle = async (list) => (await Promise.allSettled(list.map(run))).filter((x) => x.status === 'fulfilled').map((x) => x.value);
  const [O, R] = await Promise.all([settle(outs), settle(rets)]);
  if (!O.length || !R.length) throw new Error('no route');
  const notes = (c) => (c.notes ||= generatePaceNotes(c.points, { steps: c.steps, flats: false }).notes);
  const pairs = [];
  for (const o of O) for (const r of R) pairs.push({ o, r, ov: sharedFraction(o.points, r.points) });
  // prefer properly round pairs (≤ 5 % shared), else ≤ 12 %
  const tight = pairs.filter((p) => p.ov <= 0.05);
  const ok = tight.length ? tight : pairs.filter((p) => p.ov <= 0.12);
  const pool = ok.length ? ok : [pairs.reduce((m, p) => (p.ov < m.ov ? p : m))];
  const cost = (p) => mode === 'shortest' ? p.o.distance + p.r.distance
    : mode === 'smooth' ? smoothScore({ notes: notes(p.o), duration: p.o.duration }) + smoothScore({ notes: notes(p.r), duration: p.r.duration })
    : mode === 'explore' ? Math.random() : p.o.duration + p.r.duration;
  const best = pool.reduce((m, p) => (cost(p) < cost(m) ? p : m));
  const coords = [a, best.o.pin, b, best.r.pin, a].filter(Boolean);
  const res = await osrmRoute(coords, null, 'fastest', noToll, new Set([best.o.pin, best.r.pin]));
  // how round did it come out? compare the way out with the way back
  const split = res.points.reduce((bi, p, i) => (segLen(p, b) < segLen(res.points[bi], b) ? i : bi), 0);
  const ov = sharedFraction(res.points.slice(0, split + 1), res.points.slice(split));
  res.info = ov < 0.03 ? 'no repeated roads' : `${Math.round(ov * 100)}% repeated road`;
  if (!ok.length) res.tollNote = (res.tollNote ? res.tollNote + ' · ' : '') + `Couldn't find a fully round way — ${Math.round(ov * 100)}% of the way back repeats the way out`;
  return res;
}

// Route options that pick their own way between A and B.
async function planMode(base, mode, noToll = false) {
  const [a, b] = base;
  if (mode === 'smooth') {
    // candidates: OSRM's alternatives + detours either side; keep the one with the fewest tight corners
    const cands = [];
    const j = await fetchFiltered(base, null, true, noToll);
    j.routes.forEach((r) => cands.push({ ...asResult(r, base), tolls: tollCount(r) }));
    const side = await Promise.allSettled(smoothCandidates(a, b).map((c) => osrmRoute(c, null, 'fastest', noToll, new Set([c[1]]))));
    side.forEach((x) => { if (x.status === 'fulfilled') cands.push(x.value); });
    const fastest = Math.min(...cands.map((c) => c.duration));
    const minToll = noToll ? Math.min(...cands.map((c) => c.tolls || 0)) : Infinity;
    let best = null, bs = Infinity;
    for (const c of cands) {
      if (noToll && (c.tolls || 0) > minToll) continue;
      if (c.duration > fastest * 1.6) continue;
      c.notes = generatePaceNotes(c.points, { steps: c.steps, flats: false }).notes;
      const sc = smoothScore(c);
      if (sc < bs) { bs = sc; best = c; }
    }
    best.info = `${tightCount(best.notes)} tight corner${tightCount(best.notes) === 1 ? '' : 's'}`;
    if (noToll && best.tolls) best.tollNote = `No toll-free way found — this route passes ${best.tolls} toll point${best.tolls > 1 ? 's' : ''}`;
    return best;
  }
  // explore: random points in between; stays under 2× the fastest distance
  const fast = (await fetchFiltered(base, null, false, noToll)).routes[0].distance;
  let last = null;
  for (let k = 0; k < 4; k++) {
    const ev = exploreVias(a, b);
    const r = await osrmRoute(ev, null, 'fastest', noToll, new Set(ev.slice(1, -1)));
    last = r;
    if (r.distance <= fast * 2) return r;
  }
  return last;
}

function setRoute(r, { fit = true } = {}) {
  if (!r.spec?.parking) { S.huntCircle?.remove(); S.huntCircle = null; S.hunt = null; }
  const gen = generatePaceNotes(r.points, {
    steps: r.steps, loop: !!r.loop, flats: settings.flats !== 'off', reverse: settings.scale === 'rev', streets: settings.streets !== 'off', bike: r.spec?.vehicle === 'bike',
    elevation: r.elevation, recce, fixes, gradeOffset: +settings.cal || 0, cameras: settings.cams === 'on' ? r.cameras : undefined,
  });
  S.route = { ...r, ...gen };
  if (!r.elevation && !r.elevTried) { S.route.elevTried = true; addElevation(S.route); }
  if (settings.cams === 'on' && !r.cameras && !r.camTried) { S.route.camTried = true; addCameras(S.route); }
  S.tracker = new RouteTracker(gen.samples, gen.loop);
  S.sched = newScheduler();
  // remember where each waypoint sits along the route, for rerouting
  const t = new RouteTracker(gen.samples);
  S.route.waypoints = (r.waypoints || []).map((w) => w.ll || w).map((w) => ({ ll: w, s: t.locate(w[0], w[1]).s }));
  drawRoute(fit);
  $('btnGo').disabled = false;
  $('routeActions').hidden = false;
  $('thisRoute').hidden = false;
  $('routeName').hidden = false;
  const corners = gen.notes.filter((n) => n.kind === 'corner').length;
  paintSummary();
  $('btnCancel').hidden = false;
  $('btnStart2').hidden = false;
}
// Re-make the notes for the current route (settings, recce or elevation changed) and carry on.
function regen(msg) {
  if (!S.route) return;
  setRoute(S.route, { fit: false });
  if (S.mode === 'review') setTimeout(() => reviewNear(S.reviewFocus));
  if (S.nav) S.sched.seek(S.route.loop ? S.sU : (S.lastOnRouteS || 0));
  if (msg) toast(msg);
}

// Crests and dips: ask Open-Meteo for ground height along the route (~90 m terrain model).
async function addElevation(route) {
  try {
    const sm = route.samples, total = route.total;
    const every = Math.max(1, Math.round(Math.max(30, total / 1500) / 5));
    const pick = sm.filter((_, i) => i % every === 0 || i === sm.length - 1);
    const out = [];
    for (let i = 0; i < pick.length; i += 100) {
      const part = pick.slice(i, i + 100);
      const j = await fetchJSON(`${ELEVATION}?latitude=${part.map((p) => p.lat.toFixed(5)).join(',')}&longitude=${part.map((p) => p.lon.toFixed(5)).join(',')}`);
      j.elevation.forEach((z, k) => out.push({ s: part[k].s, z }));
    }
    if (S.route?.samples !== route.samples) return; // route changed meanwhile
    S.route.elevation = out;
    const before = S.route.notes.length;
    regen();
    const n = S.route.notes.filter((x) => x.kind === 'vertical' || x.mods.includes('over crest')).length;
    if (n) toast(`Elevation: ${n} crest${n > 1 ? 's' : ''} / dips added`);
  } catch { /* offline or rate-limited: notes just stay flat */ }
}

// ---------- summary, share, cameras ----------
const routeSeconds = () => S.route.duration ?? S.route.total / (50 / 3.6); // OSRM estimate, else ~50 km/h
function fmtDur(sec) {
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
function paintSummary() {
  const R = S.route, corners = R.notes.filter((n) => n.kind === 'corner').length;
  const cams = R.notes.filter((n) => n.cams).length;
  const dist = `${R.spec?.vehicle === 'bike' ? '🚲 ' : ''}${R.spec?.recorded ? '⏺ ' : ''}${fmtDist(R.total)}${R.loop ? ' lap' : ''}`;
  const laps = R.loop ? settings.laps : 1;
  const parts = R.loop && laps
    ? [`${laps} lap${laps > 1 ? 's' : ''} = ${fmtDist(R.total * laps)}`, `~${fmtDur(routeSeconds() * laps)}`, `${R.notes.length} note${R.notes.length === 1 ? '' : 's'}`]
    : [`~${fmtDur(routeSeconds())}`, `${R.notes.length} note${R.notes.length === 1 ? '' : 's'}`];
  paintLaps();
  if (cams) parts.push(`${cams} 📷`);
  $('routeInfo').textContent = `${R.loop ? 'Circuit · ' : ''}${dist} · ${parts.join(' · ')} (${corners} corners)`;
  const name = R.spec?.name || '';
  $('chipName').textContent = name || '✎ Name this route';
  $('chipName').classList.toggle('unnamed', !name);
  if (document.activeElement !== $('routeName')) $('routeName').value = name;
  $('chipDist').textContent = dist;
  const saved = !!(R.spec?.savedId && myRoutes().some((x) => x.id === R.spec.savedId));
  $('chipSave').textContent = saved ? '★' : '☆';
  $('chipSave').classList.toggle('on', saved);
  $('chipMeta').textContent = parts.join(' · ');
  $('routeChip').hidden = S.nav || S.mode === 'draw' || S.mode === 'edit' || S.mode === 'review';
  paintModes();
}

async function shareRoute() {
  if (!S.route?.spec) return;
  const t = new RouteTracker(S.route.samples);
  const near = recce.filter((r) => t.locate(r.lat, r.lon).offset < 25);
  const name = S.route.spec.name || '';
  const url = location.origin + location.pathname + '#' + specToHash(S.route.spec, { loop: S.route.loop, recce: near, name });
  const text = `${name ? name + ' — ' : 'Rally stage · '}${fmtDist(S.route.total)}${S.route.loop ? ' circuit' : ''} · ${S.route.notes.length} pace notes`;
  try { if (navigator.share) { await navigator.share({ title: name || 'Co-Driver Nav', text, url }); return; } }
  catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast('Link copied — paste it anywhere'); }
  catch { prompt('Copy this link:', url); }
}

// Speed cameras from OpenStreetMap (highway=speed_camera), only when switched on.
async function addCameras(route) {
  try {
    let s = 90, w = 180, n = -90, e = -180;
    for (const p of route.samples) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lon); e = Math.max(e, p.lon); }
    const pad = 0.003, q = `[out:json][timeout:25];node["highway"="speed_camera"](${s - pad},${w - pad},${n + pad},${e + pad});out body;`;
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 30000);
    const res = await fetch(OVERPASS, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
    clearTimeout(tm);
    const j = await res.json();
    if (S.route?.samples !== route.samples) return;
    S.route.cameras = j.elements.map((el) => ({ lat: el.lat, lon: el.lon, maxspeed: parseInt(el.tags?.maxspeed, 10) || null }));
    regen();
    const k = S.route.notes.filter((x) => x.cams).length;
    toast(k ? `${k} speed camera${k > 1 ? 's' : ''} on this route` : 'No speed cameras mapped on this route');
  } catch { toast('Speed cameras: could not load (offline?)'); }
}

const newScheduler = () => new CallScheduler(S.route.notes, { ...settings, loopLength: S.route.loop ? S.route.total : 0 });

// Build (or rebuild) a route from its spec, as a one-way stage or a closed circuit.
//   spec: { via: [[lat,lon]...] }            -> OSRM through these points
//         { raw: true, points, steps, demo }  -> use the geometry as given
async function buildRoute(spec, loop = S.loop, opts) {
  let r;
  if (spec.raw) {
    r = { points: spec.points, steps: spec.steps || [], elevation: spec.elevation };
  } else {
    const coords = loop ? [...spec.via, spec.via[0]] : spec.via;
    if (spec.mode === 'notoll') spec = { ...spec, mode: 'fastest', noToll: true }; // older saved routes
    if (spec.noToll == null) spec = { ...spec, noToll: !!settings.noToll };       // new routes follow the filter
    if (spec.vehicle == null) spec = { ...spec, vehicle: settings.vehicle || 'car' };
    VEHICLE = spec.vehicle;
    // on a bike "fastest" means the shortest way — any direction
    const mode = spec.vehicle === 'bike' && (!spec.mode || spec.mode === 'fastest') ? 'shortest' : spec.mode || 'fastest', noToll = !!spec.noToll;
    const roundOn = loop && spec.via.length === 2 && settings.round !== 'off';
    const picksOwn = roundOn || mode === 'smooth' || mode === 'explore' || (mode === 'shortest' && (loop || spec.via.length > 2));
    if (picksOwn && !spec.planned) {
      // the route type chooses its own way; remember your points (base) so it can be re-run
      const base = spec.via;
      if (roundOn) r = await planRound(spec.via[0], spec.via[1], mode, noToll);
      else if (!loop && spec.via.length === 2 && mode !== 'shortest') r = await planMode(spec.via, mode, noToll);
      else r = await planLegs(coords, mode, noToll);
      const used = loop ? r.used.slice(0, -1) : r.used;
      spec = { ...spec, base, via: used, planned: true };
      if (mode === 'smooth' && !r.info) {
        const t = tightCount(generatePaceNotes(r.points, { steps: r.steps, flats: false, loop }).notes);
        r.info = `${t} tight corner${t === 1 ? '' : 's'}`;
      }
    } else {
      r = await osrmRoute(coords, null, mode === 'shortest' ? 'shortest' : 'fastest', noToll);
    }
    if (r.tollNote) toast(r.tollNote, 5000);
    // a checkpoint of yours that makes the route loop round a block: keep it, flag it, say which one
    r.warnPts = (r.loopWarn || []).map((p) => p.slice());
    if (r.warnPts.length) {
      const nums = r.warnPts.map((p) => spec.via.findIndex((q) => q[0] === p[0] && q[1] === p[1])).filter((i) => i > 0);
      if (nums.length) toast(`Checkpoint ${nums.join(', ')} makes the route loop round a block — it's probably on a side street or the far side of the road. Drag it onto the road you mean (✎ Edit points).`, 7000);
    }
    {
      const b = spec.base || spec.via;
      const key = b.map((p) => p.map((x) => x.toFixed(4)).join()).join('>') + (loop ? '|loop' : '') + (noToll ? '|nt' : '') + (spec.vehicle === 'bike' ? '|bike' : '');
      if (S.modeKey !== key) { S.modeKey = key; S.modeInfo = {}; }
      S.modeInfo[mode] = { dist: r.distance, dur: r.duration, info: r.info };
    }
  }
  const via = spec.raw ? [spec.points[0], spec.points.at(-1)] : spec.via;
  setRoute({
    ...r, spec, loop,
    dest: loop ? via[0] : via.at(-1),
    waypoints: loop ? [...via.slice(1), via[0]] : via.slice(1),
  }, opts);
}

function cancelRoute() {
  if (S.nav) stopNav();
  S.huntCircle?.remove(); S.huntCircle = null; S.hunt = null;
  if (S.mode === 'edit') endEdit(false);
  S.hitLayer?.remove();
  S.routeLayer?.remove(); S.noteLayer?.remove();
  S.route = null; S.sched = null; S.tracker = null;
  $('btnGo').disabled = true;
  $('routeActions').hidden = true;
  $('thisRoute').hidden = true;
  $('routeName').hidden = true;
  $('btnCancel').hidden = true;
  $('btnStart2').hidden = true;
  $('routeInfo').textContent = '';
  $('routeChip').hidden = true;
  toast('Route cancelled');
}

function drawRoute(fit) {
  S.routeLayer?.remove(); S.noteLayer?.remove();
  S.routeLayer = L.polyline(S.route.points, { color: '#ffcc00', weight: 6, opacity: .85 }).addTo(map);
  S.hitLayer?.remove();
  S.hitLayer = L.polyline(S.route.points, { weight: 30, opacity: 0, interactive: S.mode === 'edit' }).addTo(map).on('click', onRouteTap);
  S.noteLayer = L.layerGroup(S.route.notes.map((n) => {
    const cls = n.kind === 'junction' ? 'junc' : (n.grade === 'H' || n.grade <= 2) ? 'tight' : '';
    // labels: all shown, or hidden with a tap on the dot to see that one
    const reviewing = S.mode === 'review', show = settings.labels === 'on' || reviewing;
    const mine = n.added ? ' mine' : n.fixed ? ' fixed' : '';
    const m = L.marker([n.lat, n.lon], { icon: L.divIcon({ className: `note-dot ${cls}${mine}`, iconSize: [show ? 14 : 16, show ? 14 : 16] }), interactive: !show || reviewing })
      .bindTooltip(n.label, { permanent: show, direction: 'right', offset: [8, 0], className: 'note-tip' });
    if (reviewing) m.on('click', (e) => { L.DomEvent.stopPropagation(e); reviewGo(S.route.notes.indexOf(n)); });
    else m.on('click', () => { if (S.nav && !document.body.classList.contains('map-full')) enterMapFull(); }); // driving: a dot is part of the map
    return m;
  })).addTo(map);
  S.notes_cams = S.route.notes.flatMap((n) => n.cams || []);
  S.noteLayer.addLayer(L.layerGroup(S.notes_cams.map((c) => L.marker(c, { icon: L.divIcon({ className: 'cam-pin', html: '📷', iconSize: [24, 24] }), interactive: false }))));
  if (fit) fitVisible(S.routeLayer.getBounds());
}

async function currentPos() {
  if (S.fix) return [S.fix.lat, S.fix.lon];
  try {
    const p = await new Promise((ok, no) => navigator.geolocation.getCurrentPosition(ok, no, { enableHighAccuracy: true, timeout: 8000 }));
    return [p.coords.latitude, p.coords.longitude];
  } catch {
    toast('No GPS fix — routing from map centre');
    const c = map.getCenter(); return [c.lat, c.lng];
  }
}

async function routeTo(dest, { name, oneWay = false } = {}) {
  toast('Routing…', 8000);
  try {
    const start = await currentPos();
    if (oneWay && S.loop) { S.loop = false; paintLoop(); }
    await buildRoute({ via: [start, dest], ...(name ? { name } : {}) });
    $('toast').hidden = true;
    return true;
  } catch (e) { toast('Routing failed: ' + e.message); return false; }
}

// ---------- search / pick / draw / demo ----------
$('searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('searchInput').value.trim(); if (!q) return;
  const ul = $('results'); ul.innerHTML = '<li>Searching…</li>';
  try {
    const c = map.getCenter();
    const res = await fetchJSON(`${NOMINATIM}${encodeURIComponent(q)}&lat=${c.lat}&lon=${c.lng}`);
    ul.innerHTML = res.length ? '' : '<li>No results</li>';
    res.forEach((r) => {
      const li = document.createElement('li'); li.className = 'res-li';
      li.innerHTML = `<span class="res-name"></span><button class="round" title="Save place">📍</button>`;
      li.querySelector('.res-name').textContent = r.display_name;
      li.onclick = (ev) => {
        if (ev.target.closest('button')) return addPlace(+r.lat, +r.lon, (r.name || r.display_name.split(',')[0]).trim());
        ul.innerHTML = ''; $('routeSheet').hidden = true; routeTo([+r.lat, +r.lon]);
      };
      ul.appendChild(li);
    });
  } catch (err) { ul.innerHTML = `<li>Search failed: ${err.message}</li>`; }
});

$('btnPick').onclick = () => { S.mode = 'pick'; $('routeSheet').hidden = true; toast('Tap the map to set destination'); };
map.on('contextmenu', (e) => { // long-press
  if (S.nav || S.mode === 'edit' || S.mode === 'draw' || S.mode === 'review') return;
  const ll = [e.latlng.lat, e.latlng.lng];
  const el = document.createElement('div'); el.className = 'lp-pop';
  const onRoute = S.route && distToPolyline(S.route.points, ll) <= 30;
  el.innerHTML = (onRoute ? '<button class="pill go" data-a="add">＋ Add a call here</button>' : '') +
    '<button class="pill ' + (onRoute ? 'ghost' : 'go') + '" data-a="go">🏁 Go here</button><button class="pill ghost" data-a="park">🅿️ Find parking here</button><button class="pill ghost" data-a="save">📍 Save place</button>';
  const pop = L.popup({ closeButton: false, className: 'lp-wrap' }).setLatLng(e.latlng).setContent(el).openOn(map);
  el.onclick = (ev) => {
    const a = ev.target.dataset?.a; if (!a) return;
    map.closePopup(pop);
    if (a === 'add') openAdd(ll); else if (a === 'go') routeTo(ll); else if (a === 'park') openHunt(ll, 'this spot'); else addPlace(ll[0], ll[1]);
  };
});
map.on('click', (e) => {
  if (S.nav) { if (!document.body.classList.contains('map-full')) enterMapFull(); return; } // driving: tap the map → full-screen map
  const ll = [e.latlng.lat, e.latlng.lng];
  if (S.mode === 'edit') return editAppend(ll);
  if (S.mode === 'review') return openAdd(ll); // tap the route where a call is missing
  if (S.mode === 'pick') { S.mode = 'idle'; routeTo(ll); }
  else if (S.mode === 'draw') { S.draw.push(ll); renderDraw(); }
});

// numbered as you draw: S, 1, 2, 3… — the newest point is the finish (🏁), or S/F closes the loop on a circuit
function renderDraw() {
  S.drawLayer?.remove();
  const n = S.draw.length, last = n - 1;
  const label = (i) => (i === 0 ? (S.loop ? 'S/F' : 'S') : i === last && !S.loop && n > 1 ? `${i}🏁` : String(i));
  const cls = (i) => 'edit-pt draw-pt' + (i === 0 ? ' first' : i === last && !S.loop && n > 1 ? ' last' : '');
  S.drawLayer = L.layerGroup([
    L.polyline(S.draw, { color: '#4aa3ff', weight: 4, dashArray: '6 8' }),
    ...(S.loop && n > 2 ? [L.polyline([S.draw[last], S.draw[0]], { color: '#4aa3ff', weight: 3, dashArray: '2 8', opacity: 0.7 })] : []),
    ...S.draw.map((p, i) => L.marker(p, { interactive: false, zIndexOffset: 1000 + i,
      icon: L.divIcon({ className: cls(i), html: label(i), iconSize: [30, 30] }) })),
  ]).addTo(map);
  $('drawBar').querySelector('span').textContent = n ? `${n} point${n > 1 ? 's' : ''} — tap to add checkpoint ${n === 1 ? 1 : n}` : 'Tap the map to set the start';
}
function endDraw() { S.mode = 'idle'; $('drawBar').hidden = true; S.drawLayer?.remove(); if (S.route) paintSummary(); }
$('btnDraw').onclick = () => {
  $('routeChip').hidden = true; S.mode = 'draw'; S.draw = []; $('routeSheet').hidden = true; $('drawBar').hidden = false; renderDraw(); };
$('drawUndo').onclick = () => { S.draw.pop(); renderDraw(); };
$('drawCancel').onclick = endDraw;
function paintLoop() {
  $('loopToggle').checked = S.loop;
  $('drawLoop').classList.toggle('on', S.loop);
  $('drawLoop').textContent = S.loop ? '⟳ Circuit' : '→ One way';
}
$('drawLoop').onclick = () => { S.loop = !S.loop; paintLoop(); if (S.mode === 'draw') renderDraw(); };
$('loopToggle').onchange = async (e) => {
  S.loop = e.target.checked; paintLoop();
  if (!S.route) return;
  const wasNav = S.nav; if (wasNav) stopNav();
  toast(S.loop ? 'Closing the circuit…' : 'Back to one-way…', 8000);
  try { const sp = S.route.spec; await buildRoute(sp.base ? { ...sp, via: sp.base, planned: false } : sp, S.loop); $('toast').hidden = true; }
  catch (err) { toast('Routing failed: ' + err.message); S.loop = !S.loop; paintLoop(); }
};
$('btnCancel').onclick = cancelRoute;
$('btnStart2').onclick = () => startNav();
paintLoop();
$('drawSnap').onclick = async () => {
  if (S.draw.length < 2) return toast('Add at least two points');
  toast('Snapping to roads…', 8000);
  try {
    await buildRoute({ via: S.draw.slice() }); endDraw(); $('toast').hidden = true;
  } catch (e) { toast('Snap failed: ' + e.message); }
};
$('drawRaw').onclick = () => {
  if (S.draw.length < 2) return toast('Add at least two points');
  buildRoute({ raw: true, points: S.draw.slice() }); endDraw();
};
$('btnDemo').onclick = () => {
  const { points, steps, elevation } = buildStage();
  buildRoute({ raw: true, points, steps, elevation, demo: true });
  $('simSpeed').value = '90';
  toast('Demo stage loaded — Simulate is on');
};

// ---------- notes list ----------
$('btnNotes').onclick = () => {
  const N = S.route.notes;
  $('notesList').innerHTML = N.map((n, i) => {
    const l = linkFor(n.gapNext, settings.units);
    return `<li data-i="${i}">${n.label}${l.say ? ` <span class="link">${l.say}</span>` : ''}
      <small>${fmtDist(n.sStart)} in${n.angle ? ` · ${n.angle}°` : ''}${n.rMin ? ` · r ${n.rMin} m` : ''}${n.recce ? ' · recce ✎' : ''} · tap to add recce</small></li>`;
  }).join('');
  openSheet('notesSheet');
};
$('notesList').addEventListener('click', (e) => {
  const li = e.target.closest('li'); if (!li) return;
  const n = S.route.notes[+li.dataset.i];
  openFix(n);
});

// ---------- recce picker ----------
let recceTarget = null, recceWords = [];
const chipsHtml = Object.entries(RECCE_WORDS).map(([cat, words]) =>
  `<h3>${cat}</h3><div class="chips">${words.map((w) => `<button data-w="${w}">${w}</button>`).join('')}</div>`).join('');
$('recceChips').innerHTML = chipsHtml;
function paintRecce() {
  $('recceChips').querySelectorAll('button').forEach((b) => b.classList.toggle('on', recceWords.includes(b.dataset.w)));
  $('reccePreview').textContent = recceWords.length ? recceWords.join(', ') : 'Tap words in the order you want them read';
  $('recceSave').disabled = !recceWords.length;
}
function openRecce(target) {
  recceTarget = target; recceWords = [];
  $('recceWhat').textContent = target.note ? `On: ${target.note.label}` : 'Here, at your current position';
  $('recceClear').hidden = !target.note?.recce;
  paintRecce(); openSheet('recceSheet');
}
$('recceChips').addEventListener('click', (e) => {
  const w = e.target.dataset?.w; if (!w) return;
  recceWords = recceWords.includes(w) ? recceWords.filter((x) => x !== w) : [...recceWords, w];
  paintRecce();
});
$('recceSave').onclick = () => {
  recce.push({ id: Date.now().toString(36), lat: recceTarget.lat, lon: recceTarget.lon, words: recceWords.slice() });
  saveRecce(); $('recceSheet').hidden = true;
  regen('Recce note added: ' + recceWords.join(', '));
};
$('recceClear').onclick = () => {
  const ids = recceTarget.note?.recce || [];
  recce = recce.filter((r) => !ids.includes(r.id)); saveRecce();
  $('recceSheet').hidden = true; regen('Recce note removed');
};

$('btnRoute').onclick = () => {
  if (S.nav && S.fix) return openRecce({ lat: S.fix.lat, lon: S.fix.lon }); // while driving: quick "+ note"
  openSheet('routeSheet');
};
$('btnSettings').onclick = () => openSheet('settingsSheet');

// ---------- settings UI ----------
function bindSeg(id, key) {
  const el = $(id);
  const paint = () => el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings[key]));
  el.addEventListener('click', (e) => {
    const v = e.target.dataset?.v; if (!v) return;
    settings[key] = v; saveSettings(); paint(); applySettings();
  });
  paint();
}
bindSeg('setAhead', 'callAhead');
bindSeg('setUnits', 'units');
bindSeg('setFlats', 'flats');
// Gentle-bend calls change the notes themselves: regenerate, and carry on from where we are.
$('setFlats').addEventListener('click', () => regen(settings.flats === 'off' ? 'Gentle bends: not called' : 'Gentle bends: flat / kink called'));
bindSeg('setScale', 'scale');
bindSeg('setCams', 'cams');
bindSeg('setStreets', 'streets');
bindSeg('setLabels', 'labels');
bindSeg('setChain', 'chain');

$('setChain').addEventListener('click', () => toast(settings.chain === 'ahead' ? 'Calls: reading ahead (linked notes together)' : 'Calls: one note at a time'));
$('setLabels').addEventListener('click', () => { if (S.route) drawRoute(false); toast(settings.labels === 'on' ? 'Note labels shown on the map' : 'Note labels hidden — tap a dot to see its note'); });
$('setStreets').addEventListener('click', () => regen(settings.streets === 'off' ? 'Street names: not said' : 'Street names: said at junctions'));
$('setCams').addEventListener('click', () => regen(settings.cams === 'on' ? 'Speed cameras: on' : 'Speed cameras: off'));
$('setScale').addEventListener('click', () => regen(settings.scale === 'rev' ? 'Scale: 1 = fastest, 6 = slowest' : 'Scale: 1 = slowest, 6 = fastest'));
$('setRate').value = settings.rate; $('rateVal').textContent = settings.rate.toFixed(2) + '×';
$('setRate').oninput = (e) => { settings.rate = +e.target.value; $('rateVal').textContent = settings.rate.toFixed(2) + '×'; saveSettings(); applySettings(); };
$('setVoice').onchange = (e) => { settings.voice = e.target.value; saveSettings(); };
$('btnTestVoice').onclick = () => speak('Left 5, 100, into right 3 tightens. Hairpin left, don\'t cut.', true);
function applySettings() {
  S.sched?.set({ callAhead: settings.callAhead, rate: settings.rate, units: settings.units });
  $('speedUnit').textContent = settings.units === 'imperial' ? 'mph' : 'km/h';
  if (S.route) paintSummary();
}
applySettings();

// ---------- me marker ----------
const meIcon = L.divIcon({ className: 'me-marker', iconSize: [34, 34], html: '<svg viewBox="0 0 40 40"><path d="M20 3 L34 35 L20 27 L6 35 Z"/></svg><i class="dot"></i>' });
// arrow when we know which way you're going, a blue dot when standing still
function drawMe(lat, lon, heading) {
  if (!S.meMarker) S.meMarker = L.marker([lat, lon], { icon: meIcon, interactive: false, zIndexOffset: 1000 }).addTo(map);
  S.meMarker.setLatLng([lat, lon]);
  const el = S.meMarker.getElement(), svg = el?.querySelector('svg');
  el?.classList.toggle('still', heading == null);
  if (svg && heading != null) svg.style.transform = `rotate(${heading}deg)`;
}

// ---------- glyph ----------
// The headline of a call ("right 2", "square left", "hairpin right") and the rest as small print.
function splitCall(n, label) {
  const o = { reverse: settings.scale === 'rev' };
  let main = label;
  if (n.kind === 'corner') {
    main = n.chicane ? `chicane ${n.chicane}` : n.shape ? `${n.shape} ${n.dir}` : n.grade === 'H' ? `hairpin ${n.dir}`
      : n.grade === 'F' ? `${n.kink ? 'kink' : 'flat'} ${n.dir}` : `${n.dir} ${showGrade(n.grade, o)}`;
  } else if (n.kind === 'junction') {
    main = n.shape === 'roundabout' ? 'roundabout' : n.shape === 'keep' ? (label.match(/(keep|exit|merge|slip road) (left|right)/)?.[0] || `keep ${n.dir}`)
      : n.shape === 'graded' ? `${n.dir} ${showGrade(n.grade, o)}` : `${n.shape} ${n.dir}`;
  }
  if (!label.includes(main)) return { main: label, sub: '' };
  const rest = [];
  for (const part of label.split(', ')) {
    if (part.includes(main)) { const r = part.replace(main, '').trim(); if (r) rest.push(r); }
    else rest.push(part);
  }
  return { main, sub: rest.join(' · ') };
}

function glyph(n) {
  const g = $('glyph');
  if (!n) return (g.innerHTML = '');
  if (n.kind === 'finish') return (g.innerHTML = '<path d="M28 90 V12 M28 14 H76 L66 30 L76 46 H28"/>');
  if (n.kind === 'vertical') return (g.innerHTML = n.text.includes('dip') ? '<path d="M8 34 Q50 96 92 34"/>' : '<path d="M8 74 Q50 6 92 74"/>');
  if (n.kind === 'camera') return (g.innerHTML = '<path d="M16 36 H84 V80 H16 Z M36 36 L42 24 H58 L64 36 M62 58 A12 12 0 1 1 38 58 A12 12 0 1 1 62 58"/>');
  if (n.kind === 'recce' || n.kind === 'feature') return (g.innerHTML = '<text x="50" y="76" text-anchor="middle" font-size="72">!</text>');
  if (n.chicane) return (g.innerHTML = `<path d="M50 94 V74 L${n.dir === 'right' ? 72 : 28} 54 L${n.dir === 'right' ? 28 : 72} 32 L50 12"/>`);
  if (n.shape === 'roundabout') return (g.innerHTML = '<path d="M50 92 V68 M50 68 A16 16 0 1 1 66 52 L84 40 M84 40 l-12 0 M84 40 l-3 11"/>');
  const R = { H: 15, 1: 10, 2: 13, 3: 17, 4: 22, 5: 28, 6: 34, F: 44 };
  let r, th;
  if (n.kind === 'junction' || n.shape) {
    r = { hairpin: 15, acute: 6, square: 5, keep: 40 }[n.shape] ?? R[n.grade] ?? 28;
    th = n.shape === 'keep' ? 20 : Math.max(25, Math.min(n.angle, 180));
  }
  else { r = R[n.grade]; th = Math.max(25, Math.min(n.angle, 180)); }
  const right = n.dir === 'right', x0 = 50 + (right ? -1 : 1) * Math.max(12, Math.min(r, 20)), y0 = 60; // keep the arrow centred
  const cx = right ? x0 + r : x0 - r;
  const phi = (right ? 180 + th : -th) * Math.PI / 180;
  const ex = cx + r * Math.cos(phi), ey = y0 + r * Math.sin(phi);
  const h = (-90 + (right ? th : -th)) * Math.PI / 180;
  const tx = ex + 12 * Math.cos(h), ty = ey + 12 * Math.sin(h);
  const ah = (a) => `M${tx.toFixed(1)} ${ty.toFixed(1)} l${(14 * Math.cos(h + a)).toFixed(1)} ${(14 * Math.sin(h + a)).toFixed(1)}`;
  g.innerHTML = `<path d="M${x0} 94 V${y0} A${r} ${r} 0 ${th > 180 ? 1 : 0} ${right ? 1 : 0} ${ex.toFixed(1)} ${ey.toFixed(1)} L${tx.toFixed(1)} ${ty.toFixed(1)} ${ah(2.5)} ${ah(-2.5)}"/>`;
}

// ---------- navigation ----------
function onFix(f) {
  const now = f.t || Date.now();
  // speed: device value if present, otherwise from successive fixes
  let v = f.speed;
  if ((v == null || isNaN(v)) && S.prevFix) {
    const dt = (now - S.prevFix.t) / 1000;
    v = dt > 0 ? segLen([S.prevFix.lat, S.prevFix.lon], [f.lat, f.lon]) / dt : 0;
  }
  S.speed = S.speed * 0.4 + (v || 0) * 0.6;
  S.prevFix = { lat: f.lat, lon: f.lon, t: now };
  S.fix = f;

  const loc = S.tracker.locate(f.lat, f.lon);
  const offLimit = Math.max(35, (f.accuracy || 10) * 1.5);
  if (loc.offset > offLimit) S.offCount++; else { S.offCount = 0; S.lastOnRouteS = loc.s; }

  if (f.heading != null && !isNaN(f.heading) && S.speed > 3) S.heading = f.heading;
  else if (loc.offset < 30) S.heading = loc.bearing;

  if (S.offCount >= 3 && now - S.lastReroute > 15000 && !S.simTimer) {
    if (S.route.loop) { // circuits: no reroute, just say so and pick up again when back on track
      S.lastReroute = now; speak('Off route.', true); toast('Off circuit — rejoin to continue');
    } else reroute([f.lat, f.lon]);
  }

  // distance along the stage; on a circuit it keeps growing lap after lap
  let sNow = loc.s;
  if (S.route.loop) {
    const L = S.route.total;
    if (S.lastS == null) S.sU = loc.s;
    else {
      let d = loc.s - S.lastS;
      if (d < -L / 2) d += L; else if (d > L / 2) d -= L;
      S.sU += d;
    }
    sNow = S.sU;
  }
  S.lastS = loc.s;
  if (S.race) for (const e of S.race.update(now, sNow, S.speed)) onRaceEvent(e, now);
  if (S.race && S.nav) paintGhost(now, sNow);
  if (!S.nav) return; // the race just finished

  // the next call waits until the current one has finished (it'll still come before its corner,
  // or be dropped if the corner has already gone)
  const call = S.offCount || isTalking() ? null : S.sched.update(sNow, S.speed);
  if (call) { speak(call.text); $('lastCall').textContent = '“' + call.text + '”'; S.lastCalled = S.sched.noteAt(call.to); }

  // screen
  $('speed').textContent = Math.round(kmh(S.speed));
  const up = S.sched.upcoming(sNow);
  if (S.route.loop) $('lapInfo').textContent = lapLabel(now);
  if (up) {
    const { main, sub } = splitCall(up.note, up.label);
    $('noteBig').textContent = main;
    $('noteSub').textContent = sub;
    $('noteBig').classList.toggle('caution', !!up.note.mods?.some((m) => m.includes('caution')));
    $('noteDist').textContent = up.dist > 0 ? fmtDist(up.dist) : 'NOW';
    const l = linkFor(up.note.gapNext, settings.units);
    $('noteNext').textContent = up.next ? `${l.say ? l.say + ' · ' : ''}${up.next.label}` : '';
  }
  {
    const L = S.route.total, left = S.route.loop ? L - (((sNow % L) + L) % L) : Math.max(0, L - loc.s);
    const eta = new Date(now + routeSeconds() * (left / L) * 1000);
    $('remain').textContent = S.route.loop ? `${fmtDist(left)} to the line`
      : `${fmtDist(left)} to go · ETA ${eta.getHours()}:${String(eta.getMinutes()).padStart(2, '0')}`;
    glyph(up.note);
  }
  drawMe(f.lat, f.lon, S.heading);
  if (S.follow) followCam(f.lat, f.lon);
}

const fmtTime = (ms) => { const t = ms / 1000, m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`; };
function sayTime(ms) {
  const t = Math.round(ms / 1000), m = Math.floor(t / 60), sec = t % 60;
  return (m ? `${m} minute${m > 1 ? 's' : ''} ` : '') + `${sec} second${sec === 1 ? '' : 's'}`;
}
function lapLabel(now) {
  const R = S.race;
  if (!R || R.state === 'idle') return 'Waiting for GO';
  if (R.waiting) return R.onLine ? '⏱ TIME ATTACK — clock starts as you pull away' : '⏱ TIME ATTACK — clock starts at the line';
  const n = R.laps.length + (R.lapStart != null ? 1 : 0);
  const of = R.target ? `/${R.target}` : '';
  const cur = R.lapStart != null ? fmtTime(now - R.lapStart) : 'out lap';
  const last = R.laps.length ? ` · last ${fmtTime(R.laps.at(-1))} · best ${fmtTime(Math.min(...R.laps))}` : '';
  return n ? `LAP ${R.target ? Math.min(n, R.target) : n}${of} · ${cur}${last}` : 'OUT LAP — cross the start line';
}

function onRaceEvent(e) {
  if (e.type === 'lapstart') { speak(S.race.flying ? 'Clock running. Lap one.' : 'Lap one.'); if (S.race.flying) beep(1320, 0.4); }
  else if (e.type === 'lap') {
    const R = S.race, left = R.target ? R.target - e.n : null;
    let msg = `Lap ${e.n}, ${sayTime(e.ms)}${e.best ? ', best lap' : ''}.`;
    if (left === 1) msg += ' Last lap!';
    if (left !== 0) speak(msg);
  } else if (e.type === 'finish') { if (S.route.spec?.parking) finishHunt(); else finishRace(e.result); }
  if (e.type === 'lap') { const tr = S.race.lapTraces.at(-1); if (tr) { const g = { ms: e.ms, trace: compressTrace(tr) }; if (saveGhost(g)) { S.ghostSaved = true; S.ghost = g; } } } // your best lap so far chases you from the next lap
}

function followCam(lat, lon) {
  const kph = S.speed * 3.6;
  const z = kph < 35 ? 17 : kph < 75 ? 16.25 : 15.5;
  let c = [lat, lon];
  if (S.headingUp) { // put the car low on screen so you see the road ahead
    const mpp = 156543.03392 * Math.cos(lat * Math.PI / 180) / 2 ** z;
    c = offsetPoint(c, S.heading, innerHeight * 0.3 * mpp); // car sits low, under the big note panel
  }
  map.setView(c, z, { animate: true, duration: S.simTimer ? 0.5 : 0.9, easeLinearity: 1, noMoveStart: true });
  setRotation(S.headingUp ? -S.heading : 0);
}

async function reroute(from) {
  S.lastReroute = Date.now();
  speak('Off route. Recalculating.', true);
  toast('Off route — recalculating…', 5000);
  const ahead = S.route.waypoints.filter((w) => w.s > S.lastOnRouteS + 20).map((w) => w.ll);
  const targets = ahead.length ? ahead : [S.route.dest];
  try {
    const r = await osrmRoute([from, ...targets], S.speed > 3 ? S.heading : null, 'fastest', !!S.route.spec?.noToll);
    setRoute({ ...r, spec: { via: [from, ...targets], name: S.route.spec?.name, savedId: S.route.spec?.savedId, noToll: !!S.route.spec?.noToll }, loop: false, dest: S.route.dest, waypoints: targets }, { fit: false });
    S.sched.seek(5); S.offCount = 0;
    speak('Route updated.');
  } catch (e) { toast('Reroute failed: ' + e.message); }
}

async function keepAwake() {
  try { S.wake = await navigator.wakeLock?.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => { if (S.nav && document.visibilityState === 'visible') keepAwake(); });

function startNav() {
  if (!S.route) return;
  S.nav = true; S.follow = true;
  document.body.classList.add('nav');
  document.querySelectorAll('.sheet').forEach((s) => (s.hidden = true));
  $('notepanel').hidden = false;
  $('btnGo').textContent = 'Stop'; $('btnGo').classList.add('stop');
  $('btnRoute').textContent = '＋ Note';
  setTimeout(paintCompass); // ▲/N while driving
  $('routeChip').hidden = true;
  map.dragging[S.headingUp ? 'disable' : 'enable']();
  S.tracker = new RouteTracker(S.route.samples, S.route.loop);
  S.sched = newScheduler();
  S.offCount = 0; S.prevFix = null; S.speed = 0;
  S.lastS = null; S.sU = 0;
  $('lapInfo').hidden = !S.route.loop; $('lapInfo').textContent = S.route.loop ? (settings.start === 'flying' ? '⏱ TIME ATTACK — clock starts at the line' : 'Waiting for GO') : '';
  const flying = S.route.loop && settings.start === 'flying' && !S.route.spec?.parking;
  S.race = new Race({ total: S.route.total, loop: S.route.loop, laps: S.route.loop ? settings.laps : 1, flying });
  $('raceClock').textContent = '0:00.0';
  S.lastCalled = null; S.ghostSaved = false;
  S.ghost = loadGhost(); $('delta').textContent = S.ghost ? 'ghost ready' : ''; $('delta').className = '';
  S.ghostMarker?.remove(); S.ghostMarker = null;
  S.accCircle?.remove(); S.accCircle = null; // the GPS-accuracy circle is for when you're not driving
  S.clockTimer = setInterval(() => { if (S.race) $('raceClock').textContent = fmtRaceTime(S.race.elapsed(Date.now())); }, 100);
  keepAwake();
  unlockAudio();
  speak('Stage ready.', true); // also unlocks speech on iOS (needs a tap)

  const sim = +$('simSpeed').value;
  const go = () => { S.race.start(Date.now()); if (sim > 0) startSim(sim); };
  if (S.route.spec?.parking) { speak('Parking hunt. Closest streets first.'); go(); }
  else if (flying) { speak('Time attack. The clock starts when you cross the line.'); go(); }
  else countdown(go);
  if (sim > 0) {
    // the simulated car waits on the line until GO
  } else {
    if (!navigator.geolocation) return toast('No GPS on this device');
    S.watch = navigator.geolocation.watchPosition(
      (p) => onFix({ lat: p.coords.latitude, lon: p.coords.longitude, speed: p.coords.speed, heading: p.coords.heading, accuracy: p.coords.accuracy, t: p.timestamp }),
      (e) => toast('GPS: ' + e.message),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  }
}

function startSim(kmh) {
  const target = S.route.loop ? settings.laps : 1;
  const ds = new DriveSim(S.route.samples, S.route.kappa, kmh / 3.6, { loop: S.route.loop, laps: target ? target + 1 : Infinity });
  S.simTimer = setInterval(() => {
    const f = ds.tick(0.5); onFix({ ...f, t: Date.now() });
    if (ds.done && S.simTimer) { clearInterval(S.simTimer); S.simTimer = null; }
  }, 500);
}

// ---------- race start: 3, 2, 1, GO ----------
let actx = null;
function unlockAudio() { try { actx ||= new (window.AudioContext || window.webkitAudioContext)(); actx.resume?.(); } catch {} }
function beep(freq, dur) {
  try {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'square'; o.frequency.value = freq; o.connect(g); g.connect(actx.destination);
    g.gain.setValueAtTime(0.18, actx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + dur);
    o.start(); o.stop(actx.currentTime + dur);
  } catch {}
}
function countdown(go) {
  const el = $('countdown'), num = $('cdNum');
  S.cd = [];
  ['3', '2', '1', 'GO'].forEach((txt, i) => S.cd.push(setTimeout(() => {
    el.hidden = false; num.textContent = txt; num.className = txt === 'GO' ? 'go' : '';
    num.style.animation = 'none'; void num.offsetWidth; num.style.animation = '';
    if (txt === 'GO') { beep(1320, 0.7); speak('Go!', true); go(); S.cd.push(setTimeout(() => (el.hidden = true), 800)); }
    else beep(660, 0.25);
  }, 900 + i * 1000)));
}

function stopNav() {
  S.nav = false;
  document.body.classList.remove('np-full', 'map-full'); $('mapBack').hidden = true;
  S.ghostMarker?.remove(); S.ghostMarker = null;
  (S.cd || []).forEach(clearTimeout); S.cd = []; $('countdown').hidden = true;
  clearInterval(S.clockTimer); S.clockTimer = null;
  if (S.watch != null) navigator.geolocation.clearWatch(S.watch);
  clearInterval(S.simTimer); S.watch = null; S.simTimer = null;
  S.wake?.release?.(); S.wake = null;
  speechSynthesis?.cancel();
  document.body.classList.remove('nav');
  $('notepanel').hidden = true;
  $('btnGo').textContent = 'Start'; $('btnGo').classList.remove('stop');
  $('btnRoute').textContent = 'Route';
  setTimeout(paintCompass); // ◎ (centre on me) when not driving
  if (S.route) paintSummary();
  setRotation(0); map.dragging.enable();
}

$('btnGo').onclick = () => (S.nav ? stopNav() : startNav());
map.on('dragstart', () => { if (S.nav) S.follow = false; });
const paintCompass = () => { $('btnCompass').textContent = !S.nav ? '◎' : S.headingUp ? '▲' : 'N'; $('btnCompass').classList.toggle('on', S.follow && S.nav); };
$('btnCompass').onclick = () => {
  if (!S.nav) { // not driving: centre on where you are
    if (S.fix) map.setView([S.fix.lat, S.fix.lon], Math.max(map.getZoom(), 15));
    else toast('Waiting for GPS…');
    return;
  }
  if (S.nav && !S.follow) S.follow = true;
  else S.headingUp = !S.headingUp;
  if (S.nav) map.dragging[S.headingUp ? 'disable' : 'enable']();
  if (!S.headingUp) setRotation(0);
  paintCompass();
  if (S.fix && S.nav) followCam(S.fix.lat, S.fix.lon);
};
paintCompass();

// ---------- share buttons + opening a shared link ----------
$('chipShare').onclick = shareRoute;
$('btnShare').onclick = shareRoute;
// Open a route from a link hash (shared links and saved routes use the same format).
async function openRouteHash(hash, { label = 'Shared stage', savedId = null, laps = null } = {}) {
  const shared = hashToSpec(hash);
  if (!shared) throw new Error('bad route data');
  for (const r of shared.recce) {
    if (!recce.some((x) => x.lat === r.lat && x.lon === r.lon && x.words.join('|') === r.words.join('|'))) recce.push(r);
  }
  saveRecce();
  if (laps != null) settings.laps = laps;
  S.loop = shared.loop; paintLoop();
  const spec = shared.spec.demo ? { ...buildStage(), raw: true, demo: true } : shared.spec;
  if (shared.name) spec.name = shared.name;
  if (savedId) spec.savedId = savedId;
  toast(`Loading ${shared.name ? '“' + shared.name + '”' : label.toLowerCase()}…`, 8000);
  await buildRoute(spec, shared.loop);
  toast(shared.name ? `“${shared.name}” loaded` : `${label} loaded`);
}

(async () => {
  const shared = hashToSpec(location.hash);
  if (!shared) return;
  try { await openRouteHash(location.hash); } catch (e) { toast('Could not load shared route: ' + e.message); }
})();

// ---------- route name ----------
function setRouteName(v) {
  if (!S.route?.spec) return;
  S.route.spec.name = v.trim().slice(0, 80);
  paintSummary();
}
$('routeName').addEventListener('input', (e) => setRouteName(e.target.value));
$('chipName').onclick = async () => {
  const v = await askText('Route name', S.route?.spec?.name || '', 'e.g. Sunday mountain loop');
  if (v != null) setRouteName(v);
};

// ---------- results ----------
function pbKey() { return 'pb|' + specToHash(S.route.spec, { loop: S.route.loop }) + '|' + (S.route.loop ? settings.laps : 1) + (S.route.loop && settings.start === 'flying' ? '|fly' : ''); } // flying laps are their own records
function finishRace(res) {
  const R = S.route, name = R.spec?.name || '';
  const newGhost = !R.loop && res.ghost ? saveGhost(res.ghost) : false;
  let pbs = {}; try { pbs = JSON.parse(localStorage.getItem('codriver.pb') || '{}'); } catch {}
  const key = pbKey(), prev = pbs[key], isPb = !prev || res.ms < prev;
  if (isPb) { pbs[key] = res.ms; try { localStorage.setItem('codriver.pb', JSON.stringify(pbs)); } catch {} }
  stopNav();
  const unit = settings.units === 'imperial' ? 'miles per hour' : 'kilometres per hour';
  speak(`Finish! ${sayTime(res.ms)}. Average ${Math.round(kmh(res.avg))} ${unit}.${isPb && prev ? ' New personal best!' : ''}`);

  $('resName').textContent = name || 'Unnamed stage';
  const p = routeSvgPath(R.loop ? [...R.points, R.points[0]] : R.points, 300, 170);
  const [sx, sy] = p.start, [ex, ey] = p.end;
  $('resMap').innerHTML = `<path d="${p.d}" class="r-line"/>` +
    (R.loop ? `<circle cx="${sx}" cy="${sy}" r="7" class="r-sf"/>`
            : `<circle cx="${sx}" cy="${sy}" r="6" class="r-start"/><circle cx="${ex}" cy="${ey}" r="7" class="r-sf"/>`);
  $('resTime').textContent = fmtRaceTime(res.ms);
  $('resPb').textContent = isPb ? (prev ? `New personal best! (was ${fmtRaceTime(prev)})` : 'First run — personal best set') : `Personal best ${fmtRaceTime(prev)} (+${fmtRaceTime(res.ms - prev)})`;
  $('resPb').classList.toggle('pb', isPb);
  if (newGhost || S.ghostSaved) $('resPb').textContent += ' · 👻 your best is now the ghost to beat';
  const u = settings.units === 'imperial' ? 'mph' : 'km/h';
  const cells = [
    ['Average speed', `${Math.round(kmh(res.avg))} ${u}`],
    ['Top speed', `${Math.round(kmh(res.top))} ${u}`],
    ['Distance', fmtDist(res.dist)],
    R.loop ? ['Laps', `${res.laps.length}`] : ['Notes called', `${R.notes.length}`],
  ];
  if (res.best) cells.push(['Best lap', fmtRaceTime(res.best)]);
  if (R.loop && res.laps.length) cells.push(['Lap length', fmtDist(R.total)]);
  $('resGrid').innerHTML = cells.map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join('');
  $('resLaps').innerHTML = res.laps.map((ms, i) => `<li class="${ms === res.best ? 'best' : ''}"><span>Lap ${i + 1}</span><b>${fmtRaceTime(ms)}</b></li>`).join('');
  S.lastResult = res;
  openSheet('resultSheet');
}
$('resAgain').onclick = () => { $('resultSheet').hidden = true; startNav(); };
$('resShare').onclick = async () => {
  const R = S.route, res = S.lastResult, name = R.spec?.name || 'Rally stage';
  const u = settings.units === 'imperial' ? 'mph' : 'km/h';
  const url = location.origin + location.pathname + '#' + specToHash(R.spec, { loop: R.loop, name: R.spec?.name || '' });
  const text = `🏁 ${name} — ${fmtRaceTime(res.ms)}${R.loop ? ` · ${res.laps.length} laps (best ${fmtRaceTime(res.best)})` : ''} · avg ${Math.round(kmh(res.avg))} ${u} · ${fmtDist(res.dist)}. Beat it:`;
  try { if (navigator.share) { await navigator.share({ title: name, text, url }); return; } } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text + ' ' + url); toast('Result copied'); } catch { prompt('Copy:', text + ' ' + url); }
};

// ---------- laps on a circuit ----------
function paintLaps() {
  const on = !!S.route?.loop;
  $('lapsRow').hidden = !on; $('startRow').hidden = !on; $('startNote').hidden = !on;
  if (!on) return;
  $('startRow').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.st === (settings.start || 'go')));
  $('startNote').textContent = settings.start === 'flying'
    ? '⏱ Time attack: no countdown. Drive your out lap and the clock starts when you cross the start line (or as you pull away, if you’re parked on it).'
    : '3-2-1 GO: the clock starts on GO.';
  const n = settings.laps;
  $('lapsVal').textContent = n || '∞';
  $('lapsInfo').textContent = n ? `${fmtDist(S.route.total * n)} total · ~${fmtDur(routeSeconds() * n)}` : `${fmtDist(S.route.total)} a lap · no finish`;
}
$('startRow').addEventListener('click', (e) => { const v = e.target.closest('button')?.dataset.st; if (!v) return; settings.start = v; saveSettings(); paintLaps(); });
function setLaps(n) { settings.laps = Math.max(0, Math.min(99, n)); saveSettings(); paintSummary(); }
$('lapsMinus').onclick = () => setLaps(settings.laps === 1 ? 0 : settings.laps === 0 ? 0 : settings.laps - 1);
$('lapsPlus').onclick = () => setLaps(settings.laps === 0 ? 1 : settings.laps + 1);

// ---------- edit the route's points ----------
let editPts = [], editHist = [], editOrig = null, editLayer = null, editBusy = false;
function startEdit() {
  if (!S.route?.spec) return;
  if (S.nav) stopNav();
  const sp = S.route.spec;
  editOrig = { ...sp };
  editPts = (sp.raw ? sp.points : sp.base || sp.via).map((p) => p.slice()); // your points, not the app's hidden pins
  editHist = [];
  S.mode = 'edit';
  document.querySelectorAll('.sheet').forEach((x) => (x.hidden = true));
  $('routeChip').hidden = true; $('editBar').hidden = false;
  S.hitLayer?.options && (S.hitLayer.options.interactive = true);
  drawRoute(false);
  // keep S and F clear of the edit toolbar and the bottom bar
  fitVisible(S.routeLayer.getBounds(), 200, 150, 40);
  drawEditPts();
  toast('Start and destination stay fixed · tap the map or the route to add a point between · drag to move · tap a point to remove', 4500);
}
function drawEditPts() {
  editLayer?.remove();
  const loop = !!S.route.loop, last = editPts.length - 1;
  editLayer = L.layerGroup(editPts.map((p, i) => {
    const lab = i === 0 ? (loop ? 'S/F' : 'S') : (i === last && !loop ? 'F' : String(i));
    // start and destination stay put: you only shape the way in between
    const locked = i === 0 || (i === last && !loop);
    const warn = (S.route.warnPts || []).some((q) => segLen(q, p) < 2);
    const m = L.marker(p, { draggable: !locked, autoPan: true, zIndexOffset: locked ? 1500 : 2000,
      icon: L.divIcon({ className: 'edit-pt' + (i === 0 ? ' first' : i === last && !loop ? ' last' : '') + (locked ? ' locked' : '') + (warn ? ' warn' : ''), html: warn ? '⚠' + lab : lab, iconSize: [30, 30] }) });
    m.on('dragend', (e) => { const ll = e.target.getLatLng(); editPush(); editPts[i] = [ll.lat, ll.lng]; rebuildEdit(); });
    m.on('click', () => {
      if (locked) return toast(i === 0 ? 'Start is fixed — use “From here” to start where you are' : 'Destination is fixed — pick a new destination to change it');
      editPush(); editPts.splice(i, 1); rebuildEdit();
    });
    return m;
  })).addTo(map);
  $('editUndo').disabled = !editHist.length;
}
function editPush() { editHist.push(editPts.map((p) => p.slice())); }
// tap on the map: the new point goes between the two points it fits best (never moves the destination)
// tap on the map: the NEXT checkpoint, in the order you tap (before the destination; at the end on a circuit).
// To put a point between two others, tap the route line there instead.
function editAppend(ll) {
  editPush();
  const at = S.route.loop ? editPts.length : editPts.length - 1;
  editPts.splice(at, 0, ll);
  toast(`Checkpoint ${at} added — the route goes through your checkpoints in this order`, 2500);
  rebuildEdit();
}
function onRouteTap(e) {
  if (S.mode !== 'edit') return;
  L.DomEvent.stopPropagation(e);
  const ll = [e.latlng.lat, e.latlng.lng];
  // where along the route was the tap, and where are the points? insert in between
  const t = new RouteTracker(S.route.samples), sTap = t.locate(ll[0], ll[1]).s;
  const t2 = new RouteTracker(S.route.samples);
  const sPts = editPts.map((p, i) => (i === 0 ? 0 : t2.locate(p[0], p[1]).s));
  let at = editPts.length;
  for (let i = 1; i < sPts.length; i++) if (sTap < sPts[i]) { at = i; break; }
  editPush(); editPts.splice(at, 0, ll); rebuildEdit();
}
async function rebuildEdit() {
  drawEditPts();
  if (editBusy) { editBusy = 'again'; return; }
  editBusy = true;
  const base = S.route.spec;
  const spec = base.raw ? { raw: true, points: editPts.map((p) => p.slice()), name: base.name, savedId: base.savedId }
    : { via: editPts.map((p) => p.slice()), name: base.name, savedId: base.savedId, noToll: !!base.noToll, mode: base.mode === 'explore' ? undefined : base.mode }; // re-plans around your points, in your order (explore would re-roll on every tap)
  try { await buildRoute(spec, S.route.loop, { fit: false }); }
  catch (err) { toast('Routing failed: ' + err.message); }
  const again = editBusy === 'again';
  editBusy = false;
  if (S.mode === 'edit') {
    const sp = S.route.spec;
    editPts = (sp.raw ? sp.points : sp.base || sp.via).map((p) => p.slice());
    drawRoute(false); drawEditPts();
  }
  if (again) rebuildEdit();
}
function endEdit(keep) {
  S.mode = 'idle'; editLayer?.remove(); editLayer = null; $('editBar').hidden = true;
  if (S.hitLayer) S.hitLayer.options.interactive = false;
  if (!keep && editOrig) buildRoute(editOrig, S.route?.loop, { fit: false }).catch(() => {});
  else if (S.route) { drawRoute(false); paintSummary(); }
}
$('editHere').onclick = async () => {
  const here = await currentPos();
  editPush(); editPts[0] = here; rebuildEdit(); toast('Start moved to your location');
};
$('editUndo').onclick = () => { if (!editHist.length) return; editPts = editHist.pop(); rebuildEdit(); };
$('editDone').onclick = () => { endEdit(true); toast('Route updated'); };
$('editCancel').onclick = () => endEdit(false);
$('btnEdit').onclick = startEdit;
$('chipEdit').onclick = startEdit;

// ---------- my routes (saved on this phone) ----------
function myRoutes() { try { return JSON.parse(localStorage.getItem('codriver.routes') || '[]'); } catch { return []; } }
function putRoutes(list) { try { localStorage.setItem('codriver.routes', JSON.stringify(list)); return true; } catch { toast('Not saved — this browser is blocking saved data (Private tab or “Block All Cookies”). Use a normal tab, or Export a backup.', 6000); return false; } }
async function saveRoute() {
  const R = S.route; if (!R?.spec) return;
  let name = R.spec.name;
  if (!name) {
    const d = new Date();
    name = await askText('Name this route', `Route ${d.getDate()}/${d.getMonth() + 1} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`);
    if (name == null) return;
    name = name.trim().slice(0, 80) || 'Untitled route';
    R.spec.name = name;
  }
  const list = myRoutes();
  const entry = {
    id: R.spec.savedId || Date.now().toString(36), name,
    hash: specToHash(R.spec, { loop: R.loop, name }), loop: !!R.loop, laps: R.loop ? settings.laps : null,
    dist: R.total, notes: R.notes.length, savedAt: Date.now(), dest: R.loop ? null : R.dest,
  };
  const i = list.findIndex((x) => x.id === entry.id);
  if (i >= 0) list[i] = entry; else list.unshift(entry);
  if (!putRoutes(list)) return;
  R.spec.savedId = entry.id;
  paintSummary();
  toast(i >= 0 ? `“${name}” updated` : `“${name}” saved to My routes`);
}
function renderMyRoutes() {
  const list = myRoutes();
  $('myRoutesList').innerHTML = list.length ? list.map((r) => `
    <li data-id="${r.id}">
      <button class="mr-open"><b>${r.name.replace(/</g, '&lt;')}</b>
        <small>${fmtDist(r.dist)}${r.loop ? ` lap · ${r.laps ? r.laps + ' laps' : '∞ laps'}` : ''} · ${r.notes} notes · ${new Date(r.savedAt).toLocaleDateString()}</small></button>
      <button class="mr-ren round" title="Rename">✎</button>
      <button class="mr-del round" title="Delete">🗑</button>
    </li>`).join('') : '<li class="empty">No saved routes yet. Make a route, then tap ☆ (or Save route) to keep it here.</li>';
}
$('myRoutesList').addEventListener('click', async (e) => {
  const li = e.target.closest('li[data-id]'); if (!li) return;
  const list = myRoutes(), r = list.find((x) => x.id === li.dataset.id); if (!r) return;
  if (e.target.closest('.mr-del')) {
    if (!confirm(`Delete “${r.name}”?`)) return;
    putRoutes(list.filter((x) => x.id !== r.id)); renderMyRoutes(); if (S.route) paintSummary(); return;
  }
  if (e.target.closest('.mr-ren')) {
    const v = await askText('Rename route', r.name); if (v == null || !v.trim()) return;
    const q = hashToSpec(r.hash); r.name = v.trim().slice(0, 80);
    r.hash = specToHash(q.spec.demo ? { demo: true } : q.spec, { loop: q.loop, name: r.name, recce: q.recce });
    putRoutes(list); renderMyRoutes();
    if (S.route?.spec?.savedId === r.id) { S.route.spec.name = r.name; paintSummary(); }
    return;
  }
  if (S.nav) stopNav();
  $('myRoutesSheet').hidden = true;
  try { await openRouteHash(r.hash, { savedId: r.id, laps: r.laps }); } catch (err) { toast('Could not open: ' + err.message); }
});
$('btnMyRoutes').onclick = () => { renderMyRoutes(); openSheet('myRoutesSheet'); };
$('btnSave').onclick = saveRoute;
$('chipSave').onclick = saveRoute;

// ---------- my places ----------
const PLACE_ICONS = ['⭐', '🏠', '💼', '🍴', '☕', '⛽', '🏁', '🏋️', '🛒', '🏥', '🎓', '📍'];
function guessIcon(name) {
  const n = name.toLowerCase();
  if (/home|house|casa/.test(n)) return '🏠';
  if (/work|office|studio|shop|job/.test(n)) return '💼';
  if (/pizza|food|restaurant|burger|taco|sushi|diner|grill|kitchen|bbq|steak|bar\b/.test(n)) return '🍴';
  if (/coffee|cafe|café/.test(n)) return '☕';
  if (/gas|fuel|petrol|shell|exxon/.test(n)) return '⛽';
  if (/track|circuit|raceway|karting|speedway/.test(n)) return '🏁';
  if (/gym|fitness/.test(n)) return '🏋️';
  if (/market|grocery|store|mall/.test(n)) return '🛒';
  return '⭐';
}
function myPlaces() { try { return JSON.parse(localStorage.getItem('codriver.places') || '[]'); } catch { return []; } }
function putPlaces(list) {
  let ok = true;
  try { localStorage.setItem('codriver.places', JSON.stringify(list)); } catch { ok = false; toast('Not saved — this browser is blocking saved data (Private tab or “Block All Cookies”). Use a normal tab, or Export a backup.', 6000); }
  drawPlaces(); paintPlaceChips(); return ok;
}
async function addPlace(lat, lon, suggested = '') {
  const name = await askText('Name this place', suggested, 'Home, Work, Joe’s Pizza…');
  if (name == null || !name.trim()) return;
  const p = { id: Date.now().toString(36), name: name.trim().slice(0, 60), icon: guessIcon(name), lat, lon };
  if (!putPlaces([p, ...myPlaces()])) return;
  toast(`${p.icon} “${p.name}” saved to My places`);
  return p;
}
function drawPlaces() {
  S.placeLayer?.remove();
  S.placeLayer = L.layerGroup(myPlaces().map((p) => L.marker([p.lat, p.lon], {
    icon: L.divIcon({ className: 'place-pin', html: p.icon, iconSize: [30, 30] }), zIndexOffset: 500,
  }).on('click', (e) => { if (S.nav || S.mode === 'edit') return; L.DomEvent.stopPropagation(e); openPlace(p.id); }))).addTo(map);
}
function paintPlaceChips() {
  const list = myPlaces().slice(0, 6);
  $('placeChips').innerHTML = list.map((p) => `<button data-id="${p.id}">${p.icon} ${p.name.replace(/</g, '&lt;')}</button>`).join('');
  $('placeChips').hidden = !list.length;
}
$('placeChips').addEventListener('click', (e) => { const id = e.target.closest('button')?.dataset.id; if (id) openPlace(id); });
const distFromMe = (p) => (S.fix ? fmtDist(segLen([S.fix.lat, S.fix.lon], [p.lat, p.lon])) + ' away' : '');
function renderPlaces() {
  const list = myPlaces();
  $('placesList').innerHTML = list.length ? list.map((p) => `
    <li data-id="${p.id}"><button class="mr-open"><b>${p.icon} ${p.name.replace(/</g, '&lt;')}</b><small>${distFromMe(p)}</small></button></li>`).join('')
    : '<li class="empty">No places yet. Save where you are, long-press the map, or tap 📍 on a search result.</li>';
}
$('placesList').addEventListener('click', (e) => { const id = e.target.closest('li[data-id]')?.dataset.id; if (id) openPlace(id); });
$('btnPlaces').onclick = () => { renderPlaces(); openSheet('placesSheet'); };
$('btnSaveHere').onclick = async () => { const [la, lo] = await currentPos(); await addPlace(la, lo); renderPlaces(); openSheet('placesSheet'); };

// One place: go now, open a saved route to it, or plan your own way there.
let curPlace = null;
function routesTo(p) {
  return myRoutes().filter((r) => {
    let d = r.dest;
    if (!d && !r.loop) { const q = hashToSpec(r.hash); d = q?.spec.via?.at(-1) || q?.spec.points?.at(-1); }
    return d && segLen(d, [p.lat, p.lon]) < 150;
  });
}
function openPlace(id) {
  const p = myPlaces().find((x) => x.id === id); if (!p) return;
  curPlace = p;
  $('plTitle').textContent = `${p.icon} ${p.name}`;
  $('plWhere').textContent = distFromMe(p);
  const rs = routesTo(p);
  $('plRoutes').innerHTML = rs.length
    ? rs.map((r) => `<li data-id="${r.id}"><button class="mr-open"><b>${r.name.replace(/</g, '&lt;')}</b><small>${fmtDist(r.dist)} · ${r.notes} notes</small></button></li>`).join('')
    : '<li class="empty">No saved routes to here yet — plan one with your own points, then ☆ save it.</li>';
  openSheet('placeSheet');
}
$('plGo').onclick = () => { $('placeSheet').hidden = true; routeTo([curPlace.lat, curPlace.lon], { name: `To ${curPlace.name}`, oneWay: true }); };
$('plPlan').onclick = async () => {
  $('placeSheet').hidden = true;
  if (await routeTo([curPlace.lat, curPlace.lon], { name: `To ${curPlace.name}`, oneWay: true })) {
    startEdit();
    toast('Tap the map where you want the route to go — your start and the destination stay fixed', 5000);
  }
};
$('plRoutes').addEventListener('click', async (e) => {
  const id = e.target.closest('li[data-id]')?.dataset.id; if (!id) return;
  const r = myRoutes().find((x) => x.id === id); if (!r) return;
  $('placeSheet').hidden = true;
  try { await openRouteHash(r.hash, { savedId: r.id, laps: r.laps }); } catch (err) { toast('Could not open: ' + err.message); }
});
$('plRename').onclick = async () => {
  const v = await askText('Rename place', curPlace.name); if (v == null || !v.trim()) return;
  const list = myPlaces(), p = list.find((x) => x.id === curPlace.id);
  p.name = v.trim().slice(0, 60); putPlaces(list); openPlace(p.id);
};
$('plIcon').onclick = () => {
  const list = myPlaces(), p = list.find((x) => x.id === curPlace.id);
  p.icon = PLACE_ICONS[(PLACE_ICONS.indexOf(p.icon) + 1) % PLACE_ICONS.length]; putPlaces(list); openPlace(p.id);
};
$('plDelete').onclick = () => {
  if (!confirm(`Delete “${curPlace.name}”?`)) return;
  putPlaces(myPlaces().filter((x) => x.id !== curPlace.id)); $('placeSheet').hidden = true; toast('Place deleted');
};
drawPlaces(); paintPlaceChips();

// ---------- route options: fastest / shortest / no tolls / smooth / explore ----------
const MODES = { fastest: '⚡ Fastest', shortest: '📏 Shortest', smooth: '〰️ Smooth', explore: '🎲 Explore' };
function paintModes() {
  const sp = S.route?.spec, ok = sp && !sp.raw;
  $('vehRow').hidden = !ok; $('vehHead').hidden = !ok; $('bikeNote').hidden = !(ok && sp.vehicle === 'bike');
  if (ok) $('vehRow').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === (sp.vehicle || 'car')));
  $('filterRow').hidden = !ok; $('typeHead').hidden = !ok; $('filterHead').hidden = !ok;
  $('modeRow').hidden = !ok;
  if (!ok) return;
  const bike = sp.vehicle === 'bike';
  let cur = sp.mode === 'notoll' ? 'fastest' : sp.mode || 'fastest'; if (bike && cur === 'fastest') cur = 'shortest';
  const info = S.modeInfo || {};
  const nt = !!sp.noToll || sp.mode === 'notoll';
  const roundable = S.route.loop && (sp.base || sp.via).length === 2;
  const f = (key, on, label, sub) => `<button data-f="${key}" class="filter ${on ? 'on' : ''}">${on ? '✓ ' : ''}${label}<small>${sub}</small></button>`;
  $('filterRow').innerHTML =
    f('toll', nt, '💸 Avoid tolls', nt ? 'on — for every route' : 'off') +
    (roundable ? f('round', settings.round !== 'off', '🔁 No repeated roads', settings.round !== 'off' ? (info[cur]?.info?.includes('repeated') ? info[cur].info : 'round circuit') : 'off') : '') +
    f('tidy', settings.smooth !== 'off', '🧹 Skip loops & U-turns', settings.smooth !== 'off' ? 'on — only points the app adds' : 'off');
  $('modeRow').innerHTML =
    Object.entries(MODES).filter(([m]) => !(bike && m === 'fastest')).map(([m, label]) => { // a bike always takes the shortest way
      const i = info[m];
      const sub = i ? `${fmtDist(i.dist)} · ${fmtDur(i.dur)}${i.info ? ' · ' + i.info : ''}` : m === 'explore' && cur === 'explore' ? 'tap for another' : '';
      return `<button data-m="${m}" class="${m === cur ? 'on' : ''}">${label}${sub ? `<small>${sub}</small>` : ''}</button>`;
    }).join('');
  $('modeRow').scrollLeft = 0; // keep the filter and first options in view
}
$('modeRow').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  const m = btn?.dataset.m; if (!m || !S.route?.spec || S.busyMode) return;
  const sp = S.route.spec, cur = sp.mode || 'fastest';
  if (m === cur && m !== 'explore') return;
  const base = sp.base || sp.via; // your points (A, any in-between, B — or the circuit's points)
  S.busyMode = true;
  toast(m === 'smooth' ? 'Looking for the smoothest way (checking several routes)…' : m === 'explore' ? 'Rolling the dice…' : `Routing: ${MODES[m]}…`, 9000);
  try {
    await buildRoute({ via: base, mode: m, name: sp.name, savedId: sp.savedId, noToll: !!sp.noToll }, S.route.loop, { fit: false });
    fitVisible(S.routeLayer.getBounds(), 200, 130);
    const i = S.modeInfo?.[m];
    toast(`${MODES[m]}: ${fmtDist(S.route.total)} · ~${fmtDur(routeSeconds())}${i?.info ? ' · ' + i.info : ''}`);
  } catch (err) { toast('Routing failed: ' + err.message); }
  S.busyMode = false;
});

// The toll filter works with every route type and sticks for new routes until switched off.
async function toggleTolls() {
  if (!S.route?.spec || S.busyMode) return;
  const sp = S.route.spec, nt = !(sp.noToll || sp.mode === 'notoll');
  settings.noToll = nt; saveSettings();
  const mode = sp.mode === 'notoll' ? 'fastest' : sp.mode || 'fastest';
  // smooth re-plans from A→B under the new filter; explore keeps its points; others keep yours
  // re-plan shortest/smooth from your points under the new filter; explore keeps its random points
  const via = (mode === 'smooth' || mode === 'shortest') && sp.base ? sp.base : sp.via;
  S.busyMode = true;
  toast(nt ? 'Avoiding tolls…' : 'Tolls allowed…', 8000);
  try {
    await buildRoute({ ...sp, via, mode, noToll: nt, planned: mode === 'explore' ? sp.planned : false }, S.route.loop, { fit: false });
    const t = S.route.tolls;
    toast(nt ? (t ? `Tolls avoided where possible (${t} left)` : '💸 Avoiding tolls — toll-free') : 'Tolls allowed');
  } catch (err) { toast('Routing failed: ' + err.message); }
  S.busyMode = false;
}

// filters on the route page
$('filterRow').addEventListener('click', async (e) => {
  const k = e.target.closest('button')?.dataset.f; if (!k || !S.route?.spec || S.busyMode) return;
  if (k === 'toll') return toggleTolls();
  if (k === 'round') settings.round = settings.round === 'off' ? 'on' : 'off';
  if (k === 'tidy') settings.smooth = settings.smooth === 'off' ? 'on' : 'off';
  saveSettings();
  const sp = S.route.spec;
  S.busyMode = true;
  toast(k === 'round' ? (settings.round === 'on' ? 'Finding a round circuit with no repeated roads…' : 'Repeated roads allowed…') : 'Re-planning…', 9000);
  try {
    await buildRoute({ ...sp, via: sp.base || sp.via, planned: false }, S.route.loop, { fit: false });
    const i = S.modeInfo?.[sp.mode || 'fastest'];
    toast(`${fmtDist(S.route.total)}${S.route.loop ? ' lap' : ''} · ~${fmtDur(routeSeconds())}${i?.info ? ' · ' + i.info : ''}`);
  } catch (err) { toast('Routing failed: ' + err.message); }
  S.busyMode = false;
});
$('chipOpts').onclick = () => openSheet('routeSheet');

// ---------- ghost lap ----------
const ghostKey = () => 'ghost|' + specToHash(S.route.spec, { loop: S.route.loop });
function loadGhost() {
  try { return JSON.parse(localStorage.getItem('codriver.ghosts') || '{}')[ghostKey()] || null; } catch { return null; }
}
// keep the ghost only if it's faster than the one we have
function saveGhost(g) {
  if (!g?.trace?.length) return false;
  let all = {}; try { all = JSON.parse(localStorage.getItem('codriver.ghosts') || '{}'); } catch {}
  const k = ghostKey(), old = all[k];
  if (old && old.ms <= g.ms) return false;
  all[k] = g;
  try { localStorage.setItem('codriver.ghosts', JSON.stringify(all)); } catch { return false; }
  return true;
}
function paintGhost(now, sNow) {
  const g = S.ghost, seg = S.race.segment(now, sNow);
  if (!g || !seg) return;
  const d = ghostDelta(g.trace, seg.elapsed, seg.dist);
  if (d != null) {
    $('delta').textContent = (d > 0 ? '+' : '−') + (Math.abs(d) / 1000).toFixed(1) + ' s';
    $('delta').className = d > 0 ? 'behind' : 'ahead';
  }
  // the ghost car: where your best run was at this moment
  const gd = ghostDistAt(g.trace, seg.elapsed);
  if (gd == null) return;
  const len = S.route.total, segS = sNow - seg.dist;
  let s = segS + gd; if (S.route.loop) s = ((s % len) + len) % len;
  const sm = S.route.samples, p = sm[Math.max(0, Math.min(sm.length - 1, Math.round(s / (sm[1].s - sm[0].s))))];
  if (!S.ghostMarker) S.ghostMarker = L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'ghost-marker', iconSize: [30, 30], html: '<svg viewBox="0 0 40 40"><path d="M20 3 L34 35 L20 27 L6 35 Z"/></svg>' }), interactive: false, zIndexOffset: 900 }).addTo(map);
  else S.ghostMarker.setLatLng([p.lat, p.lon]);
}

// ---------- fix a call ----------
let fixTarget = null;
const fixWords = (n, g) => (g === 'H' ? `Hairpin ${n.dir}` : g === 'F' ? `Flat ${n.dir}` : `${n.dir[0].toUpperCase() + n.dir.slice(1)} ${g}`);
function openFix(n) {
  if (!n) return toast('No call to fix yet');
  fixTarget = n;
  const label = n.label || n.text || '';
  $('fixWhat').textContent = `Called: “${label}”` + (n.fixed ? ' (already fixed by you)' : '');
  const cornerish = (n.kind === 'corner' || n.kind === 'junction') && n.dir;
  $('fixGrades').innerHTML = cornerish
    ? ['H', 1, 2, 3, 4, 5, 6, 'F'].map((g) => `<button data-g="${g}">${fixWords(n, g)}</button>`).join('') +
      `<button data-shape="square">Square ${n.dir}</button><button data-shape="acute">Acute ${n.dir}</button>`
    : '<p class="fine">This isn\'t a corner — you can remove it, or add recce words.</p>';
  $('fixHead').hidden = !cornerish;
  $('fixUndo').hidden = !n.fixed;
  $('fixNone').textContent = cornerish ? '🔇 Remove this call' : '🔇 Remove this call';
  S.reviewFocus = [n.lat, n.lon];
  openSheet('fixSheet');
}
function saveFix(fx) {
  const n = fixTarget;
  if (fx.none && n.kind === 'recce') { // your own recce words: just delete them
    recce = recce.filter((r) => !(n.recce || []).includes(r.id)); saveRecce();
    $('fixSheet').hidden = true; regen('Recce note removed'); return;
  }
  fixes = fixes.filter((f) => f.id !== n.fixed && segLen([f.lat, f.lon], [n.lat, n.lon]) > 15); // replaces an older fix here
  fixes.push({ id: Date.now().toString(36), lat: n.lat, lon: n.lon, was: typeof n.grade === 'number' ? n.grade : null, ...fx });
  saveFixes(); $('fixSheet').hidden = true;
  regen(fx.none ? 'Removed — this call won’t be made again' : `Saved — next time: ${fx.shape ? `${fx.shape} ${n.dir}` : fixWords(n, fx.grade).toLowerCase()}`);
  paintCal();
}
$('fixGrades').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || !fixTarget) return;
  if (b.dataset.shape) return saveFix({ shape: b.dataset.shape });
  const g = b.dataset.g; saveFix({ grade: g === 'H' || g === 'F' ? g : +g });
});
$('fixNone').onclick = () => fixTarget && saveFix({ none: true });
$('fixUndo').onclick = () => {
  fixes = fixes.filter((f) => f.id !== fixTarget.fixed); saveFixes();
  $('fixSheet').hidden = true; regen('Your fix was removed'); paintCal();
};
$('fixRecce').onclick = () => { const n = fixTarget; $('fixSheet').hidden = true; openRecce({ lat: n.lat, lon: n.lon, note: n }); };
// while driving: fix the call that was just made (or the one coming up)
$('fixBtn').onclick = (e) => { e.stopPropagation(); fixLast(); };
const fixLast = () => openFix(S.lastCalled || S.sched?.upcoming(S.route.loop ? S.sU : S.lastOnRouteS || 0)?.note);

// calibration: your fixes tell us if the grades run fast or slow for you
function paintCal() {
  const d = fixes.filter((f) => typeof f.grade === 'number' && typeof f.was === 'number').map((f) => f.grade - f.was);
  if (!d.length) { $('calHint').textContent = 'Fix a few calls while driving and this will suggest a setting.'; return; }
  const avg = d.reduce((a, b) => a + b, 0) / d.length, sug = Math.max(-1, Math.min(1, Math.round(avg)));
  $('calHint').textContent = `From your ${d.length} fix${d.length > 1 ? 'es' : ''}: calls are on average ${Math.abs(avg).toFixed(1)} grade ${avg < 0 ? 'too fast' : 'too slow'}` +
    (sug !== +settings.cal ? ` — suggested: ${sug < 0 ? 'Tighter' : sug > 0 ? 'Faster' : 'Normal'}` : ' — your setting matches');
}
bindSeg('setCal', 'cal');
$('setCal').addEventListener('click', () => regen(settings.cal === '-1' ? 'Calls one grade tighter' : settings.cal === '1' ? 'Calls one grade faster' : 'Calls as measured'));
paintCal();

// ---------- ask for a name (in-app, works in Home Screen apps where prompt() may not) ----------
function askText(title, value = '', placeholder = '') {
  return new Promise((resolve) => {
    $('askTitle').textContent = title;
    const inp = $('askInput'); inp.value = value; inp.placeholder = placeholder;
    const prev = [...document.querySelectorAll('.sheet')].find((x) => !x.hidden);
    openSheet('askSheet');
    setTimeout(() => { inp.focus(); inp.select(); }, 50);
    const done = (v) => {
      $('askSheet').hidden = true; $('askForm').onsubmit = null; $('askCancel').onclick = null;
      if (prev && prev.id !== 'askSheet' && v == null) prev.hidden = false; // cancelled: go back where you were
      resolve(v);
    };
    $('askForm').onsubmit = (e) => { e.preventDefault(); done(inp.value.trim() || null); };
    $('askCancel').onclick = () => done(null);
  });
}

// ---------- is this browser keeping our data? ----------
(function checkStorage() {
  let ok = true;
  try { localStorage.setItem('codriver.__t', '1'); ok = localStorage.getItem('codriver.__t') === '1'; localStorage.removeItem('codriver.__t'); } catch { ok = false; }
  if (!ok) { $('storeWarn').hidden = false; return; }
  navigator.storage?.persist?.().catch(() => {}); // ask the browser not to clear us when space is low
})();
$('storeWarn').onclick = () => { $('storeWarn').hidden = true; };

// ---------- backup: everything you've saved, to a file and back ----------
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const BACKUP_KEYS = ['codriver.places', 'codriver.routes', 'codriver.recce', 'codriver.fixes', 'codriver.ghosts', 'codriver.pb', 'codriver.settings'];
async function exportBackup() {
  const data = { app: 'codriver', version: 1, exported: new Date().toISOString() };
  for (const k of BACKUP_KEYS) { try { data[k] = JSON.parse(localStorage.getItem(k) || 'null'); } catch { data[k] = null; } }
  const n = (data['codriver.places'] || []).length, r = (data['codriver.routes'] || []).length;
  const name = `codriver-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  try { // iPhone: share sheet → Save to Files / AirDrop / Messages
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: 'Co-Driver backup' }); toast(`Backup ready: ${plural(n, 'place')}, ${plural(r, 'route')}`); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`Backup saved: ${plural(n, 'place')}, ${plural(r, 'route')}`);
}
function mergeById(cur, add) { const ids = new Set(cur.map((x) => x.id)); return [...cur, ...(add || []).filter((x) => x && !ids.has(x.id))]; }
function mergeFaster(cur, add, ms = (v) => v) { const out = { ...cur }; for (const [k, v] of Object.entries(add || {})) if (out[k] == null || ms(v) < ms(out[k])) out[k] = v; return out; }
async function importBackup(file) {
  let data; try { data = JSON.parse(await file.text()); } catch { return toast('That file isn’t a Co-Driver backup'); }
  if (data?.app !== 'codriver') return toast('That file isn’t a Co-Driver backup');
  const get = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
  const before = myPlaces().length + myRoutes().length;
  const write = {
    'codriver.places': mergeById(get('codriver.places', []), data['codriver.places']),
    'codriver.routes': mergeById(get('codriver.routes', []), data['codriver.routes']),
    'codriver.recce': mergeById(get('codriver.recce', []), data['codriver.recce']),
    'codriver.fixes': mergeById(get('codriver.fixes', []), data['codriver.fixes']),
    'codriver.ghosts': mergeFaster(get('codriver.ghosts', {}), data['codriver.ghosts'], (g) => g.ms),
    'codriver.pb': mergeFaster(get('codriver.pb', {}), data['codriver.pb']),
  };
  try { for (const [k, v] of Object.entries(write)) localStorage.setItem(k, JSON.stringify(v)); }
  catch { return toast('Couldn’t import — this browser is blocking saved data (Private tab?)', 6000); }
  recce = write['codriver.recce']; fixes = write['codriver.fixes'];
  drawPlaces(); paintPlaceChips(); paintCal(); if (S.route) regen();
  const added = myPlaces().length + myRoutes().length - before;
  toast(`Backup imported: ${plural(write['codriver.places'].length, 'place')}, ${plural(write['codriver.routes'].length, 'route')} (${added} new)`);
}
$('btnExport').onclick = exportBackup;
$('btnImport').onclick = () => $('importFile').click();
$('importFile').onchange = (e) => { const f = e.target.files?.[0]; if (f) importBackup(f); e.target.value = ''; };

// ---------- 🅿️ parking hunt: every street within a radius, closest first ----------
let huntTarget = null;
const huntUnit = () => (settings.units === 'imperial' ? 'mi' : 'm');
function paintHuntRadius() {
  const r = settings.huntRadius;
  $('huntRange').value = Math.min(5000, r);
  $('huntValue').value = settings.units === 'imperial' ? (r / 1609.34).toFixed(2) : Math.round(r);
  $('huntUnit').textContent = huntUnit();
  $('huntMain').checked = settings.huntMain === 'on';
}
function openHunt(ll, label) {
  huntTarget = { lat: ll[0], lon: ll[1], label };
  $('huntWhere').textContent = `Around ${label}`;
  $('huntStatus').textContent = '';
  paintHuntRadius();
  openSheet('huntSheet');
}
$('huntRange').oninput = (e) => { settings.huntRadius = +e.target.value; saveSettings(); paintHuntRadius(); };
$('huntValue').onchange = (e) => {
  const v = parseFloat(e.target.value); if (!(v > 0)) return paintHuntRadius();
  settings.huntRadius = Math.max(50, Math.min(10000, settings.units === 'imperial' ? v * 1609.34 : v));
  saveSettings(); paintHuntRadius();
};
$('huntMain').onchange = (e) => { settings.huntMain = e.target.checked ? 'on' : 'off'; saveSettings(); };

async function fetchStreets(lat, lon, radius, main) {
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), radius > 1500 ? 100000 : 50000);
  try {
    const res = await fetch(OVERPASS, { method: 'POST', body: 'data=' + encodeURIComponent(overpassQuery(lat, lon, radius, main)),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
    if (!res.ok) throw new Error(res.status === 429 ? 'map server busy, try again in a minute' : 'map server error ' + res.status);
    return await res.json();
  } finally { clearTimeout(tm); }
}

const HUNT_BATCH = 15000; // metres of driving per batch; big radii continue in more batches
async function planHuntRoute(from, { cont = false } = {}) {
  const H = S.hunt;
  const h = planHunt(H.g, from, { maxLength: HUNT_BATCH, done: cont ? H.done : null });
  if (!h.points.length || !h.covered) throw new Error(cont ? 'no more streets to search' : 'no drivable streets found here');
  H.done = h.done; H.remaining = h.remaining; H.total = h.total; H.batch = (cont ? H.batch : 0) + 1;
  // get there first (unless you're already at the start)
  let points = h.points, steps = h.turns;
  const here = S.fix ? [S.fix.lat, S.fix.lon] : null;
  if (here && segLen(here, h.points[0]) > 120) {
    try {
      VEHICLE = 'car';
      const a = await osrmRoute([here, h.points[0]]);
      points = [...a.points, ...h.points.slice(1)];
      let approach = 0; for (let i = 1; i < a.points.length; i++) approach += segLen(a.points[i - 1], a.points[i]);
      steps = [...a.steps.filter((st) => st.maneuver.type !== 'arrive').map(({ distance, ...st }) => st),
        ...h.turns.map((t) => ({ ...t, _s: t._s + approach }))]; // hunt turns keep their exact position
    } catch { /* no approach route: start the hunt where it is */ }
  }
  const name = `🅿️ Parking · ${H.label}` + (H.batch > 1 ? ` (${H.batch})` : '');
  S.loop = false; paintLoop();
  // time: getting there at town speed, then the hunt itself at ~15 km/h (looking for a spot)
  let total = 0; for (let i = 1; i < points.length; i++) total += segLen(points[i - 1], points[i]);
  const duration = (total - h.length) / (35 / 3.6) + h.length / (15 / 3.6);
  setRoute({ points, steps, duration, spec: { raw: true, points, steps, name, parking: { lat: H.lat, lon: H.lon, r: H.radius } }, loop: false,
    dest: points.at(-1), waypoints: [points.at(-1)] });
  // the search area
  S.huntCircle?.remove();
  S.huntCircle = L.circle([H.lat, H.lon], { radius: H.radius, color: '#4aa3ff', weight: 2, dashArray: '6 8', fillOpacity: 0.05, interactive: false }).addTo(map);
  const mins = Math.round(duration / 60);
  return `${plural(h.covered, 'street')} nearest ${H.label} · ${fmtDist(h.length)} · ~${mins} min` +
    (h.remaining ? ` — ${h.remaining} more further out (Continue later)` : '') + (h.unreachable ? ` · ${h.unreachable} unreachable` : '');
}

$('huntGo').onclick = async () => {
  if (!huntTarget) return;
  const { lat, lon, label } = huntTarget, radius = settings.huntRadius, main = settings.huntMain === 'on';
  $('huntGo').disabled = true;
  $('huntStatus').textContent = radius > 1500 ? 'Downloading streets (big area — this can take up to a minute)…' : 'Downloading streets…';
  try {
    const osm = await fetchStreets(lat, lon, radius, main);
    $('huntStatus').textContent = 'Planning the hunt…';
    await new Promise((r) => setTimeout(r, 30)); // let the screen update
    const g = buildGraph(osm, [lat, lon], radius);
    S.hunt = { g, lat, lon, radius, label, done: null };
    const msg = await planHuntRoute([lat, lon]);
    $('huntSheet').hidden = true;
    toast(msg, 7000);
  } catch (err) {
    $('huntStatus').textContent = 'Couldn’t plan: ' + (err.name === 'AbortError' ? 'the map server took too long — try a smaller radius' : err.message);
  }
  $('huntGo').disabled = false;
};

// end of a batch: found nothing yet? keep going, further out
function finishHunt() {
  stopNav();
  const H = S.hunt;
  if (!H || !H.remaining) { speak('Hunt complete. Every street searched.'); toast('Every street in the area has been searched'); return; }
  $('huntDoneText').textContent = `Searched batch ${H.batch}. ${H.remaining} streets left further out in your ${fmtDist(H.radius)} radius.`;
  openSheet('huntDoneSheet');
  speak('End of this batch. Continue the hunt?');
}
$('huntContinue').onclick = async () => {
  $('huntDoneSheet').hidden = true;
  toast('Planning the next streets…', 8000);
  try {
    const from = S.fix ? [S.fix.lat, S.fix.lon] : S.route.points.at(-1);
    toast(await planHuntRoute(from, { cont: true }), 6000);
    startNav();
  } catch (err) { toast('Couldn’t continue: ' + err.message); }
};
$('huntStop').onclick = () => { $('huntDoneSheet').hidden = true; };
$('plPark').onclick = () => openHunt([curPlace.lat, curPlace.lon], `${curPlace.icon} ${curPlace.name}`);
$('btnHunt').onclick = () => { if (S.route) openHunt(S.route.dest || S.route.points.at(-1), S.route.spec?.name?.replace(/^To /, '') || 'your destination'); };

// ---------- 🔍 review all the calls on the map ----------
let rv = 0;
function startReview() {
  if (!S.route) return toast('Make a route first');
  if (S.nav) stopNav();
  if (S.mode === 'edit') endEdit(true);
  S.mode = 'review'; document.body.classList.add('reviewing');
  document.querySelectorAll('.sheet').forEach((x) => (x.hidden = true));
  $('bar').hidden = true; $('routeChip').hidden = true; $('attrib').hidden = true;
  $('reviewBar').hidden = false; $('crosshair').hidden = false;
  setRotation(0); map.dragging.enable();
  drawRoute(false);
  reviewGo(0);
  toast('◀ ▶ to check each call · tap a dot to jump to it · tap the route where a call is missing to add one', 5000);
}
function endReview() {
  S.mode = 'idle'; document.body.classList.remove('reviewing');
  $('reviewBar').hidden = true; $('crosshair').hidden = true; $('bar').hidden = false; $('attrib').hidden = false;
  S.reviewRing?.remove(); S.reviewRing = null;
  drawRoute(false); fitVisible(S.routeLayer.getBounds()); paintSummary();
}
function reviewGo(i) {
  const N = S.route.notes; if (!N.length) return;
  rv = ((i % N.length) + N.length) % N.length;
  const n = N[rv];
  S.reviewFocus = [n.lat, n.lon];
  // centre it above the review bar
  const z = Math.max(map.getZoom(), 16.5), pt = map.project([n.lat, n.lon], z).add([0, 110]);
  map.setView(map.unproject(pt, z), z, { animate: true });
  S.reviewRing?.remove();
  S.reviewRing = L.circleMarker([n.lat, n.lon], { radius: 18, color: '#ffcc00', weight: 3, fill: false, interactive: false, className: 'review-ring' }).addTo(map);
  const { main, sub } = splitCall(n, n.label);
  $('rvCount').textContent = `${rv + 1} / ${N.length}`;
  $('rvMain').textContent = main;
  const prev = N[rv - 1], gap = prev ? Math.max(0, n.sStart - prev.sEnd) : n.sStart;
  $('rvSub').textContent = [sub, `${fmtDist(gap)} after the ${prev ? 'previous call' : 'start'}`, n.added ? 'added by you' : n.fixed ? 'fixed by you' : ''].filter(Boolean).join(' · ');
}
function reviewNear(ll) {
  if (!ll || !S.route?.notes.length) return reviewGo(0);
  let bi = 0, bd = Infinity;
  S.route.notes.forEach((n, i) => { const d = segLen(ll, [n.lat, n.lon]); if (d < bd) { bd = d; bi = i; } });
  reviewGo(bi);
}
$('rvPrev').onclick = () => reviewGo(rv - 1);
$('rvNext').onclick = () => reviewGo(rv + 1);
$('rvEdit').onclick = () => openFix(S.route.notes[rv]);
$('rvRemove').onclick = () => { fixTarget = S.route.notes[rv]; S.reviewFocus = [fixTarget.lat, fixTarget.lon]; saveFix({ none: true }); };
$('rvDone').onclick = endReview;
$('btnReview').onclick = startReview;
$('notesReview').onclick = startReview;

// add a call where the app had none: at the ⊕ in the middle of the map
let addAt = null;
const addWords = (dir, g) => (g === 'H' ? `Hairpin ${dir}` : g === 'F' ? `Flat ${dir}` : g === 'square' || g === 'acute' ? `${g[0].toUpperCase() + g.slice(1)} ${dir}` : `${dir[0].toUpperCase() + dir.slice(1)} ${g}`);
$('rvAdd').onclick = () => { const c = map.getCenter(); openAdd([c.lat, c.lng]); };
function openAdd(ll) {
  if (!S.route) return;
  if (distToPolyline(S.route.points, ll) > 30) return toast('Tap on the yellow route line where the call should be (or put the ⊕ on it)');
  addAt = ll;
  S.addPin?.remove();
  S.addPin = L.marker(ll, { icon: L.divIcon({ className: 'add-pin', html: '＋', iconSize: [34, 34] }), interactive: false, zIndexOffset: 3000 }).addTo(map);
  const near = S.route.notes.find((n) => (n.kind === 'corner' || n.kind === 'junction') && segLen(ll, [n.lat, n.lon]) < 15);
  $('addNote').textContent = near ? `There's already a call here (“${near.label}”) — picking one will change it.` : '';
  const opts = ['H', 1, 2, 3, 4, 5, 6, 'F', 'square', 'acute'];
  $('addGrades').innerHTML = ['left', 'right'].map((dir) =>
    `<div class="add-col"><h3 class="sub">${dir === 'left' ? '⬅ Left' : 'Right ➡'}</h3>${opts.map((g) => `<button data-dir="${dir}" data-g="${g}">${addWords(dir, g)}</button>`).join('')}</div>`).join('');
  openSheet('addSheet');
}
$('addGrades').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || !addAt) return;
  const g = b.dataset.g, fx = { id: Date.now().toString(36), add: true, dir: b.dataset.dir, lat: addAt[0], lon: addAt[1], was: null };
  if (g === 'square' || g === 'acute') fx.shape = g; else fx.grade = g === 'H' || g === 'F' ? g : +g;
  fixes.push(fx); saveFixes();
  $('addSheet').hidden = true; S.reviewFocus = addAt; S.addPin?.remove(); S.addPin = null;
  regen();
  // tell exactly what happened
  const made = S.route.notes.find((n) => n.fixed === fx.id);
  if (!made) toast('Couldn’t place that call — make sure the spot is on the route line', 5000);
  else if (made.added) toast(`Added: ${made.label}`);
  else toast(`There was already a call here — changed it to “${made.label}”`, 4500);
});
$('addSheet').querySelector('[data-close]').addEventListener('click', () => { S.addPin?.remove(); S.addPin = null; });
$('addWordsOnly').onclick = () => { $('addSheet').hidden = true; S.addPin?.remove(); S.addPin = null; S.reviewFocus = addAt; openRecce({ lat: addAt[0], lon: addAt[1] }); };

// ---------- 🚗 / 🚲 vehicle ----------
$('vehRow').addEventListener('click', async (e) => {
  const v = e.target.closest('button')?.dataset.v; if (!v || !S.route?.spec || S.route.spec.raw || S.busyMode) return;
  settings.vehicle = v; saveSettings();
  const sp = S.route.spec; if ((sp.vehicle || 'car') === v) return paintSummary();
  S.busyMode = true;
  toast(v === 'bike' ? '🚲 Shortest way for a bike — any direction…' : '🚗 Car route…', 8000);
  try {
    await buildRoute({ ...sp, via: sp.base || sp.via, planned: false, vehicle: v, mode: v === 'bike' ? 'fastest' : sp.mode }, S.route.loop, { fit: false });
    toast(`${v === 'bike' ? '🚲' : '🚗'} ${fmtDist(S.route.total)}${S.route.loop ? ' lap' : ''} · ~${fmtDur(routeSeconds())}`);
  } catch (err) { toast('Routing failed: ' + err.message); }
  S.busyMode = false;
});

// ---------- ⏺ record a route by driving it ----------
function startRec() {
  if (!navigator.geolocation) return toast('No GPS on this device');
  if (S.nav) stopNav();
  if (S.mode === 'review') endReview();
  document.querySelectorAll('.sheet').forEach((x) => (x.hidden = true));
  $('bar').hidden = true; $('routeChip').hidden = true; $('recBar').hidden = false;
  S.rec = { fixes: [], t0: Date.now(), dist: 0, line: L.polyline([], { color: '#ff3b30', weight: 5, opacity: 0.9 }).addTo(map) };
  keepAwake();
  S.rec.watch = navigator.geolocation.watchPosition((p) => {
    const c = p.coords, f = { lat: c.latitude, lon: c.longitude, t: p.timestamp || Date.now(), accuracy: c.accuracy };
    if (!S.rec || f.accuracy > 50) return;
    const last = S.rec.fixes.at(-1);
    if (last) S.rec.dist += segLen([last.lat, last.lon], [f.lat, f.lon]);
    S.rec.fixes.push(f);
    S.rec.line.addLatLng([f.lat, f.lon]);
    map.setView([f.lat, f.lon], Math.max(map.getZoom(), 16), { animate: true });
  }, (e) => { if (e.code === 1) toast('Location permission is off — allow it in Settings to record'); }, // brief signal gaps just pass
  { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  S.rec.timer = setInterval(paintRec, 1000); paintRec();
  toast('⏺ Recording — drive your route. Tap ■ Stop & save when you’re done.', 5000);
}
function paintRec() { if (S.rec) $('recInfo').textContent = `● REC  ${fmtDist(S.rec.dist)} · ${fmtTime(Date.now() - S.rec.t0)}`; }
async function stopRec(save) {
  const R = S.rec; if (!R) return;
  navigator.geolocation.clearWatch(R.watch); clearInterval(R.timer); R.line.remove();
  S.rec = null; $('recBar').hidden = true; $('bar').hidden = false;
  S.wake?.release?.(); S.wake = null;
  if (!save) { if (S.route) paintSummary(); return toast('Recording discarded'); }
  const res = finishRecording(R.fixes);
  if (res.points.length < 2 || res.length < 100) { if (S.route) paintSummary(); return toast('Too short to save — drive at least 100 m'); }
  const d = new Date(), def = `Recorded ${d.getDate()}/${d.getMonth() + 1} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  const name = (await askText('Name this route', def)) || def;
  S.loop = res.loop; paintLoop();
  await buildRoute({ raw: true, points: res.points, name, recorded: true }, res.loop);
  await saveRoute();
  toast(`⏺ “${name}” saved — ${fmtDist(res.length)}${res.loop ? ', as a circuit (back where you started)' : ''}`, 6000);
}
$('btnRecord').onclick = startRec;
$('recStop').onclick = () => stopRec(true);
$('recDiscard').onclick = () => stopRec(false);

// ---------- full screen while driving: tap the call → just the call; tap the map → just the map ----------
$('notepanel').addEventListener('click', () => {
  if (!S.nav) return;
  if (document.body.classList.contains('map-full')) return exitMapFull(); // the strip at the top takes you back
  document.body.classList.toggle('np-full');
});
function enterMapFull() {
  document.body.classList.remove('np-full');
  document.body.classList.add('map-full');
  $('mapBack').hidden = false;
  S.follow = false; paintCompass?.();
  setRotation(0);
  map.dragging.enable(); map.touchZoom.enable(); map.doubleClickZoom.enable(); map.scrollWheelZoom.enable();
  setTimeout(() => map.invalidateSize(false), 50);
}
function exitMapFull() {
  document.body.classList.remove('map-full');
  $('mapBack').hidden = true;
  S.follow = true;
  if (S.headingUp) map.dragging.disable();
  paintCompass?.();
  if (S.fix) followCam(S.fix.lat, S.fix.lon);
}
$('mapBack').onclick = (e) => { e.stopPropagation(); exitMapFull(); };
