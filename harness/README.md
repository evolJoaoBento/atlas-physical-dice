# Browser harness

Runs the **real plugin** in a browser tab.

```bash
npm run harness      # watch + serve on http://localhost:8732/harness/
```

Reload the page after a save. Both bundles rebuild on every change: the harness
you are looking at, and the `main.js` that Obsidian loads. Change `d20-dice.ts`
and it changes in both places, because there is only one copy of it.

## Driving the real Obsidian (preferred)

The harness is a replica, and a replica can always be wrong about something.
`harness/obsidian-cdp.mjs` avoids the question by attaching to Obsidian itself.

Nothing to launch by hand. Any command opens the port if it is closed, by
restarting Obsidian with it — so a cold machine and a warm one behave the same:

```bash
node harness/obsidian-cdp.mjs ensure     # port open, vault back, plugin loaded
node harness/obsidian-cdp.mjs restart    # restart even if the port is open
node harness/obsidian-cdp.mjs stop       # close Obsidian, and the port with it
```

`ensure` is idempotent, so it costs nothing to run first. `restart` is the one
to use after a rebuild: it is what loads the new `main.js`. Both close Obsidian
by asking its window to close before insisting, wait for the debug port to
answer, and then wait again for `app.plugins.plugins["atlas-physical-dice"]` to exist — a window
on the port is not yet a loaded plugin, and an eval that lands in between fails
for reasons that have nothing to do with what it was testing.

Set `OBSIDIAN_EXE` if Obsidian is not at `%LOCALAPPDATA%\Obsidian\Obsidian.exe`.

Then:

```bash
node harness/obsidian-cdp.mjs eval "app.plugins.plugins["atlas-physical-dice"].settings.diceSize"
node harness/obsidian-cdp.mjs eval-file harness/scripts/smoke.js   # 23 checks
node harness/obsidian-cdp.mjs shot out.png                         # whole window
node harness/obsidian-cdp.mjs shot out.png 300 390 1120 180 2      # clipped, 2x
node harness/obsidian-cdp.mjs pump 900                             # advance frames
node harness/obsidian-cdp.mjs click 240 195
node harness/obsidian-cdp.mjs drag 100 100 400 300
node harness/obsidian-cdp.mjs front
node harness/obsidian-cdp.mjs reload
```

Two things the driver does *not* handle, and both cost a round trip the first
time:

- **`saveSettings()` is debounced.** It calls `queueSave()` and returns before
  anything reaches disk, so an `await` on it proves nothing. Sleep ~3s before
  reading `data.json` back.
- **A debug value written into the live settings gets persisted.**
  `writeSettings()` serialises the whole settings object, so the next save from
  anywhere — a settings-tab control, the smoke suite — writes your debug value
  to `data.json`. Setting `showWindowBorder` to a bright red to measure the
  overlay region is not temporary. Read the fields off disk with
  `await p.loadData()` first, and put them back when you are done.

Two things the driver does handle that are easy to get wrong:

- **Throttling.** Chromium treats a window behind your terminal as hidden and
  stops requestAnimationFrame entirely, so nothing moves and every timing test
  lies. Every connection turns on focus emulation and forces the page lifecycle
  active, which removes it. The tell, if it ever comes back, is velocities that
  are byte-identical across samples.
- **Pumping.** `pump` runs the plugin's real `animate()` with a fixed timestep,
  so physics advances deterministically and far faster than real time.

Close the debug port when you are done: `stop` and reopen Obsidian normally, or
just restart it yourself. While the port is open, anything running locally can
drive the app and read the vault.

### smoke.js

`harness/scripts/smoke.js` drives the plugin through its own commands and
buttons — 23 assertions covering the overlay, dice creation, rolling, the sleep
and loop-stop chain, shadow visibility and outline alignment, hit testing, the
settings path and the leak checks. It pumps rather than waiting on the clock,
so it does not care whether Obsidian is focused.

## Obsidian's own CSS

`npm run harness` first runs `harness/extract-obsidian-css.mjs`, which pulls
`app.css` out of the Obsidian installed on this machine into
`harness/obsidian-app.css`.

This is not optional polish. The plugin's `styles.css` holds only the plugin's
own additions; everything underneath — `mod-cta`, `mod-warning`, base button and
input styling, `.setting-item`, `.checkbox-container`, the entire colour-variable
system — lives in Obsidian's app.css. Without it `Roll All Dice` renders white
instead of accent-purple, toggles are bare checkboxes, and nothing matches.

The extracted file is Obsidian's, not ours: generated locally, gitignored, never
committed. If it is missing the harness still runs, falling back to a small
hand-written variable set in `harness.css` — recognisable because the buttons go
plain.

The theme class on `<body>` is `theme-light` to match `appearance.json`
(moonstone). Swap it for `theme-dark` to check the other one.

## What is actually shared

Everything that matters:

