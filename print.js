// 🖨 Print a route on paper, black & white: a map (one page, or a poster of pages that tile together like a
// puzzle) and/or the directions (numbered turns with distances and street names, matching numbers on the map).
// Built from map tiles + an SVG overlay with plain Web-Mercator maths (no Leaflet), so pages are exact.

const TILE = 'https://tile.openstreetmap.org/';
const DPI = 96;                                   // CSS px per inch
const PAPER = { letter: [8.5, 11], a4: [8.27, 11.69] };
const MARGIN = 0.4;                               // inches, set in @page too
const HEAD = 34;                                  // px header strip on each map page
const FOOT = 18;                                  // px footer line (map data credit)
const HINT = 34;                                  // px for the layout hint on the poster index
const OVERLAP = 24;                               // px shared between neighbouring poster pages
const MAX_PAGES = 60;

const worldPx = (lat, lon, z) => {
  const n = 256 * 2 ** z, s = Math.sin(lat * Math.PI / 180);
  return [(lon + 180) / 360 * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
};
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ORD = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];

// ---------- the directions (cue list) from the route's calls ----------
function cueWords(n) {
  const street = n.street || (n.text || '').match(/, (?:onto|toward) (.*)$/)?.[1] || '';
  const onto = street ? ` onto ${street}` : '';
  if (n.shape === 'roundabout') {
    const ex = (n.text || '').match(/(first|second|third|fourth|fifth|sixth|seventh|eighth) exit/)?.[1];
    const k = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'].indexOf(ex) + 1;
    return `Roundabout${k ? `, take the ${ORD[k]} exit` : ''}${onto}`;
  }
  const g = n.grade, sh = n.shape;
  const w = sh === 'keep' ? 'Keep' : sh === 'hairpin' || g === 'H' ? 'U-turn' : sh === 'acute' || g === 1 ? 'Sharp'
    : sh === 'square' || g === 2 || g === 3 || (n.angle || 0) >= 55 ? 'Turn' : 'Slight';
  return w === 'U-turn' ? `Hairpin / U-turn ${n.dir}${onto}` : `${w} ${n.dir}${onto}`;
}
export function buildCues(route) {
  const cues = [{ s: 0, text: route.loop ? 'Start at the start/finish line' : 'Start', kind: 'start', lat: route.points[0][0], lon: route.points[0][1] }];
  for (const n of route.notes || []) {
    const turn = n.dir && (n.kind === 'junction' || (n.kind === 'corner' && (n.shape || ['H', 1, 2].includes(n.grade) || (n.angle || 0) >= 60)));
    if (turn || n.shape === 'roundabout') cues.push({ s: n.sStart, text: cueWords(n), kind: 'turn', note: n, lat: n.lat, lon: n.lon });
    else if (n.kind === 'recce' || n.kind === 'camera') cues.push({ s: n.sStart, text: `Note: ${n.label}`, kind: 'info', lat: n.lat, lon: n.lon });
  }
  for (const c of route.checkpoints || []) cues.push({ s: c.s, text: `Checkpoint ${c.n}`, kind: 'cp', lat: c.ll[0], lon: c.ll[1] });
  const end = route.points.at(-1);
  cues.push({ s: route.total, text: route.loop ? 'Back at the start/finish line — lap complete' : 'Arrive at the finish', kind: 'end', lat: route.loop ? route.points[0][0] : end[0], lon: route.loop ? route.points[0][1] : end[1] });
  cues.sort((a, b) => a.s - b.s);
  // two calls for the same spot (a junction and its own bend): keep one
  return cues.filter((c, i) => !(i && c.kind === 'turn' && cues[i - 1].kind === 'turn' && c.s - cues[i - 1].s < 15));
}

// ---------- page geometry ----------
function pageBox(paper, orient) {
  let [w, h] = PAPER[paper] || PAPER.letter; if (orient === 'landscape') [w, h] = [h, w];
  return { w: Math.floor((w - 2 * MARGIN) * DPI), h: Math.floor((h - 2 * MARGIN) * DPI), css: `${paper === 'a4' ? 'A4' : 'letter'} ${orient}` };
}
function routeLatLngs(route) { return route.loop ? [...route.points, route.points[0]] : route.points; }

