# Performance notes for the dice

These come from porting this plugin's dice into a Next.js site
(`mestrerpg.pt`) — same Three.js + cannon-es pair, same tray, same materials,
same `throwDice`. Everything below was measured or reproduced there, and each
item says whether it applies back here.

Line numbers refer to `d20-dice.ts` as of this writing. They will drift; the
`grep` next to each one will not.

---

## Status (2026-08-21)

Everything below was reproduced against this codebase and then applied, except
where noted. Line numbers in the items are from before that pass and no longer
resolve; the `grep`s still do.

| # | Item | Status |
|---|------|--------|
| 1 | `world.allowSleep` | **done** — `initPhysics()` |
| 2 | Loop never stops | **done** — `animate()` stops itself; every mutation calls `wake()` |
| 3 | Dragging fights the solver | **done differently** — the world still steps (other dice must keep moving), but `applyDragPosition()` re-places the held die after each step, before anything is drawn |
| 4 | Draw from the pointer event | **done** — `onMouseMove`/`onTouchMove` call `renderFrame()`; `animate()` skips its own draw for 32 ms afterwards |
| 5 | Scissor rect | **skipped** — with (2) in place there are zero draws once the dice sleep, so this only pays during the ~2 s tumble |
| 6 | Shadow map | **done, but not as the note suggests** — real shadows, kept. See "Blob shadows were the wrong answer" below |
| 7 | Renderer settings | **done** — `precision: "mediump"`, `setPixelRatio(min(dpr, 1.5))` |
| 8 | `world.step(1/60)` one-arg | **done** — real delta clamped to 50 ms, 2 substeps. The solver-iteration half is **rejected**: see below |
| 9 | Hull rebuilt per die | **done** — cached per `type:size`. The dedup half did not apply: the hull builder already deduplicates by position |
| 10 | Radius hit-test | **done** — `pickDiceIndex()` replaces the raycast in click, hover and enter |
| 11 | Hot-path small things | **done** — random debug log deleted, rect cached, cursor written only on change |

Found while applying, not in the original list:

- `applyRollForces`, `throwDice`, `startDrag*`, `rerollCaughtDice` and
  `animateAllDice` all needed `body.wakeUp()`. Item 1 is inert without them,
  and worse than inert: a sleeping die silently ignores the impulse.
- `createDiceTray()` is called again on every settings change and added a
  fresh floor plus four walls to the world each time, forever. Now torn down
  first.
- The mesh spin in `updateDicePosition()` was overwritten by `animate()`'s
  quaternion copy on the very next frame, so dragging never actually spun
  anything. The copy now skips the held die.
- `destroy()` disposed the renderer but not geometries, materials or the
  megabyte face textures, and its `world.bodies.forEach(removeBody)` skipped
  every second body.
- ~1.4 MB of base64 face textures lived in `data.json` and were re-serialised
  on every settings change. They now live in `textures.json` next to it.
- `loadTextureFromData` built a fresh `THREE.Texture` per die, so a tray of
  twenty d20s uploaded twenty copies of the same megabyte face sheet to the
  GPU. Now one texture per distinct image.
- `world.solver.iterations` was cannon-es's default 10, not the 3 the site ran.
  Left at 10; see the measurement below for why lowering it is a trap.
- Shadows had never worked at all, for two independent reasons: `castShadow`
  was set on the **Material**, where it means nothing (it is an `Object3D`
  property, and the multi-dice meshes never set it), and the live settings have
  `showSurface: false`, so there was no receiver in the scene either. Both are
  fixed; see the next section.

## Blob shadows were the wrong answer

Note 6 suggests replacing the shadow pipeline with "an unlit quad carrying a
soft radial or hexagonal gradient". That was built, refined over several passes,
and then thrown away. Recording why, because the note still recommends it.

**Why it looked necessary.** The plugin's shadows had never worked, for two
independent reasons: `castShadow` was being set on the *Material*, where it
means nothing — it is an `Object3D` property, and the multi-dice meshes never
set it — and with `showSurface` off there is no geometry in the scene for a
shadow to land on. The canvas is transparent over a note. A shadow map needs a
receiver, and there was none.

**Why the blob kept not working.** A quad has to be told what shape to be and
which way to face, and both are surprisingly hard:

- Aiming the outline using a yaw extracted from the quaternion is meaningless. A
  die at rest is tilted onto a face, so rotation about world Y is not the
  rotation of the silhouette. Across seven yaws the error was random.
- Aiming at the lowest vertex is exact at rest but discrete, so mid-tumble the
  outline snapped by up to 58 degrees in a single frame.
