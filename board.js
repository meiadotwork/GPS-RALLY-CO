// Leaderboard: your best times on each route (or lap circuit). Pure ES module (no DOM) so it can be tested.
//
// boards = { [key]: { name, loop, fly, total, hash, updated, entries: [{ id, ms, best?, lapsN?, date, avg, top, dist }] } }
// A→B stages rank by time; circuits rank by best lap (so runs with a different number of laps compare fairly).

export const MAX_ENTRIES = 25;

const score = (b, e) => (b.loop ? e.best ?? e.ms : e.ms);

/** Entries fastest first. */
export function ranked(board) {
  return (board?.entries || []).slice().sort((a, b) => score(board, a) - score(board, b) || a.date - b.date);
}

/**
 * Add a run. Returns { boards, rank (1 = fastest), of, isBest }. Keeps the MAX_ENTRIES fastest.
 * @param meta { name, loop, fly, total, hash }
 */
export function addRun(boards, key, meta, entry) {
  const out = { ...boards };
  const b = { ...(out[key] || { entries: [] }), ...meta, updated: entry.date };
  const prevBest = ranked(b)[0];
  b.entries = ranked({ ...b, entries: [...b.entries, entry] }).slice(0, MAX_ENTRIES);
  out[key] = b;
  const rank = b.entries.findIndex((e) => e.id === entry.id) + 1; // 0 = didn't make the list
  return { boards: out, rank, of: b.entries.length, isBest: rank === 1, prevBest };
}

export function removeRun(boards, key, id) {
  const out = { ...boards }, b = out[key];
  if (!b) return out;
  const entries = b.entries.filter((e) => e.id !== id);
  if (entries.length) out[key] = { ...b, entries }; else delete out[key];
  return out;
}

export function removeBoard(boards, key) { const out = { ...boards }; delete out[key]; return out; }

/** Boards most recently driven first. */
export function boardList(boards) {
  return Object.entries(boards || {}).map(([key, b]) => ({ key, ...b })).sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

/** Merge two sets of boards (backup import): union of runs by id. */
export function mergeBoards(cur, add) {
  const out = { ...(cur || {}) };
  for (const [k, b] of Object.entries(add || {})) {
    if (!b?.entries) continue;
    const have = out[k];
    if (!have) { out[k] = b; continue; }
    const ids = new Set(have.entries.map((e) => e.id));
    const merged = { ...have, updated: Math.max(have.updated || 0, b.updated || 0), entries: [...have.entries, ...b.entries.filter((e) => !ids.has(e.id))] };
    merged.entries = ranked(merged).slice(0, MAX_ENTRIES);
    out[k] = merged;
  }
  return out;
}