/** Map pages. One page: fit (fractional zoom). Poster: a grid at zoom z, only pages the route crosses. */
export function planMapPages(route, { mode, z, paper, orient, shrink = 0 }) {
  const box = pageBox(paper, orient), mapW = box.w, mapH = box.h - HEAD - FOOT - shrink, pts = routeLatLngs(route);
  const bbox0 = (zz) => { let x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18; for (const [la, lo] of pts) { const [x, y] = worldPx(la, lo, zz); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return [x0, y0, x1, y1]; };
  if (mode === 'fit') {
    const [x0, y0, x1, y1] = bbox0(0), pad = 0.08;
    const zf = Math.min(Math.log2(mapW * (1 - 2 * pad) / Math.max(1e-9, x1 - x0)), Math.log2(mapH * (1 - 2 * pad) / Math.max(1e-9, y1 - y0)), 17);
    const zi = Math.floor(zf), sc = 2 ** (zf - zi), k = 2 ** zf;
    const cx = (x0 + x1) / 2 * k, cy = (y0 + y1) / 2 * k;
    return { box, zi, sc, zf, pages: [{ label: '', ox: cx - mapW / 2, oy: cy - mapH / 2 }], cols: 1, rows: 1 };
  }
  const [x0, y0, x1, y1] = bbox0(z), pad = 40, stepX = mapW - OVERLAP, stepY = mapH - OVERLAP;
  const cols = Math.max(1, Math.ceil((x1 - x0 + 2 * pad - OVERLAP) / stepX)), rows = Math.max(1, Math.ceil((y1 - y0 + 2 * pad - OVERLAP) / stepY));
  const gx = (x0 + x1) / 2 - (cols * stepX + OVERLAP) / 2, gy = (y0 + y1) / 2 - (rows * stepY + OVERLAP) / 2;
  // which cells does the route actually pass through? (sample along it, densely enough for this zoom)
  const hit = new Set(), samples = route.samples || [];
  const along = samples.length ? samples.map((p) => [p.lat, p.lon]) : pts;
  if (route.loop && along.length) along.push(along[0]);
  const mark = (x, y) => { for (const dx of [-30, 0, 30]) for (const dy of [-30, 0, 30]) { const c = Math.floor((x + dx - gx) / stepX), r = Math.floor((y + dy - gy) / stepY); if (c >= 0 && r >= 0 && c < cols && r < rows) hit.add(r * cols + c); } };
  for (let i = 0; i < along.length; i++) {
    const [ax, ay] = worldPx(along[i][0], along[i][1], z); mark(ax, ay);
    if (i) { const [bx, by] = worldPx(along[i - 1][0], along[i - 1][1], z), d = Math.hypot(ax - bx, ay - by), n = Math.ceil(d / 40); for (let k = 1; k < n; k++) mark(bx + (ax - bx) * k / n, by + (ay - by) * k / n); }
  }
  const colName = (c) => (c >= 26 ? String.fromCharCode(65 + Math.floor(c / 26) - 1) : '') + String.fromCharCode(65 + (c % 26));
  const pages = [...hit].sort((a, b) => a - b).map((i) => { const r = Math.floor(i / cols), c = i % cols; return { r, c, label: `${colName(c)}${r + 1}`, ox: gx + c * stepX, oy: gy + r * stepY }; });
  return { box, zi: z, sc: 1, zf: z, pages, cols, rows, colName, hit };
}
export const metresPerInch = (lat, zf) => 156543.03392 * Math.cos(lat * Math.PI / 180) / 2 ** zf * DPI;

// ---------- drawing ----------
function tilesHtml(zi, sc, ox, oy, w, h, background) {
  if (background === 'none') return '';
  const T = 256 * sc, n = 2 ** zi, out = [];
  for (let ty = Math.floor(oy / T); ty * T < oy + h; ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(ox / T); tx * T < ox + w; tx++) {
      const wx = ((tx % n) + n) % n;
      out.push(`<img class="pt-tile" src="${TILE}${zi}/${wx}/${ty}.png" style="left:${(tx * T - ox).toFixed(1)}px;top:${(ty * T - oy).toFixed(1)}px;width:${T.toFixed(1)}px;height:${T.toFixed(1)}px" alt="" crossorigin="anonymous">`);
    }
  }
  return out.join('');
}
function overlaySvg(route, cues, plan, page, w, h, { numbers = true } = {}) {
  const k = plan.sc, P = (la, lo) => { const [x, y] = worldPx(la, lo, plan.zi); return [x * k - page.ox, y * k - page.oy]; };
  const pts = routeLatLngs(route).map(([la, lo]) => P(la, lo));
  const d = 'M' + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L');
  // direction chevrons every ~110 px along the line
  const chev = []; let acc = 55;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], L = Math.hypot(bx - ax, by - ay);
    while (acc < L) {
      const t = acc / L, x = ax + (bx - ax) * t, y = ay + (by - ay) * t, a = Math.atan2(by - ay, bx - ax) * 180 / Math.PI;
      if (x > -20 && y > -20 && x < w + 20 && y < h + 20) chev.push(`<path class="pt-chev" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${a.toFixed(0)})" d="M-6 -7 L7 0 L-6 7 Z"/>`);
      acc += 110;
    }
    acc -= L;
  }
  const marks = cues.map((c, i) => {
    const [x, y] = P(c.lat, c.lon); if (x < -20 || y < -20 || x > w + 20 || y > h + 20) return '';
    if (c.kind === 'start') return `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><rect class="pt-s" x="-11" y="-11" width="22" height="22"/><text class="pt-st" y="5">${route.loop ? 'S/F' : 'S'}</text></g>`;
    if (c.kind === 'end') return route.loop ? '' : `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><rect class="pt-s" x="-11" y="-11" width="22" height="22"/><text class="pt-st" y="5">F</text></g>`;
    if (!numbers) return '';
    return `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><circle class="pt-n" r="10"/><text class="pt-nt" y="4">${i}</text></g>`;
  }).join('');
  return `<svg class="pt-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path class="pt-halo" d="${d}"/><path class="pt-line" d="${d}"/>${chev.join('')}${marks}</svg>`;
}
function scaleBar(lat, zf, units) {
  const mpi = metresPerInch(lat, zf);
  if (units === 'imperial') { const ft = mpi * 3.28084, nice = [50, 100, 200, 500, 1000, 2640, 5280, 10560, 26400, 52800].find((v) => v >= ft * 0.8) || 52800; return { px: nice / ft * DPI, label: nice >= 5280 ? `${nice / 5280} mi` : `${nice} ft`, scale: `1 in ≈ ${ft >= 5280 ? (ft / 5280).toFixed(1) + ' mi' : Math.round(ft) + ' ft'}` }; }
  const nice = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000].find((v) => v >= mpi * 0.8) || 50000;
  return { px: nice / mpi * DPI, label: nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, scale: `1 cm ≈ ${mpi / 2.54 >= 1000 ? (mpi / 2.54 / 1000).toFixed(1) + ' km' : Math.round(mpi / 2.54) + ' m'}` };
}