- Summing an n-fold orientation moment over the lower vertices, with temporal
  smoothing, fixed that — 2.6 degrees worst case. About two hundred lines, all
  of it spent faking something a shadow map does for nothing.
- And it was still only ever an approximation of the silhouette, which showed on
  the d4 and d6.

**What actually solves it: THREE.ShadowMaterial.** A mesh wearing one draws
nothing except the shadows falling on it. Put that on a plane at the resting
height and the canvas stays transparent while shadows land, apparently, on the
note behind it. That is the receiver the scene was missing.

Two details make it work:

1. **The caster has to lean.** The camera looks straight down and the configured
   light is nearly overhead — (9, 50, 0) — so a die's shadow lands underneath
   the die and is completely hidden. So the shadow comes from a *second*
   directional light, leaning over at 0.55 horizontal per unit of height, with
   **zero intensity** so it changes nothing about how the dice are lit. A
   zero-intensity light still casts onto a ShadowMaterial, because that material
   draws the shadow mask directly instead of darkening a light's contribution.
   Verified in the running app rather than assumed.
2. **Softness is not worth chasing here.** Recorded because it cost several
   passes and ended back where it started.

   - `PCFSoftShadowMap` — three's default soft filter — ignores
     `shadow.radius` and filters a fixed handful of texels. The only way to
     soften it is to shrink the map until the texels themselves show as blocks:
     512 was the floor, 256 was visibly blocky.
   - `PCFShadowMap` does honour `shadow.radius`, but spends the same fixed
     handful of taps over a wider area. Turning it up scatters the samples, so
     what you get is a visible sampling pattern rather than a blur. It reads as
     pixelated.
   - `VSMShadowMap` supports a real Gaussian and is the textbook answer. Tried
     twice, the second time with the catcher refitted inside the shadow frustum.
     Both times its blur pass leaked vertical bands across the entire canvas.
     Unusable on a transparent receiver.
   - A **16-tap Poisson disk** patched into the catcher's ShadowMaterial via
     `onBeforeCompile` did produce a genuinely smooth, wide blur. It also made
     the plugin noticeably laggy in real use, and was reverted.

   Shipping `PCFSoftShadowMap` with three's own defaults. *(Superseded — the
   shadow map was later removed entirely. See "Blurred discs, second time
   around".)*

3. **Blockiness was a resolution problem, not a filter problem.** Everything
   above chased *softness* and got nowhere. The shadow later still read as
   pixelated for a different reason: the shadow camera is fitted to the whole
   tray plus the lean, about 58 world units across, so at 1024 the map carries
   ~18 texels per world unit. The view camera puts 55-80 device pixels on that
   same unit, which makes one shadow texel a 4-5 pixel block on screen — and a
   d20 at `diceSize` 0.8 only ~28 texels wide to begin with.

   `SHADOW_MAP_SIZE` is now 2048, halving the block. The other lever, fitting
   the shadow camera to the dice instead of the tray, buys more density but
   reintroduces the bug the frustum fit exists to prevent: a die outside the
   frustum stops casting, and the shadow blinks out. A per-frame fit also makes
   texel density change as dice spread, so edges shimmer. Not taken.

## Blurred discs, second time around

The shadow map is gone. Everything above stands as a record of making it work
and then making it sharp; none of it made it stop looking wrong.

Three things were true at once by the end:

- **Janky.** Raising the map to 2048 fixed the blockiness and the shadow still
  read as a rendering artefact rather than as a die sitting on a page.
- **It vanished on landing.** The catcher followed the *visible* tray top when
  `showSurface` was on, which is 0.8 above where dice actually rest — the tray
  box was centred at -2 with the physics floor at its underside, -2.4, so every
  die was buried 0.8 deep inside the surface it appeared to be on. A landed die
  sat below its own receiver and cast nothing.
- **Its direction could not be reconciled with the light.** `SHADOW_LEAN` threw
  away the configured elevation and substituted 0.55, because the real one puts
  the shadow under the die where it cannot be seen. Measured: a light at
  (27, 81, -11) implies 0.36; the shadow used 0.50. With the light exactly
  overhead there was no azimuth to read at all and it fell back to a hardcoded
  diagonal.

A disc centred under each die has none of these. There is no direction to keep
in sync and no plane to miss.

**Sizing is per type, and measured.** A d6 is `BoxGeometry(size * 2)`, so at the
same `diceSize` its resting footprint is 1.7x a d20's; a d4 rests on a triangle
and covers three quarters of one. `BLOB_RADIUS` holds the radius of the circle
with the same area as each type's footprint, read out of the running app:

