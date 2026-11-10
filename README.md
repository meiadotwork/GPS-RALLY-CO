# Co-Driver Nav

A navigation app for the phone browser that gives every instruction as a rally co-driver pace note. Nothing to install: open the site over **HTTPS** (live on Cloudflare Pages), because phones only allow GPS and Wake Lock on secure pages.

**Hosting:** a Cloudflare Worker deploys this repository's `main` branch automatically (`npx wrangler deploy`, no build step). `wrangler.jsonc` serves the repository root as static files, and `.assetsignore` keeps tests, scripts and config off the site. Live at https://gps-rally-co.meiagimenes.workers.dev

## Files

| File | What it does |
|---|---|
| `pacenotes.js` | Pace note generator (pure JS, also runs in Node) |
| `navcore.js` | GPS-to-route matching, speed-aware call timing, drive simulator |
| `app.js` | Leaflet map, search, route drawing, voice, live navigation screen, settings |
| `sample-route.js` | Synthetic mountain stage with known corners, used for tests and the demo |

## How notes are made

1. The route line is resampled every 5 m. Heading is smoothed over about 8 m so the uneven node spacing in OpenStreetMap data doesn't create false corners. Curvature is the rate of heading change.
2. Corners are stretches tighter than a 400 m radius. Stretches turning the same way less than 20 m apart are merged into one corner. Anything under 12° of total turn is ignored.
3. **Grade** comes from an *effective* radius: the tightest radius plus how much a shallow bend can be straightened using the road width. That is why a short 20° kink is flat but a 90° bend with the same radius is a 3 or 4. The scale runs H (hairpin), 1, 2, 3, 4, 5, 6, from about 50 km/h for a 2 up to about 140 km/h for a 6.
   **Square and acute come from the road shape too, not only from junction data.** A turn of 65–120° that is tight (grade 2 or tighter) or abrupt (over in 40 m or less) is called *square left/right*. A turn of 120–135° under the same conditions is *acute*. Street corners are therefore never called "left 2", and a very tight 90° is never called a hairpin, even when the routing service sends no turn instruction (drawn routes, the start/finish corner of a circuit, or a step that fails to match). An open 90° bend, say a 30 m radius on a country road, keeps its number (*right 3*).
4. **Modifiers**:
   - *tightens* / *opens*: the exit third of the corner is 1.5× tighter or looser than the entry third, and its grade changes.
   - *long*: more than 135° of turn, or more than 150 m long with at least 90° of turn.
   - *don't cut*: every hairpin, and grade-1 corners of 90° or more.
   - *caution*: a grade 2 or tighter after 300 m or more of straight, or a corner that tightens to 2 or tighter.
5. **Gentle bends** that are too open for a 6 are still called, up to a 700 m effective radius: *flat left* if the bend lasts, *kink right* if it is short. Settings → Gentle bends → Skip turns them off, which helps in town.
6. **Junctions** come from OSRM's turn-by-turn steps. Each step is placed using OSRM's step lengths: the distance travelled so far gives the search area, ±150 m. That way two steps at the same spot, or a circuit's repeated laps, can't push later junctions onto the wrong lap.
   The shape of the call comes from the route itself: the road heading 40 m before the junction compared with 40 m after it. OSRM's own bearings only look at the first few metres of each road, which is how a 35° bear right got called "square".

   | Turn | Call |
   |---|---|
   | under 25° | at junction, keep right |
   | 25–65° | at junction, right 5 (graded like a corner) |
   | 65–120° | at junction, square right |
   | 120–135° | at junction, acute right |
   | over 135° | at junction, hairpin right |

   "T junction", roundabouts, forks and slip roads are called as before. Any geometry corner at the same spot is dropped so it isn't called twice.
7. **Links** between notes: *into* when the next corner is under 20 m away, *and* when it is under 50 m. Otherwise the call gives the distance: rounded to 50 below 175 m, rounded to 100 up to 1 km, then "1 k" / "2 k" / "long straight". Imperial mode uses yards, then "half mile" / "1 mile".

## Vocabulary: what is called, and where it comes from

