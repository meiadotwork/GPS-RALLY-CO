// Prints generated pace notes for the synthetic demo stage.
//   node scripts/rally-notes.mjs [--imperial]
import { generatePaceNotes, chainText, linkFor } from '../pacenotes.js';
import { buildStage, STAGE } from '../sample-route.js';

const units = process.argv.includes('--imperial') ? 'imperial' : 'metric';
const { points, steps, elevation } = buildStage();
const { notes, total } = generatePaceNotes(points, { steps, elevation });

console.log(`Stage: ${points.length} OSM-style nodes, ${(total / 1000).toFixed(2)} km, ${notes.length} notes\n`);
console.log('Designed (ground truth):');
for (const s of STAGE) if (s[3]) console.log('  ·', s[3]);

console.log('\n  #    at(m)  note                                   angle  rMin  rEff  next');
for (const n of notes) {
  const l = linkFor(n.gapNext, units);
  console.log(
    `  ${String(n.id).padStart(2)}  ${String(Math.round(n.sStart)).padStart(6)}  ${n.label.padEnd(38)} ` +
    `${String(n.angle ?? '').padStart(5)}  ${String(n.rMin ?? '').padStart(4)}  ${String(n.rEff ?? '').padStart(4)}  ` +
    `${l.say}${n.gapNext != null ? ` (${Math.round(n.gapNext)} m)` : ''}`);
}

console.log('\nCo-driver read-out (chained when linked or < 150 m apart):');
for (let i = 0; i < notes.length; ) {
  let j = i;
  while (j < notes.length - 1 && j - i < 3 && notes[j].gapNext < 150) j++;
  console.log('  "' + chainText(notes, i, j, units) + '"');
  i = j + 1;
}

// ---- live timing: same stage driven at two speed caps ----
import { CallScheduler, DriveSim } from '../navcore.js';
const { samples, kappa } = generatePaceNotes(points, { steps, elevation });
for (const cap of [60, 120]) {
  console.log(`\nSimulated drive, cap ${cap} km/h, call-ahead "normal":`);
  const sim = new DriveSim(samples, kappa, cap / 3.6);
  const sch = new CallScheduler(notes, { units });
  let t = 0;
  while (!sim.done && t < 3600) {
    const f = sim.tick(0.5); t += 0.5;
    const c = sch.update(f.s, f.speed);
    if (c) console.log(`  t=${t.toFixed(1).padStart(5)}s  ${String(Math.round(f.speed * 3.6)).padStart(3)} km/h  ` +
      `called ${String(c.distToNote).padStart(3)} m before  "${c.text}"`);
  }
}