| | |
|---|---|
| `d20-dice.ts` | the same file, imported directly |
| `main.ts` | the same plugin class, constructed and `onload()`ed |
| `settings.ts` | the same settings tab, mounted in its own pop-out |
| `styles.css` | the same stylesheet, `<link>`ed from the page |
| `data.json` / `textures.json` | seeded into the fake vault on first boot, so the dice carry your real face textures |

Nothing in `harness/` reimplements any of it. If it did, it would drift, and a
harness that drifts is worse than none.

## What is faked

`harness/obsidian-stub.ts` stands in for the `obsidian` module, swapped in by
esbuild's `alias` at bundle time. The plugin is not modified and does not know.

- `loadData`/`saveData` and `vault.adapter.*` → `localStorage`, seeded on first
  boot by fetching the plugin's real `data.json` and `textures.json`
- ribbon icons and commands → buttons in the harness pop-out
- `Notice` → a toast in the corner
- `Setting` and its controls → plain inputs, driving the plugin's real
  `onChange` handlers
- chat and API views are bundled (main.ts imports them) but never mounted

**Anything not stubbed throws by name.** `app` and `app.workspace` are Proxies
that reject unknown properties, so the harness starting up is itself evidence
that the plugin uses nothing outside the stub. When that changes, the error says
which API to add.

Not faked, and worth remembering: this is Chromium, Obsidian is Electron, and
Obsidian's own chrome is absent. High-confidence iteration, not a substitute for
a final check in a vault.

## `window.__dice`

Open the console. Everything below is available there.

### Looking

| | |
|---|---|
| `__dice.summary()` | one line: overlay, loop, draws/s, steps/s, sleep states |
| `__dice.probe()` | the same as an object, plus per-die position, speed, sleep state and blob shadow |
| `__dice.engine` | the live `D20Dice`, or `null` when the overlay is closed |
| `__dice.settings` | the live settings object |

### Driving

| | |
|---|---|
| `__dice.open()` / `close()` | toggle the overlay through the real ribbon callback |
| `__dice.add('d20', 5)` | add dice |
| `__dice.roll()` / `clear()` | roll, clear |
| `__dice.set('diceSize', 1.2)` | change a setting and push it through the plugin's own refresh path |
| `__dice.reboot()` | reload the plugin without reloading the page |
| `__dice.reset()` | wipe the fake vault, then reboot |
| `__dice.trigger('layout-change')` | fire a workspace event |
| `__dice.listenerCount('layout-change')` | check listeners are actually being cleaned up |

### Pumping — the important one

Chrome suspends `requestAnimationFrame` in a tab that is not visible, and an
automated tab usually is not, so the render loop simply freezes and nothing can
be observed. Drive it by hand instead:

| | |
|---|---|
| `__dice.pump(frames, dtMs)` | run N real frames with a synthetic clock |
| `__dice.settle(maxFrames)` | pump until every die is asleep; returns `{frames, settled}` |
| `__dice.rollAndWait()` | roll, pump to a standstill, and wait for the result string |

`pump` calls the plugin's actual `animate()`, so physics, the sleep check, the
transform copy, the blob update and the draw all happen exactly as on a real
frame. Only the clock is synthetic — which also makes runs repeatable in a way
rAF never is.

**Pumping does not advance the wall clock.** `startIndividualDiceMonitoring()`
polls on `setTimeout` and wants two real seconds of stability before it reads a
face, so the dice can be fast asleep while the roll has not resolved yet. Use
`rollAndWait()` rather than `settle()` when you care about the result string —
otherwise you will see an empty result and conclude something is broken.

Note that `pump` cancels the pending rAF as it goes, so `loopRunning` reads
`false` straight after one. To check the loop stops *on its own*, wake it and
step a single frame:

```js
const e = __dice.engine;
__dice.settle();
e.wake();                                  // as any mutation would
e.lastFrameTime = performance.now() - 16.7;
e.animate();
e.animationId === null;                    // true = it declined to reschedule
```

## Three pop-outs, one set of styles

| panel | what it is |
|---|---|
| **controls** | the plugin's own floating panel — add dice, roll, clear, clickthrough, result |
| **harness** | ribbon, commands, harness-only actions, live state, dice list, fake vault |
| **settings** | the plugin's real settings tab (toggle it from the harness panel) |

All three carry the plugin's `dice-controls-panel` class, so the frame,
background, border, radius and shadow come from the real `styles.css` and cannot
drift from it. All three drag by the same `dice-controls-drag-handle`.

The harness grows **no copies** of the plugin's controls. Adding dice, rolling
and clearing exist only in the plugin's own panel — a duplicate would mean
testing the copy instead of the thing that ships.

Backslash, or the ⚙ button top-right, hides the harness pop-outs so the overlay
looks exactly as it does in Obsidian.

## What it has already caught

- `THREE.WebGLRenderer.render` is an own property of each instance, not a
  prototype method — a counter patched onto the prototype silently never fires.
- Below 8 solver iterations a d4 never reaches `SLEEPING`, so the render loop
  never stops. See "Measured in the harness" in `PERFORMANCE-NOTES.md`. This one
  reversed a change that had looked like a clear optimisation.