| Source | Calls |
|---|---|
| Route geometry | left / right, 1–6, hairpin, flat, kink, square, *tightens 3*, *opens 5*, long, very long, short, late (apex), double apex, chicane left right, don't cut, brake / hard brake, caution / double caution (tightens into a 2 / 1 / hairpin) |
| Gaps | into (< 20 m), and (< 45 m), then (< 75 m), 100 / 150 / 200 … |
| Elevation (Open-Meteo, ~90 m terrain model). **Off by default** (Settings → Crests & dips), because it's too rough to match real crests | crest, small crest, big crest, *over crest*, dip, and caution / double caution on a tight corner within 100 m after a crest (blind) |
| **You** (＋ Note while driving, or Review → Add → Words only) | any road condition, or **speed camera**: crest, jump, dip, compression, bumps, gravel, narrows, don't cut… This is the recommended way to get crests and road conditions. |
| OSRM | at junction …, T junction, roundabout + exit, fork / merge / slip road, tunnel |
| **Recce** (you add them) | everything a map can't know: rocks, ditch, bank, wall, trees, drop, exposure, gravel, mud, ice, water, ford, ruts, bumps, jump, compression, narrows, widens, camber, off camber, bridge, gate, keep left / middle / right, cut, cut late, care, maybe, danger, inside / outside … |

Corners are called by their entry grade with where they end up: "left 5, tightens 3" or "right 2, opens 4". Modifiers follow in the order co-drivers use: `right 5 over crest, long, tightens 3, don't cut`. Brake is judged from the speed you'd carry in without lifting (grip and acceleration limits, 100 km/h cap) against what the corner allows: a drop over 50 km/h means brake, over 80 km/h means hard brake.

**Recce notes**: in Stage notes, tap any note to add words to it. While driving, the bar's ＋ Note button pins words to where you are now. Words are read in the order you tapped them and stay on the phone, so they come back on every route that passes within 25 m of that spot. A note on a corner joins that call ("right 3, rocks, outside"). One on a straight is called on its own.

**Grade scale**: Settings lets you reverse it (1 = fastest) for crews that run it that way.

## When calls are spoken

Each call has to finish a set number of seconds before the corner: early 7 s, normal 5 s, late 3.5 s. The trigger distance is therefore `speed × (lead time + estimated speech time) + 15 m`, never less than 60 m and never more than 900 m. Driving faster makes calls come earlier.

**One call at a time** (the default): each note is its own call, spoken just before that corner, with its link to the next ("left 4 into", "right 3, 200"). Nothing is ever queued behind a call that is still being spoken. The next call waits until the current one finishes, and it is dropped if its corner has already gone. Settings → Calls → Read ahead switches back to chaining close notes into one breath (up to 4).

If you are more than about 35 m from the route (more if GPS accuracy is poor) for 3 GPS fixes in a row, the app says "Off route, recalculating" and asks OSRM for a new route from where you are to the waypoints you haven't reached yet.

## Route summary and sharing