| | d4 | d6 | d8 | d10 | d12 | d20 |
|---|---|---|---|---|---|---|
| radius x size | 0.65 | 1.13 | 0.80 | 0.80 | 0.88 | 0.86 |
| rest height x size | 0.58 | 1.00 | 1.00 | 0.95 | 0.93 | 0.85 |

One radius for every type is the thing that makes blob shadows look cheap.

**Silhouette blobs were tried and removed.** d4, d6 and d10 have outlines a
circle cannot describe — a d6's disc sits between its inscribed 0.80 and
circumscribed 1.13, so it bulges past the flat edges and never reaches the
corners at once. Three attempts at drawing the die's actual outline instead:
rings scaled about the centroid, rings at a constant radial offset, and finally
a signed distance field in a fragment shader. The first two put a dark wedge at
every corner (scaling and radial offsetting are both not offsetting by
*distance*); the third was correct but exposed a much older bug — the convex
hull kept duplicate points, because a die repeats each corner once per face, and
a zero-length edge made the field divide by zero and tear.

All of it is gone. The disc is what ships, for every type. It does not fit a d6
and that is accepted: tight and plain beat clever and fragile here, and three
rewrites of the same feature is the signal to stop.

**Tightness, and only where it was wanted.** d8, d12 and d20 were fine and are
untouched: `BLOB_SPREAD` stays 1.25 and their radius is still their footprint's
area-equivalent. d4, d6 and d10 moved to their footprint's *inscribed* radius,
so the disc stays inside the shape and only the fade reaches past it. Measured
against each die's own outline radius: d4 0.61, d6 0.71, d10 0.68, against
d8 1.22, d12 1.12, d20 1.09.

## A benchmark that measured the wrong thing

The Poisson filter was benchmarked at "+0.16 ms per frame" and shipped on that
basis. The number was meaningless: it timed the CPU around `animate()`, and the
work was in the fragment shader, which the CPU never waits for. The shadow
catcher is a plane covering most of the canvas, so those sixteen extra texture
reads ran on a few million pixels a frame and none of it appeared in the timing.

Two lessons, both of which cost a round trip through the user:

- **Put `gl.finish()` around anything that claims to measure rendering.**
  Without it a GPU-bound change measures as free.
- Even with it, these numbers came back unstable — the same configuration
  measured 0.55 ms and 7.6 ms in one run, minutes apart. Shader compilation on
  the first pass, and whatever else the machine is doing, swamp the effect.
  Treat a microbenchmark here as a hint, and a person saying "it is laggy" as
  the measurement.

**Cost.** A shadow map is a second render of the scene into a depth texture
every frame, so it is not free — with two dozen dice it roughly doubles the draw
calls. It is still the cheaper of the two approaches that were tried: the blob
system paid per-die vertex maths, a material write each, and two dozen extra
transparent draw calls on top of its own fill.

No numbers are quoted here on purpose. See the section above for why the ones
that were quoted turned out to be worthless.

*(Superseded: there is no shadow map any more. `enableShadows` still switches
the blobs off, and it is now the only lever, because the blobs cost one small
transparent quad each.)*

The blob was more expensive than the thing it was avoiding: per-die vertex
maths, a material write each, and two dozen extra transparent draw calls, versus
one depth pass the GPU is built for.

## Measured in the harness, contradicting note 8

`npm run harness` (in the upstream obsidian-physical-dice repo, where the harness
now lives) boots the real plugin in a browser. It found this, and it is
the reason to distrust the solver-iteration advice below.

**Lowering `world.solver.iterations` stops the dice sleeping at all.**

Below 8 iterations the solver never fully resolves a d4 or d8 resting on its
face. The residual jitter stays tiny — speeds around 0.004 — but spikes past
`sleepSpeedLimit` often enough that cannon calls `wakeUp()`, which restarts the
one-second sleep timer. The body sits in `sleepState` 1 (SLEEPY) forever and
never reaches 2 (SLEEPING).

A body that never sleeps means `animate()` never stops rescheduling, so item 2 —
far and away the biggest win here — is silently cancelled out. The handful of
solver iterations saved is not close to worth it.

Three runs each, one die of every type, pumped to 3000 frames:

| iterations | settled | frames to settle |
|---|---|---|
| 2 | 1/3 | never, never, 426 |
| 4 | 0/3 | never |
| 6 | 0/3 | never |
| 8 | 3/3 | 394, 365, 454 |
| 10 (cannon-es default) | 3/3 | 461, 384, 1802 |

