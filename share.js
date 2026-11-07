// Route <-> link. The whole route spec lives in the URL #hash so a link rebuilds the same stage.
//   #via=<polyline>        routed through these points (OSRM)
//   #raw=<polyline>        geometry used as drawn
//   #demo=1                the built-in demo stage
//   &loop=1                closed circuit
//   &name=…                the route's name
//   &mode=…                route type (shortest | smooth | explore)
//   &notoll=1              avoid-tolls filter
//   &rc=<base64url json>   recce notes near the route: [[lat, lon, "word|word"], ...]

// Google encoded polyline, precision 5.
export function encodePolyline(pts) {
  let out = '', pLat = 0, pLon = 0;
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lat, lon] of pts) {
    const a = Math.round(lat * 1e5), b = Math.round(lon * 1e5);
    out += enc(a - pLat) + enc(b - pLon); pLat = a; pLon = b;
  }
  return out;
}

export function decodePolyline(str) {
  const pts = []; let i = 0, lat = 0, lon = 0;
  const dec = () => {
    let r = 0, sh = 0, b;
    do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
    return r & 1 ? ~(r >> 1) : r >> 1;
  };
  while (i < str.length) { lat += dec(); lon += dec(); pts.push([lat / 1e5, lon / 1e5]); }
  return pts;
}

const b64u = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));

export function specToHash(spec, { loop = false, recce = [], name = '' } = {}) {
  const q = new URLSearchParams();
  if (spec.demo) q.set('demo', '1');
  else if (spec.raw) q.set('raw', encodePolyline(spec.points));
  else q.set('via', encodePolyline(spec.via));
  if (loop) q.set('loop', '1');
  if (spec.mode && spec.mode !== 'fastest') q.set('mode', spec.mode);
  if (spec.noToll) q.set('notoll', '1');
  if (spec.vehicle === 'bike') q.set('bike', '1');
  if (spec.vehicle === 'foot') q.set('foot', '1');
  if (spec.recorded) q.set('rec', '1');
  if (spec.planned) q.set('planned', '1');
  if (name) q.set('name', name.slice(0, 80));
  if (recce.length) q.set('rc', b64u(JSON.stringify(recce.map((r) => [+r.lat.toFixed(5), +r.lon.toFixed(5), r.words.join('|')]))));
  return q.toString();
}

/** @returns null or { spec, loop, recce } (spec.demo needs the caller to build the stage) */
export function hashToSpec(hash) {
  const q = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  let spec = null;
  if (q.get('demo')) spec = { demo: true, raw: true };
  else if (q.get('raw')) spec = { raw: true, points: decodePolyline(q.get('raw')) };
  else if (q.get('via')) spec = { via: decodePolyline(q.get('via')) };
  if (!spec || (spec.points && spec.points.length < 2) || (spec.via && spec.via.length < 2)) return null;
  if (q.get('mode') && spec.via) spec.mode = q.get('mode');
  if (q.get('planned') === '1') spec.planned = true;
  if (q.get('bike') === '1') spec.vehicle = 'bike';
  if (q.get('foot') === '1') spec.vehicle = 'foot';
  if (q.get('rec') === '1') spec.recorded = true;
  if (q.get('notoll') === '1' || spec.mode === 'notoll') { spec.noToll = true; if (spec.mode === 'notoll') spec.mode = 'fastest'; }
  let recce = [];
  try {
    if (q.get('rc')) recce = JSON.parse(unb64u(q.get('rc'))).map(([lat, lon, w], k) => ({ id: 'shared' + k + '-' + lat + lon, lat, lon, words: w.split('|') }));
  } catch { recce = []; }
  return { spec, loop: q.get('loop') === '1', recce, name: (q.get('name') || '').slice(0, 80) };
}