- **Summary chip:** once a route exists, a chip at the top of the map shows the distance, the estimated time (OSRM's estimate, or about 50 km/h for drawn routes), the number of notes and the number of cameras.
- **While driving:** the note panel shows the distance left and the ETA, or the distance to the line on a circuit.
- **Name:** name a route by tapping the chip's ✎ Name this route, or with the name box in the Route sheet. The name shows on the chip, goes into the shared link and its message, and survives circuit toggling and rerouting.
- **Street names:** junction calls add the road you turn onto, e.g. "at junction, square right, onto Boston Road" ("exit right, toward …" for exits), using OSRM's `name` / `ref` / `destinations`. Settings → Street names → Don't say gives clean pace notes only.
- **Share:** Share (on the chip, or Share link in the Route sheet) puts the whole route into the link's `#hash`, using `share.js`. The link carries the route points (or the drawn line, or `demo`), the name, the circuit flag, and any recce notes within 25 m of the route. It uses the phone's share menu, or copies to the clipboard where that isn't available.
- **Opening a shared link:** the same stage is rebuilt, and the sender's recce notes are added to the receiver's own.

## My places

Save the spots you go to:
- **Route → 📍 My places → ＋ Save where I am** saves your current position.
- **Long-press the map → 📍 Save place** saves that spot.
- **📍** next to a search result saves that result.

Each place gets a name and an icon, guessed from the name (🏠 Home, 💼 Work, 🍴 a restaurant, ☕, ⛽, 🏁 …). You can rename it or change the icon. Places appear on the map, and the first few show as quick chips at the top of the Route sheet.

Tap a place to see:
- **🏁 Go — best route**: routes from where you are now (GPS) to the place.
- **✎ Plan my own way**: same route, then straight into edit mode to add the points in between.
- **Saved routes to here**: every saved route that ends within 150 m of the place, so you can keep several ways to the same destination and pick one.

## The route page

Route (or ⚙ on the route chip) opens one page with everything about the current route:
- name, distance and time
- **route type**: **📍 Exactly my way** (default) · ⚡ Fastest · 📏 Shortest · 〰️ Smooth · 🎲 Explore
- **filters**: 💸 Avoid tolls · 🔁 No repeated roads (circuits) · 🧹 Skip loops & U-turns (the last two only appear when you pick an optimising type)

**📍 Exactly my way is the default for every new route and lap.** The route goes through your points, in the order you put them, along the roads that connect them, and that's all. The app adds no hidden points, doesn't swap in a "smoother" alternative, doesn't plan a round circuit, and doesn't warn about going round a block (on a lap round your neighbourhood, that's the point). The optimising types only run when you tap one, and **📍 Exactly my way** takes you back. Your choice is saved with the route.
- **circuit**: lap circuit and number of laps
- **drive**: save, edit points, share, stage notes, simulate, start, cancel

Under that is **New route**: search, places, tap or draw on the map, My places, My routes, and the demo.

## Round circuits (no repeated roads)

A circuit with just a start and one point used to be an out-and-back on the same roads. With **🔁 No repeated roads** on (the default), the app:

1. Tries 3 ways out (direct, plus detours left and right) and 5 ways back (direct, plus two detours on each side).
2. Measures for every pair how much of the way back runs within 20 m of the way out (`sharedFraction`).
3. Keeps pairs under 5 % shared (or under 12 % if none is that round), then picks by route type: fastest time, shortest distance, smoothest corners, or a random pair for Explore, which is different every tap.

The final lap is routed in one go through the chosen detour points, and the page shows how round it came out ("no repeated roads" or "4 % repeated road"). If no round way exists (a dead-end valley, say), you get the least-repeated one and a message.

## Route options (A → B and circuits)

Under the route summary, a row of options picks how to get from A to B. Each one shows its distance and time once tried.

| Option | How |
|---|---|
| ⚡ Fastest | OSRM's route (smoothest of its alternatives within +15 % time when Smooth routes is on) |
| 📏 Shortest | OSRM alternatives, take the shortest distance (OSRM's public server has no true shortest-distance profile, so this is the shortest of the routes it offers) |
| 〰️ Smooth | Candidates: OSRM's alternatives plus detours to either side (via points 15 % and 30 % left/right of the midpoint). Each is run through the pace-note generator and scored: tight corners (hairpin, 1, 2, square, acute) × 60 + medium corners (3–4) × 15 + time in seconds, allowing up to 60 % more time than the fastest. Lowest score wins, and the number of tight corners is shown. |
| 🎲 Explore | One or two random points between A and B (to the side of the straight line), routed with loop/U-turn smoothing and kept under 2× the fastest distance. Tap again for another. |

**💸 Avoid tolls is a filter, not a route type.** It sits at the start of the row and works with Fastest, Shortest, Smooth and Explore, including Smooth's detour candidates, Explore's random routes, edits and reroutes. It uses OSRM's `exclude=toll`. If the server can't do that, the app falls back to the alternatives with the fewest toll points and warns you if none is toll-free. It stays on for new routes until you switch it off.

**Circuits and routes with your own points** use the same options, planned leg by leg (start → your point → … → back to the start). For each leg the app picks the shortest alternative, the smoothest candidate, or random detours (Explore). It pins that choice with a hidden point, then routes the whole thing in one request so the loop/U-turn smoothing still works across the joints. Your own points are kept and remembered, so you can switch type again, or tap Explore for another lap. The chosen option, and Explore's random points, go into saved routes and share links, so the same route comes back.

## Shaping the way between A and B

In edit mode **every point can be dragged, including the start (S) and finish (F)**. On a circuit, dragging S/F moves the start/finish line.
- Tap the map or the route to add a point.
- Drag any point to move it. Tap a checkpoint to remove it. Start and finish can't be removed, only moved.
- **📍 From here** moves the start to where you are now.

## Checkpoints, then the finish

**Arriving counts.** Once every checkpoint is passed, getting **within about 45 m of the destination** finishes the run (up to 70 m when the GPS reports poor accuracy). That works even if your position never quite reaches the end of the route line, say you park beside it or drive straight past. A reroute near the end updates where the finish is, and just past the destination the app finishes instead of turning you around.

The finish **unlocks only after you've driven through all your checkpoints**, in order. Reaching the destination early, for example on a lap round your block that passes the finish street before the end, doesn't end the run.
- As you pass each checkpoint you hear a short double beep, and the screen shows **✓ Checkpoint 2 · 2/5**. The driving screen keeps a running **CP 2/5**.
- If you reach the finish having **missed** a checkpoint (say you took a shortcut past it), you hear "Finish locked. Missed checkpoint 3." Drive through it and come back to the finish, or tap Stop.
- **Your position follows the route in order.** When the route uses the same street twice, or ends on a street you already drove, the app stays on the pass you're actually on. It never jumps ahead to the later one, so calls aren't skipped and the run can't end early.

Circuits work the same way, lap after lap. Checkpoints are counted on A-to-B routes, where they unlock the finish.

## Your checkpoints, your order

This app is for building **your** route, not the "optimal" one:
- In edit mode, each tap on the map becomes your **next checkpoint**, in the order you tap: before the destination, or at the end on a circuit. To put a point between two existing ones, tap the route line at that spot.
- Your checkpoints are **never removed or reordered** by the app. Route types (Shortest, Smooth) plan each leg *between* your checkpoints, in your order. Editing an Explore route turns it into a plain route through your exact points.
- If one of your checkpoints makes the route loop round a block (it snapped to a side street or the far side of the road), it is **kept**, marked **⚠** in red in edit mode, and the app tells you which one, so you can drag it onto the road you mean.

## Smooth routes (no pointless loops or U-turns)

*(Only for points the app adds itself — Smooth/Explore/round-circuit pins. Your own checkpoints are never dropped; see above.)*


Every point you add is a must-pass point for OSRM, and OSRM won't U-turn at a waypoint (`continue_straight`). A point that lands on a side street, or on the far side of the road, therefore makes the route go past it, loop round the block and come back. With **Settings → Smooth routes** on (the default), `routing.js` handles this:

1. It finds places where the route comes back to a street node it already passed (an around-the-block loop or an out-and-back spur), and any U-turns.
2. If one of your added points sits in such a loop, it tries the route without that point. If that route still passes within 60 m of where you tapped, the point is skipped, because it was only causing the detour, and the app tells you. If the route really has to go there, the point is kept.
3. For plain A→B routes it asks for alternatives and picks the smoothest one (fewest sharp turns, no U-turns) that is no more than 15 % slower.

Loops OSRM makes for a real reason, such as a banned turn or a one-way street, are left alone, because every route still comes from OSRM.

## My routes

☆ on the route chip (or ☆ Save route in the Route sheet) saves the route on the phone. If it has no name yet, the app asks for one. ★ means it is saved; tapping it again after an edit updates the saved copy. Route → ★ My routes lists them with distance, laps and date. Tap one to open it, ✎ to rename, 🗑 to delete. Saved routes use the same compact format as share links, so they hold the points, name, circuit flag, lap count and nearby recce notes.

## Note labels on the map

The map shows each note as a coloured dot: yellow for corners, red for tight ones (2 or tighter, hairpins), blue for junctions. Labels are hidden by default to keep the map clean; tap a dot to see its note. Settings → Note labels on the map → Show all brings back every label.

## Editing a route

Tap ✎ on the route chip, or Edit route in the Route sheet. The route's points appear as markers: S (start), 1, 2, … and F (finish), or S/F on a circuit.

- Drag a marker to move that point.
- Tap the yellow route to insert a point at that spot. It goes in at the right place in the order.
- Tap a marker to remove it (a route keeps at least two points).
- Tap empty map to extend the route.

After every change the route is re-snapped to the roads (OSRM) and the notes are regenerated. Undo steps back, Done keeps the changes, and Cancel puts the route back as it was. The route name and the circuit setting are kept.

## Fixing calls and calibration

If a call was wrong, tap **✎ Fix** on the driving screen. A passenger should do this, not the driver. You can also tap any note in **Stage notes**. Choose what the corner really was: hairpin, 1–6, flat, square, acute, or **No corner here**.

- Fixes are saved by **location**, within 25 m of the corner, so every route through that corner uses them.
- Your fixes stay on this phone (`codriver.fixes`). **Remove my fix** undoes one.
- **Settings → Grade calibration** (Tighter / As measured / Faster) shifts every numbered call by one grade. Corners you fixed keep your grade. The hint under it averages your fixes and suggests a setting, e.g. "calls are on average 0.8 grade too fast — suggested: Tighter".

## 🔍 Review the calls on the map

**Route → 🔍 Review notes on map**, or from Stage notes. This shows every call on the map with its label and steps through them with **◀ ▶**; the map zooms to each one. You can also tap any dot. For each call:
- **✎ Change** the grade or shape, or add recce words.
- **🔇 Remove** it if it's unnecessary. This works for corners, junctions, crests, dips, cameras and tunnels; removing a recce-only note deletes its words.
- **Add a call**: tap the yellow route line where the call is missing (or put the red ⊕ there and tap **＋ Add at ⊕**). A purple pin marks the spot; pick Left/Right and the type (hairpin, 1–6, flat, square, acute) or words only. Outside review, long-press on your route → **＋ Add a call here**.
  - Within 15 m of an existing call, the menu says so, and your choice changes that call instead of adding a second one.
  - Afterwards the app confirms what happened: "Added: right 3", "changed it to right 2", or why it couldn't place it.
  - Calls you add are never merged into a neighbouring call (e.g. as a chicane).

Everything is saved by location (`codriver.fixes`), so it applies to every route through that spot. Calls you added are purple, and calls you fixed have a purple ring.

**S-bends:**
- In "one call at a time" mode, corners that run into each other (under 45 m apart) are read in one call ("left 4 into right 3"). Before, the second call could be dropped while the first was still being spoken.
- A junction now only replaces its own corner. A bend the other way straight after it is kept.

## Ghost lap

Your best run is recorded as a trace of (time, distance), roughly every 5 m or every second. On a circuit, your best **lap** is kept, timed from the line. Next time:
- a translucent **ghost car** drives your best on the map
- the stats strip shows the **live gap**: green **−1.2 s** when you're ahead, red **+0.8 s** when you're behind

On a circuit, your best lap chases you from the next lap of the same race. A ghost is only replaced by a faster one. Ghosts are stored per route (`codriver.ghosts`).

## 🅿️ Parking hunt

Pick a destination: **🅿️ Find parking here** on a place, on a long-press, or on the route page under **Parking hunt at the destination**. Set **any radius**, from 100 m to 10 km, with the slider or by typing a number in m or mi.

1. The streets inside the circle (plus a margin, so connections work) are downloaded from OpenStreetMap through Overpass. Main roads always come too, **as connections**: in one-way grids (New York and similar), the small streets alone often can't get you out of a block, so without the avenues the hunt would get trapped on one side of the circle. By default only the residential streets are searched; tick **Search main roads too** to search the avenues and boulevards as well. One-way tags are read.
2. `parking.js` turns them into a street graph of blocks between intersections, in the directions you're allowed to drive each one.
3. **Planning, closest first:** from the destination, it repeatedly drives to the best street not yet driven and along it. "Best" means the driving distance to reach it plus 0.8 × its distance from the destination, so the hunt spirals outwards and the first spots you pass are the nearest. Streets passed on the way count as searched. Immediate U-turns cost extra. The Dijkstra search stops as soon as nothing nearer can beat the best street found, so even 2 km radii plan in well under a second.
4. **Batches:** big radii cover a lot of street (about 100 km for 1 km in a dense grid), so each batch is about **15 km** of driving. At the end of a batch, **"No spot yet? Continue the hunt"** plans the next batch from where you are, skipping streets already driven, until the whole radius is done.
5. You're routed from where you are to the start of the hunt, then guided turn by turn with street names. Each turn carries its exact position along the route, because the hunt passes some junctions more than once. No countdown, and the search circle shows on the map.

## ⏺ Record a route

**Route → ⏺ Record a route**, then just drive. The app logs your GPS track (red line, distance and time). **■ Stop & save** asks for a name and saves the route to My routes. Its pace notes come from the road you actually drove. If you finish within 60 m of where you started, after more than 500 m, it's saved as a lap circuit.

`record.js` cleans the track:
- drops fixes with poor accuracy (> 35 m), points closer than 4 m (standing still), and jumps faster than 250 km/h
- re-syncs if two fixes in a row agree, so a real jump such as leaving a tunnel doesn't lose the rest of the drive
- smooths over 3 points, then simplifies (Douglas–Peucker, 2.5 m)

A phone records about one fix per second, so at speed tight corners are rounded a little. Record twisty sections at a moderate pace, and correct calls in 🔍 Review.

## 🖨 Print (black & white)

**Route page → 🖨 Print** opens the print screen, with a live preview of every sheet. Everything prints in simple black and white.
- **What:** Map + directions, Map only, or Directions only.
- **Whole route, one page:** the big picture on a single sheet.
- **Poster (several sheets):** slide from less to more detail. The readout shows the scale ("1 cm ≈ 32 m") and how many sheets it takes.
  - **Only sheets the route passes through are printed**, so even a long route across states doesn't waste paper.
  - Each sheet is labelled (A1, B1, C2…), with tabs on its edges naming its neighbours (◀ A1, B1 ▶). Neighbours overlap slightly, so you can trim and line them up on a wall.
  - A **poster index** page shows the layout.
  - The limit is 60 sheets.
- **Streets (grey)** or **Route only** (just the line: saves ink).
- **Letter or A4**, portrait or landscape.
- **The map:** a bold black route line with arrows showing the direction, S and F boxes, and **circled numbers at every turn**. It also has a scale bar and a north arrow.
- **Directions:** a numbered list with a small turn drawing, what to do ("Turn left onto Main St", "Roundabout, take the 2nd exit"), **Then go** (distance since the previous line) and **Total**. In poster mode it also says which **sheet** each turn is on. The numbers match the circles on the map, so the paper works without the phone.
- **QR code of the route** (on by default) on the one-page map, the poster index and the directions. Scanning it with any phone opens that exact route in the app. Long recorded tracks are encoded as ~40 points along them (routed on the same roads), so the code stays small enough to scan from paper.
- **🖼 Save as PNG**: every sheet as an image, the same black and white look as the printout. On iPhone it opens the share sheet (Save Images, AirDrop, Messages). Elsewhere the images download.
- Map data © OpenStreetMap contributors, printed on every sheet. (`print.js`)

## 🚶 On foot

**Route page → Vehicle → 🚶 On foot** routes along OpenStreetMap's walking network: **footpaths, paths through parks, pedestrian streets and stairs**, either way along one-way streets. Times are at walking pace, and it always takes the shortest way.
- **Plain walking calls** instead of rally grades: "**turn left**", "**slight right**", "**sharp left**", "**keep right**", with "onto …" when street names are on.
- Only real turns are called. Gentle bends, flat/kink, chicanes and brake calls are left out, because paths wiggle and those mean nothing on foot.
- Everything else works the same: checkpoints, laps and time attack, the leaderboard, the liaison to the start, and share links (`&foot=1`).

## 🚲 Bike mode

On the route page, **Vehicle → 🚲 Bike — any direction**. It routes with OpenStreetMap's FOSSGIS "foot" router (`routing.openstreetmap.de/routed-foot`), which **ignores one-way streets** and can use paths and parks. It always takes the **shortest** way (Fastest is hidden), and there are no brake calls or toll filter. The setting sticks for new routes, and saved routes and share links remember it (`&bike=1`). The route page shows a short note, because riding against traffic can be dangerous and isn't allowed everywhere.

## Saving and backup

Places, routes, recce notes, fixes, ghosts and best times are stored in the browser (`localStorage`). That storage belongs to the site address, is wiped when a **Private** tab closes, and is refused under Safari's **Block All Cookies**.

- At start the app checks that saving works. If it doesn't, a red banner says why, and every failed save says so instead of failing silently.
- Where supported, it asks the browser to keep the data permanently (`navigator.storage.persist()`).
- Names are typed in an in-app box, not the browser's `prompt()`, which some Home Screen apps and in-app browsers block.
- **Settings → Backup → Export** saves everything to `codriver-backup-YYYY-MM-DD.json` (on iPhone via the share sheet: Save to Files, AirDrop…). **Import** merges a backup back in: places, routes, notes and fixes by id, and ghosts and best times keeping the faster one. Use it to restore, or to move to another phone.

## 🏆 Leaderboard

Every finished run is recorded on that route's leaderboard on this phone (`board.js`, stored as `codriver.board`):
- **Stages (A→B)** rank by time. **Circuits** rank by **best lap**, so a 2-lap run and a 5-lap run compare fairly. Each row also shows the laps and the total time. Time-attack laps have their own board.
- Open it from **Route → 🏆 Leaderboard**, from the route page, or from the results card. The route you're on is listed first. The results card tells you your place, e.g. "🏆 P2 of 5".
- **Delete:** tap ✕ on a time **twice** to delete it, or 🗑 **twice** to clear that route's board. The second tap guards against accidents.
- **Drive it** loads that route again.
- Keeps the 25 best per route. Included in **Export backup**, and imports merge without duplicates.
- **Simulated runs are never recorded**: no leaderboard entry, personal best or ghost. The results card says "🧪 Simulation — not recorded".

## Red light timer

Two **RED** buttons on the right of the screen, **35** and **70** seconds by default. They show while driving and on the map. **Tap one when a light turns red** and it counts down in big numbers.
- **One double beep at 10 seconds left**, and the timer turns yellow.
- **It runs for exactly the red time and disappears at zero.** Driving doesn't stop it, since you might be timing a light further up the road. **✕ Close** ends it early.
- **−5 / +5** adjust it, **↻ 35 / ↻ 70** start again from either time, and **✕ Close** stops it.
- **Settings:** set the seconds for each button (5–600), or hide the buttons.

## ➕ Routes with several destinations

Open any route (for example from ★ My routes), then go to the route page → **➕ Continue to…** and pick what comes next:
- **one of your places** (Work, Home…)
- **another saved route** (its path is added after this one; a lap goes round and back to its start first)
- **a spot on the map**

The current end becomes a **named stop**. While driving you hear "Stop, Gas station" and see "✓ Stop: Gas station", and the finish unlocks after the last stop. There's **no limit** on stops or points: long lists are routed in chunks of 25 points and joined into one route. Repeat to chain as many as you like ("Gas station → Work → Gym"), then **☆ save** it as its own route. Stop names are kept in saved routes and share links. A recorded track that's chained becomes ~40 points along it, routed on the same roads.

## ⛽ Gas cost

**Settings → ⛽ Gas cost → Show it** (off by default). Enter your car's efficiency in **mpg**, **km/L** or **L/100 km**, the **gas price** (per gallon with mpg, per litre otherwise) and your currency symbol. Switching units converts the numbers, so it stays the same car and the same price. (`fuel.js`)
- **On a route:** the route box shows "⛽ ~$0.29", and the route page shows "gas ≈ $0.29 (0.08 gal)". Circuits use your number of laps.
- **At the finish:** the results card shows **Gas spent**, worked out from the distance you actually drove, and the voice says it ("Gas, about 2 dollars 85").
- Cars only: it's hidden for bike and on foot.

## Your notes are called ahead of the spot

A pothole or a camera can't be seen coming the way a corner can, so **your notes are called a set distance before the spot**: **Settings → Warn about your notes**, 100 / **150** (default) / 250 / 400 m. At high speed they come even earlier if the normal timing would be earlier. **＋ Note while driving pins the note a little behind you** (10–45 m depending on speed), because you tap after you've seen or hit it.

## 📝 Note mode (while driving)

While driving, **＋ Note** switches to **note mode**: the map and calls carry on, and the bottom bar becomes **8 big buttons**.
- **An empty button (＋):** tap it and pick any note from the list. It can be one word or several in order ("caution, rocks inside"). It stays on that button.
- **A filled button:** tap it **as you pass the spot**. The note is saved right there (a little behind you, for reaction time), with a short double beep, and from then on it's called ahead of the spot (Settings → Warn about your notes). A quick double tap counts as one note.
- **✎ Edit buttons** to change or empty any button. **Full list…** adds a one-off note. **Done** (or ✓ Notes) brings the normal bar back.
- The 8 buttons start from your favourites and are saved with your settings, including in backups.

## ★ Favourite notes

**＋ Note** opens with up to **4 big favourite buttons** on top. **One tap saves that note** where you are, with no scrolling, which is safer while driving. The defaults are speed camera, pothole, caution and bumps. **✎ Choose favourites** lets you tap words in the list to add or remove them (4 at most). For a combination ("caution, rocks inside"), use the full list below as before. Favourites are saved with your settings.

## Backup includes your settings

**Settings → Export backup** saves your places, routes, notes, fixes, leaderboard and ghosts, **plus all your settings**: voice speed and voice, look and Terminal colour, map colours, timers, units, call options and favourites. **Import** on a new phone restores everything and applies the settings straight away (the app reloads once).

## Distances in the calls

By default the calls **don't say the distance to the next call** ("left 4, 200, right 3" becomes "left 4, right 3"). The short links "into", "and" and "then" are still said, because they tell you corners come close together. **Settings → Distance between calls → Say it** brings the numbers back.

## Looks (skins)

**Settings → Look** picks the style. The app remembers your choice.
- **▓ Terminal** (default): flat terminal look, like the Criminal Terminal game: pure black, one colour and a pixel font, with square outlined keys, solid keys for what's selected, and "▓" section titles. No glow, scanlines or "old screen" effects. It uses the same pixel font as the game, **Web437 IBM VGA 8x16** by VileR ([int10h.org](https://int10h.org/oldschool-pc-fonts/)), licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) (see `fonts/LICENSE.txt`).
  - **Terminal colour** (shown under Look when Terminal is on): Red (default), Green, Amber, Blue, Cyan, Pink, Purple or White, or **any colour** from the colour picker. The black background always stays. Every glow, border and shade comes from that one colour, and the map tint and route line follow it. Warnings stay amber, or switch to red when your colour is amber, orange or white, so they still stand out.
- **LCD**: an olive stopwatch-style screen with dark digits.
- **Tripmeter**: a black box with glowing amber digits, like a rally instrument.
- **Classic**: the original look.

The route line follows the skin's colour. **Settings → Map colours** decides the map itself: **Regular** (the normal map, always), **Theme while driving** (default: normal while planning, drawing, editing and in the full-screen map, tinted to your skin's colour on the driving screen), **Theme always** (tinted everywhere), or **Track only** (on the driving screen the map disappears: pure black with just your route, your position and the call dots; planning, drawing and the full-screen map still show the normal map). Anyone who had the retired Arcade or Dot-matrix skin is moved to Terminal.

## 🚗 Liaison: getting to the start

**You see and choose the way there before you drive.** As soon as you open a circuit or stage that's more than 150 m away, the way from you to its start is planned and drawn **dotted** on the map, and the route chip shows "+1.2 km to get there". On the route page, **Getting there** has:
- **⚡ Fastest / 📏 Shortest**
- **✎ Change the way there**: tap the map where the way should pass (each point slots in where it fits), drag a point to move it, tap a point to remove it, with ↶ Undo
- **↻ From where I am now**, to re-plan from your current position

**Start** then drives exactly that way. If you've moved since, it's re-planned from where you are, through your points.


Press **Start** more than **150 m** from the route's start (a circuit's start/finish line) and the app **guides you there first**. This is the **liaison**, as in rallying: normal turn-by-turn calls and a dashed outline of the circuit on the map, but **no clock**. The screen shows "LIAISON — to the start of … · no timing" and the distance to the start.

When you get **within about 45 m of the start**, the real route takes over: 3-2-1 GO (or time attack's flying start), then laps and timing as usual. **Stop** during the liaison puts your route back as it was. Race again from the finish of an A-to-B stage guides you back to its start. Simulation always starts on the line.

## Time attack (circuits)

On a lap circuit, **Route → Circuit → Start** has two choices:
- **🚦 3-2-1 GO**: a countdown, and the clock starts on GO.
- **⏱ Time attack**: no countdown. Drive your out lap, and the clock starts the moment you **cross the start line**. If you're parked on the line, it starts as you pull away. The out lap counts toward neither the time nor the distance, and time-attack records are kept apart from GO records.

## Full screen while driving

- **Tap the arrow or the call text** → only the call, full screen: huge arrow, call and distance, with details below. Tap again for the normal view.
- **Tap the map** (a note's dot counts) → the map goes full screen, unrotated, and you can **pinch-zoom and drag** freely. Following pauses, and a slim strip at the top keeps showing the current call. **Tap the strip** or **↩ Back to driving** to return, and the map re-centres on you and follows again. A second tap on the map doesn't exit, because pinching and dragging would trigger it.

## Your position

Your position is always on the map, not only while driving. It shows a blue dot with a GPS-accuracy circle when you're standing still, and an arrow when you're moving. **◎** centres the map on you. While driving, that button switches between heading-up and north-up as before.

## Race mode

Start gives a 3-2-1-GO countdown with beeps. The race clock (top right of the note panel) starts on GO. In simulation the car waits on the line until GO.

- **Point to point:** the clock stops within 20 m of the finish.
- **Circuit:** choose the laps in the Route sheet (− / +, or ∞ for no finish). The summary shows the total distance and time for that many laps, e.g. "3 laps = 16.2 km · ~21 min". Starting within 50 m of the line counts lap 1 from GO. Starting elsewhere gives an out lap first. Each lap time is spoken, then "Last lap!" and the finish.
- **Results card:** shows the route name, a drawing of the route, the time, personal best (kept on the phone per route and lap count), average and top speed, distance driven, and for circuits the laps, best lap and lap length, plus each lap time. **Share result** sends the time with a link so friends can race the same stage. **Race again** restarts it.

The race logic lives in `race.js` and is unit-tested.

## Speed cameras (optional, off by default)

Turn on under Settings → Speed cameras. The app asks OpenStreetMap (Overpass API) for `highway=speed_camera` nodes in the route's area, keeps those within 40 m of the route, and calls them like any note: "speed camera, limit 50". A camera inside a corner is added to that corner's call. Cameras appear on the map as 📷.

The data comes from volunteers, so cameras can be missing or out of date. Mobile cameras are never included. Camera warnings are illegal in some countries (for example France, Germany and Switzerland).

## Circuits (laps)

To make a circuit, tick **Lap circuit** in the Route sheet, or switch the draw bar from **→ One way** to **⟳ Circuit** before you snap the route. The route is then closed back to its start, and the start/finish line becomes the start of each lap.

- **Notes across the start line:** the generator analyses three laps back to back and keeps the middle one. Corners that straddle the start line are measured properly, and the last note of the lap links into the first one.
- **Calls:** the scheduler treats a circuit as a sequence that never ends, so calls keep coming lap after lap.
- **Lap times:** the screen shows the lap number, the current lap time, the last lap and the best lap. Each lap time is spoken, and a new best is called out as "best lap".
- **Going off the circuit:** the app does not reroute. It says "Off route" once and picks the calls up again when you rejoin.

**Cancel route**, in the Route sheet, stops navigation and clears the route.

## Try it without driving

Tap Route → Load demo stage → Start. **Simulate at … km/h** drives the route at **exactly the speed you choose, anywhere from 1 to 300 km/h**: type it in the box or drag the slider. The speed stays the same the whole way, corners included, so you can hear how early the calls come at that speed. Untick **Simulate** to drive with the real GPS. Your speed is remembered.

## Dev

```
npm run notes     # print notes and simulated call timing for the demo stage
npm test
```

The public OSRM and Nominatim servers are demo services with fair-use limits. For real traffic, host your own instances or use a paid provider.

## Always the newest version

`_headers` tells browsers to check for a newer copy of every file on each visit (`Cache-Control: no-cache`, answered quickly with "not modified" when nothing changed), so a phone never keeps showing an old version after a deploy.