Left at the default 10. The site presumably never saw this because it rolls d20s
and the icosahedron rests stably; the d4 is what breaks it.

---

## 1. `world.allowSleep` is `false` by default — set it

**This is the big one and it is live in this plugin right now.**

```bash
grep -c "world.allowSleep" d20-dice.ts   # → 0
```

`Body.allowSleep` defaults to `true`, and `initPhysics()` sets
`sleepSpeedLimit` and `sleepTimeLimit` on every die, so the sleep configuration
*looks* complete. It does nothing. `World.allowSleep` is the flag that decides
whether cannon-es ever calls `sleepTick`, and `World`'s constructor is
`this.allowSleep = !!options.allowSleep` — i.e. `false` unless asked.

The consequence: `body.sleepState` never leaves `AWAKE`, so any check of the
form "stop when the dice are asleep" is permanently false.

```ts
// in initPhysics(), next to the gravity line
this.world.allowSleep = true;
```

Verify by logging `body.sleepState` a few seconds after the dice settle. It
should read `2` (`Body.SLEEPING`), not `0`.

## 2. The animation loop never stops

`animate()` (≈ line 2747) re-schedules itself and calls
`this.renderer.render(...)` on every frame for as long as the view is open,
whether or not anything has moved. Dice at rest cost exactly as much as dice in
mid-air. In a note-taking app that is a background tab quietly holding a GPU
awake.

With (1) in place, gate it:

```ts
private animate() {
    if (!this.isViewActive) { /* existing teardown */ return; }

    const anyAwake = this.diceBodyArray.some(
        (b) => b.sleepState !== CANNON.Body.SLEEPING
    );
    const mustDraw = anyAwake || this.isDragging || this.showingResult || this.needsRender;

    if (anyAwake) this.world.step(1 / 60, dt, 2);
    if (mustDraw) { /* copy transforms; */ this.renderer.render(this.scene, this.camera); }
    this.needsRender = false;

    // Only keep the loop alive while there is something to do. Anything that
    // changes the picture — a throw, a drag, a resize, a new die, a settings
    // change — calls a `wake()` that restarts it if it is not running.
    this.animationId = mustDraw ? requestAnimationFrame(() => this.animate()) : null;
}
```

The pattern that matters: **a `wake()` function every mutation calls**, and a
loop that sets `animationId = null` and returns instead of re-scheduling. On
the site this took a permanently-pegged frame loop down to nothing within about
a second of the die landing.

## 3. Dragging fights the solver, and that is the "lag behind the cursor"

`onMouseMove` → `updateDicePosition()` writes `body.position` every move, and
`animate()` keeps stepping the world underneath it. Every frame the solver
applies gravity and pushes the body out of the walls it was just placed
against, and what you see is that correction — one frame late, in the opposite
direction to the drag.

**Do not step the world while a die is held.**

```ts
if (anyAwake && !this.isDragging) this.world.step(1 / 60, dt, 2);
```

The world resumes on release, which is when `throwDice` sets the velocity
anyway.

## 4. Draw from the pointer event, not from the next frame

Separate from (3), and it survives fixing (3).

A `requestAnimationFrame` callback can run *before* that frame's pointer move
has been delivered. A loop that renders on rAF therefore draws the position
from the move before last — always one behind, always in the direction of
travel. At a brisk drag that is thirty or forty pixels of daylight between the
cursor and the die, on every frame.

Render inside `onMouseMove`/`onTouchMove` while dragging, and have `animate()`
stand down (`animationId = null; return;`) for the duration. Browsers already
coalesce pointer moves to one per frame, so this costs no extra draws — it just
uses the freshest position that exists.

This was the single biggest improvement to how the drag *feels*.

## 5. Draw only the part of the canvas the dice are in

`renderer.render()` redraws the whole canvas to move a small object. Use the
scissor:

```ts
// union of where the dice are now with where they were last frame — the union
// is what clears the place they just left
renderer.setScissorTest(true);
renderer.setScissor(x0, canvasHeight - y1, x1 - x0, y1 - y0);
renderer.render(scene, camera);
```

Fall back to a full `setScissorTest(false)` draw on resize, and whenever the
union grows wider than the canvas (at which point it saves nothing).

Worth roughly a fortieth of the fill on the site. Here the win scales with how
much empty tray there is around the dice — large tray, few dice, big win.

## 6. The shadow map is two render passes for a smudge