/** The whole printable document: returns { html, pageCss, count, tooMany } */
export function renderPrint(route, opts, { fmtDist, glyphPath, qr = null }) {
  const { what, mode, z, paper, orient, background, units } = opts;
  const cues = buildCues(route), name = route.spec?.name || (route.loop ? 'Circuit' : 'Route');
  const lat0 = route.points[0][0];
  const parts = []; let count = 0, tooMany = false, plan = null;
  const head = (right) => `<div class="pt-head"><b>${esc(name)}</b><span>${esc(right)}</span></div>`;
  const qrBox = (cls) => (qr ? `<div class="pt-qr ${cls}">${qr}<span>Scan to open this route</span></div>` : '');
  const footer = `<div class="pt-foot">Map data © OpenStreetMap contributors · printed ${new Date().toLocaleDateString()}</div>`;
  if (what !== 'dirs') {
    plan = planMapPages(route, { mode, z, paper, orient });
    if (plan.pages.length > MAX_PAGES) tooMany = true;
    else {
      const { box } = plan, mapH = box.h - HEAD - FOOT, sb = scaleBar(lat0, plan.zf, units);
      const has = (r, c) => plan.pages.some((p) => p.r === r && p.c === c);
      if (mode === 'poster' && plan.pages.length > 1) { // index page: where each sheet goes
        const fit = planMapPages(route, { mode: 'fit', paper, orient, shrink: HINT }), pg = fit.pages[0], kz = 2 ** (fit.zf - plan.zf);
        const rects = plan.pages.map((p) => { const x = (p.ox * kz - pg.ox * 1), y = (p.oy * kz - pg.oy); const w = box.w * kz, h = mapH * kz;
          return `<g><rect class="pt-cell" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(w).toFixed(1)}" height="${(h).toFixed(1)}"/><text class="pt-cellt" x="${(x + w / 2).toFixed(1)}" y="${(y + h / 2 + 6).toFixed(1)}">${p.label}</text></g>`; }).join('');
        parts.push(`<section class="pt-page" style="width:${box.w}px;height:${box.h}px">${head(`Poster index · ${plan.pages.length} sheets · ${sb.scale}`)}<div class="pt-map" style="height:${mapH - HINT}px">${overlaySvg(route, cues, fit, pg, box.w, mapH - HINT, { numbers: false })}<svg class="pt-svg" width="${box.w}" height="${mapH - HINT}">${rects}</svg>${qrBox('pt-qr-map')}</div><div class="pt-hint">Lay the sheets out like this grid. Neighbouring sheets overlap by a few millimetres: trim one edge and line up the route.</div>${footer}</section>`);
        count++;
      }
      for (const p of plan.pages) {
        const nb = mode === 'poster' && plan.pages.length > 1 ? [
          has(p.r - 1, p.c) && `<div class="pt-nb pt-up">▲ ${plan.colName(p.c)}${p.r}</div>`, has(p.r + 1, p.c) && `<div class="pt-nb pt-down">▼ ${plan.colName(p.c)}${p.r + 2}</div>`,
          has(p.r, p.c - 1) && `<div class="pt-nb pt-left">◀ ${plan.colName(p.c - 1)}${p.r + 1}</div>`, has(p.r, p.c + 1) && `<div class="pt-nb pt-right">${plan.colName(p.c + 1)}${p.r + 1} ▶</div>`,
        ].filter(Boolean).join('') : '';
        parts.push(`<section class="pt-page" style="width:${box.w}px;height:${box.h}px">${head(`${p.label ? 'Sheet ' + p.label + ' · ' : ''}${fmtDist(route.total)}${route.loop ? ' lap' : ''} · ${sb.scale}`)}
          <div class="pt-map ${background === 'none' ? 'blank' : ''}" style="height:${mapH}px">${tilesHtml(plan.zi, plan.sc, p.ox, p.oy, box.w, mapH, background)}${overlaySvg(route, cues, plan, p, box.w, mapH)}${nb}
          <div class="pt-scale"><i style="width:${sb.px.toFixed(0)}px"></i>${sb.label}</div><div class="pt-north">N<br>▲</div>${mode === 'fit' || plan.pages.length === 1 ? qrBox('pt-qr-map') : ''}</div>${footer}</section>`);
        count++;
      }
    }
  }
  if (what !== 'map') { // directions
    const pageOf = (c) => { if (!plan || mode !== 'poster' || plan.pages.length < 2) return ''; const [x, y] = worldPx(c.lat, c.lon, plan.zi); const p = plan.pages.find((q) => x >= q.ox && x < q.ox + plan.box.w - OVERLAP && y >= q.oy && y < q.oy + plan.box.h - HEAD - FOOT - OVERLAP) || plan.pages.find((q) => x >= q.ox && x < q.ox + plan.box.w && y >= q.oy && y < q.oy + plan.box.h - HEAD - FOOT); return p ? p.label : ''; };
    const box = pageBox(paper, orient), rows = cues.map((c, i) => {
      const prev = cues[i - 1], go = prev ? c.s - prev.s : 0, n = c.note;
      const gl = n?.dir && glyphPath ? `<svg viewBox="0 0 100 100" class="pt-gl"><path d="${glyphPath(n)}"/></svg>` : c.kind === 'start' || c.kind === 'end' ? `<b class="pt-sf">${c.kind === 'start' ? (route.loop ? 'S/F' : 'S') : route.loop ? 'S/F' : 'F'}</b>` : c.kind === 'cp' ? '<b class="pt-sf">CP</b>' : '';
      return `<tr class="${c.kind}"><td class="pt-i">${c.kind === 'start' ? '' : i}</td><td class="pt-g">${gl}</td><td class="pt-t">${esc(c.text)}</td><td class="pt-d">${i ? fmtDist(go) : ''}</td><td class="pt-c">${fmtDist(c.s)}</td>${plan && mode === 'poster' && plan.pages.length > 1 ? `<td class="pt-p">${pageOf(c)}</td>` : ''}</tr>`;
    }).join('');
    const sheetCol = plan && mode === 'poster' && plan.pages.length > 1;
    parts.push(`<section class="pt-page pt-dirs" style="width:${box.w}px;min-height:${box.h}px">${head(`Directions · ${fmtDist(route.total)}${route.loop ? ' per lap' : ''} · ${cues.length - 2} turn${cues.length === 3 ? '' : 's'}`)}
      <div class="pt-dirtop"><div class="pt-sum"><b>${esc(name)}</b><span>${route.loop ? 'Circuit' : 'Route'} · ${fmtDist(route.total)}${route.loop ? ' per lap' : ''} · ${cues.length - 2} turn${cues.length === 3 ? '' : 's'}${(route.checkpoints || []).length ? ` · ${route.checkpoints.length} checkpoint${route.checkpoints.length > 1 ? 's' : ''}` : ''}</span><span>Follow the lines in order. Each "Then go" distance is counted from the line above.</span></div>${qrBox('pt-qr-dirs')}</div>
      <table class="pt-table"><thead><tr><th>#</th><th></th><th>What to do</th><th>Then go</th><th>Total</th>${sheetCol ? '<th>Sheet</th>' : ''}</tr></thead><tbody>${rows}</tbody></table>
      <p class="pt-hint">"Then go" is the distance from the previous line to this one. Numbers match the circled numbers on the map.${route.loop ? ' On a circuit, repeat from the top for each lap.' : ''}</p>${footer}</section>`);
    count += Math.max(1, Math.ceil(cues.length / 26));
  }
  return { html: parts.join(''), pageCss: `@page { size: ${pageBox(paper, orient).css}; margin: ${MARGIN}in; }`, count, tooMany, pages: plan?.pages.length || 0 };
}