```bash
grep -n "shadowMap.type\|castShadow\|receiveShadow" d20-dice.ts
```

`PCFSoftShadowMap` takes many more taps per fragment than `PCFShadowMap`, and
the shadow pass is a second render of the scene every frame.

Cheapest fix that changes nothing visible: `PCFShadowMap`, and a shadow map
sized to the tray rather than left at the default (a `DirectionalLight`'s
shadow camera is a 10-unit box around the origin — dice thrown past it stop
casting entirely, which may already be happening here).

Bigger fix, if the camera looks steeply down: replace the whole shadow pipeline
with an unlit quad carrying a soft radial or hexagonal gradient, scaled and
faded by the die's height above the floor. Seen from overhead a projected
shadow and a blob are the same picture. On the site this removed the depth
pass, the shadow map and both `castShadow`/`receiveShadow` flags — and looked
*better*, because the real one had a hard edge.

If you do this: offset the blob away from the light by an amount proportional
to height. A shadow directly under a die viewed from directly above is entirely
hidden by the die, which makes it look like there is no shadow at all.

## 7. Renderer settings

```ts
new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
    precision: "mediump",   // flat-shaded solids + a texture; highp buys nothing
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
```

Line ≈3210 currently passes `window.devicePixelRatio` uncapped. On a 3× display
that is nine times the fragments of 1×, for dice about a hundred pixels across.

## 8. `world.step(1/60)` with one argument ties physics to frame rate

Line ≈2761. With no `timeSinceLastCalled` and no `maxSubSteps`, cannon advances
exactly one fixed step per *frame*, so the dice fall in slow motion on a 30 Hz
display and at double speed on 120 Hz. Pass the real delta:

```ts
this.world.step(1 / 60, dt, 2);   // dt clamped to ~0.05 for backgrounded tabs
```

Clamping matters: a tab that was in the background resumes with a delta of
several seconds, and integrating that in one go teleports dice through walls.

Two solver iterations rather than three was not measurably worse for a handful
of convex bodies against static walls.

## 9. The collision hull is rebuilt per die, from a throwaway geometry

`createPhysicsShapeForDiceType()` calls `createGeometryForDiceType()`, builds a
`ConvexPolyhedron` from it, then disposes the geometry — every time a die is
created. Cache one hull per dice type at module or class scope; the shape is
identical for every d20.

Related: the hull is built from a **non-indexed** geometry, so a d20 has 60
vertices for 20 faces. cannon's SAT narrowphase iterates those. Deduplicating
positions before constructing the hull cuts the vertex loop by two thirds
without changing the shape.

## 10. Hit-testing: a radius beats a raycast

`checkDiceClick` raycasts against the meshes. That is the exact answer and the
wrong one: a tumbling icosahedron presents thin edges and sharp corners, so
"on the die" by geometry is a target that keeps changing shape under the hand —
and shrinks to a sliver at exactly the moment a die lands on an edge.

Project each die's centre to the screen and take anything within a radius of
it. That is the target a person perceives, it is pure arithmetic per mouse
move, and it allocates nothing.

## 11. Small things in the hot path

- `animate()` has a `Math.random() < 0.01` debug log (≈ line 2764). A random
  call and an occasional template-string format, per frame, forever.
- `getBoundingClientRect()` per pointer event flushes layout. Cache it per
  frame, or derive from scroll offsets.
- `document.body.style.cursor = ...` on every mouse move is a style
  recalculation on every mouse move. Only write it when the value changes.

---

## Applies to the site, not to this plugin

Recorded so nobody ports them back by mistake:

- **Canvas positioning.** The site had to make its canvas `position: absolute`
  in the document rather than `fixed`, because a fixed canvas cannot keep up
  with compositor-thread scrolling and the die visibly slid against the page.
  A plugin panel does not scroll, so this is not your problem.
- **World units pinned to pixels.** The site derives the orthographic frustum
  from the canvas size so a die is the same size on a short page and a long
  one. Here the tray is a fixed size from settings, which is simpler and fine.
- **Deferring the bundle.** The site loads Three.js on idle and skips it for
  reduced-motion / data-saver / low-memory devices. Obsidian is a desktop app
  that already has the plugin loaded.

## A note on method

Four separate wrong diagnoses were made on the site's dice before the right one
— including two confident ones written up as fact. Every item above was
confirmed by instrumenting a running build (a frame counter, a logged
`sleepState`, a captured URL) rather than by reading code and reasoning about
it. The code reads correctly in all four of the wrong cases.

If something here does not reproduce, trust the instrument.
