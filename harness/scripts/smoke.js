/*
 * Functional pass over the running plugin, executed inside Obsidian:
 *   node harness/obsidian-cdp.mjs eval-file harness/scripts/smoke.js
 *
 * Everything here goes through the plugin's own commands and buttons rather
 * than poking internals, so a failure is a failure a user would hit.
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, detail) => results.push({ name, ok, ...(detail ? { detail } : {}) });

/**
 * Drive the render loop by hand instead of waiting on rAF.
 *
 * Chromium throttles requestAnimationFrame hard when its window is not in the
 * foreground, and a window being driven from a terminal usually is not. Waiting
 * on wall-clock made this test report "dice never sleep" purely because Obsidian
 * was behind the terminal. Pumping the real animate() with a fixed timestep
 * removes focus from the equation entirely.
 */
async function pump(frames) {
    const d = plugin.dice;
    let settledAfter = null;
    for (let i = 0; i < frames; i++) {
        if (d.animationId !== null) { cancelAnimationFrame(d.animationId); d.animationId = null; }
        d.lastFrameTime = performance.now() - 1000 / 60;
        d.animate();
        if (settledAfter === null && d.diceBodyArray.length &&
            d.diceBodyArray.every((b) => b.sleepState === 2)) {
            settledAfter = i + 1;
        }
        // Hand the thread back regularly: Obsidian stays responsive, and the
        // roll monitor's setTimeout chain gets to run.
        if (i % 60 === 59) await wait(0);
    }
    if (d.animationId !== null) { cancelAnimationFrame(d.animationId); d.animationId = null; }
    return settledAfter;
}

// Collect anything the plugin logs or throws for the duration of the run.
const errors = [];
const origError = console.error;
const origWarn = console.warn;
console.error = (...a) => { errors.push('error: ' + a.map(String).join(' ').slice(0, 200)); origError(...a); };
console.warn = (...a) => { errors.push('warn: ' + a.map(String).join(' ').slice(0, 200)); origWarn(...a); };
const onErr = (e) => errors.push('uncaught: ' + (e.message || e.reason));
window.addEventListener('error', onErr);
window.addEventListener('unhandledrejection', onErr);

const plugin = app.plugins.plugins["atlas-physical-dice"];

try {
    // --- open ---------------------------------------------------------------
    if (!plugin.isVisible) app.commands.executeCommandById('atlas-physical-dice:toggle-dice-roller');
    await wait(600);
    record('overlay opens', plugin.isVisible === true);

    const panel = document.querySelector('.dice-controls-panel');
    record('controls panel present', !!panel);

    const dice = plugin.dice;
    record('engine created', !!dice);

    // --- add one of every type through the real buttons ----------------------
    const typeButton = (type) => panel.querySelector(`.dice-type-button[data-die="${type}"]`);

    dice.clearAllDice();
    for (const t of ['d4', 'd6', 'd8', 'd10', 'd12', 'd20']) typeButton(t)?.click();
    await wait(400);
    record('six dice added via panel', dice.diceArray.length === 6, `count=${dice.diceArray.length}`);
    record('one blob per die', dice.blobShadows.length === dice.diceArray.length,
        `${dice.blobShadows.length} blobs / ${dice.diceArray.length} dice`);
    record(
        'count display updated',
        /6\/50/.test(panel.querySelector('.dice-count-display').textContent),
        panel.querySelector('.dice-count-display').textContent
    );

    // --- roll ---------------------------------------------------------------
    const rollPromise = dice.roll();
    record('physics running during roll', dice.animationId !== null);

    // Pump the physics to a standstill, then let the settle monitor — which
    // runs on setTimeout, not on frames — catch up in wall-clock time.
    const settledAfter = await pump(1200);
    record('all dice fall asleep', settledAfter !== null, `after ${settledAfter} frames`);

    const result = await Promise.race([rollPromise, wait(12000).then(() => null)]);
    const caught = dice.diceStates.filter((s) => s.isCaught).length;
    // A roll deliberately does not resolve while any die is "caught" — it waits
    // for a reroll. That is the feature working, not a failure.
    record(
        'roll resolves, or reports caught dice',
        (typeof result === 'string' && result.includes('=')) || caught > 0,
        result === null ? `unresolved, ${caught} caught` : String(result)
    );

    // --- the whole point: does the loop stop on its own? ---------------------
    const states = dice.diceBodyArray.map((b) => b.sleepState);
    record('all dice asleep', states.every((s) => s === 2), states.join(','));

    dice.wake();                                   // as any mutation would
    const armed = dice.animationId !== null;
    dice.lastFrameTime = performance.now() - 1000 / 60;
    dice.animate();                                // one frame, nothing moving
    record('render loop stops itself', armed && dice.animationId === null);

    // --- blob shadows --------------------------------------------------------
    await pump(2);

    // The shadow map is gone entirely, not merely switched off: a depth pass is
    // a second render of the scene, and nothing here needs one any more.
    record('no shadow map pass', dice.renderer.shadowMap.enabled === false);
    record('no shadow-casting light', dice.shadowLight == null && dice.shadowCatcher == null);

    record('blobs sit on the contact plane',
        dice.blobShadows.every((b) => Math.abs(b.position.y - dice.shadowPlaneY) < 1e-6));

    // The blob leans away from the configured light by a fixed fraction of its
    // own radius. Fixed is the point: it cannot drift out of agreement with the
    // light the way a projected shadow's elevation did.
    const lightX = plugin.settings.directionalLightPositionX;
    const lightZ = plugin.settings.directionalLightPositionZ;
    const horizontal = Math.hypot(lightX, lightZ);
    const leans = dice.blobShadows.map((b, i) => {
        const dx = b.position.x - dice.diceArray[i].position.x;
        const dz = b.position.z - dice.diceArray[i].position.z;
        const len = Math.hypot(dx, dz);
        return {
            len,
            // 1 when the lean points exactly away from the light.
            alignment: len < 1e-9 || horizontal < 1e-3
                ? 0
                : -(dx * lightX + dz * lightZ) / (horizontal * len),
            fraction: len / b.scale.x
        };
    });
    record('blobs lean away from the light',
        horizontal < 1e-3
            ? leans.every((l) => l.len < 1e-9)
            : leans.every((l) => l.alignment > 0.999),
        `alignment=${leans.map((l) => l.alignment.toFixed(3)).join(',')}`);
    // Not "the same fraction of its blob" any more: a silhouette blob's scale
    // is 1, because its size lives in its vertices. The invariant that still
    // means something is that the lean stays slight next to the die itself.
    const outlineRadius = (i) => {
        const die = dice.diceArray[i];
        const p = die.geometry.attributes.position;
        const v = new die.position.constructor();
        let max = 0;
        for (let k = 0; k < p.count; k++) {
            v.fromBufferAttribute(p, k).applyQuaternion(die.quaternion);
            max = Math.max(max, Math.hypot(v.x, v.z));
        }
        return max;
    };
    record('the lean stays slight',
        leans.every((l, i) => l.len > 0 && l.len < outlineRadius(i) * 0.2),
        leans.map((l, i) => `${dice.diceTypeArray[i]}:${(l.len / outlineRadius(i)).toFixed(3)}`).join(' '));

    // A d6 is BoxGeometry(size*2), so its footprint is far wider than a d20's.
    // One blob size for every type is exactly the thing that looks wrong.
    // How far the blob actually reaches on screen.
    const blobExtent = (i) => dice.blobShadows[i].scale.x / 2;
    const extentOf = (type) => {
        const i = dice.diceTypeArray.indexOf(type);
        return i === -1 ? null : blobExtent(i);
    };
    // Every die's shadow is proportional to that die: the per-type radius is
    // what does it, so the ratio is the thing to assert rather than an ordering
    // between types.
    record('every blob is proportional to its own die',
        dice.blobShadows.every((b, i) => {
            const ratio = blobExtent(i) / outlineRadius(i);
            return ratio > 0.4 && ratio < 1.4;
        }),
        ['d4', 'd6', 'd8', 'd10', 'd12', 'd20']
            .map((t) => `${t}=${(extentOf(t) ?? 0).toFixed(2)}`).join(' '));

    // Tight is the brief: a blob much wider than its die reads as fog. The quad
    // is wider than the disc it carries, so the bound is on the quad.
    record('blobs stay tight to the die',
        dice.blobShadows.every((b, i) => blobExtent(i) <= outlineRadius(i) * 1.4),
        dice.blobShadows.map((b, i) =>
            `${dice.diceTypeArray[i]}:${(blobExtent(i) / outlineRadius(i)).toFixed(2)}`).join(' '));

    // --- a settings change must reach the screen ------------------------------
    const beforeBodies = dice.world.bodies.length;
    for (let i = 0; i < 20; i++) {
        plugin.settings.ambientLightIntensity = 0.6 + (i % 5) * 0.1;
        dice.updateSettings(plugin.settings);
    }
    record('tray not accumulating', dice.world.bodies.length === beforeBodies,
        `${beforeBodies} -> ${dice.world.bodies.length}`);
    record('settings change wakes the loop', dice.animationId !== null);

    // --- shadows can be turned off ------------------------------------------
    plugin.settings.enableShadows = false;
    dice.updateSettings(plugin.settings);
    // updateSettings only marks the scene dirty; a frame has to run for the
    // blobs to be hidden, and rAF is throttled when Obsidian is not focused.
    await pump(2);
    record('shadows respect the toggle', dice.blobShadows.length === 0);

    plugin.settings.enableShadows = true;
    dice.updateSettings(plugin.settings);
    await pump(2);
    record('shadows come back when re-enabled',
        dice.blobShadows.length === dice.diceArray.length);

    // A blob outliving its die is a leak that draws.
    const diceBeforeRemove = dice.diceArray.length;
    dice.removeSingleDice('d8');
    await pump(2);
    record('a removed die takes its blob with it',
        dice.diceArray.length === diceBeforeRemove - 1 &&
        dice.blobShadows.length === dice.diceArray.length,
        `${dice.blobShadows.length} blobs / ${dice.diceArray.length} dice`);

    // --- clickthrough -------------------------------------------------------
    //
    // The canvas covers the whole note, so it must not swallow clicks. There is
    // no mode for this any more: pointer-events is flipped per mouse move, off
    // everywhere except over a die. pointer-events cannot be per-pixel, but it
    // can be per-move, and a move always precedes the click.
    const canvasEl = dice.renderer.domElement;
    const atDie = (i) => {
        const r = dice.renderer.domElement.getBoundingClientRect();
        const v = dice.diceArray[i].position.clone().project(dice.camera);
        return {
            x: r.left + (v.x * 0.5 + 0.5) * r.width,
            y: r.top + (-v.y * 0.5 + 0.5) * r.height
        };
    };
    const moveTo = (x, y) => document.dispatchEvent(
        new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));

    const canvasRect = canvasEl.getBoundingClientRect();
    const empty = { x: canvasRect.left + 4, y: canvasRect.top + 4 };
    moveTo(empty.x, empty.y);
    record('clicks pass through where there is no die',
        canvasEl.style.pointerEvents === 'none', canvasEl.style.pointerEvents);

    const over = atDie(0);
    moveTo(over.x, over.y);
    record('the canvas takes the click over a die',
        canvasEl.style.pointerEvents === 'auto', canvasEl.style.pointerEvents);

    moveTo(empty.x, empty.y);
    record('and lets go again when the pointer leaves',
        canvasEl.style.pointerEvents === 'none', canvasEl.style.pointerEvents);

    // No mode means no button and no command to get out of step with it.
    record('the clickthrough button is gone',
        !panel.querySelector('.dice-clickthrough-button'));
    record('the clickthrough command is gone',
        !app.commands.listCommands().some((c) => c.id === 'atlas-physical-dice:toggle-dice-clickthrough'));

    // A held die must reach the tray walls. The drag used to clamp to a
    // hardcoded +/-9 by +/-6 while the tray is sized from the camera, so on a
    // maximised window less than half the width could be reached and the die
    // stopped dead in open space.
    const reach = (ndcX, ndcY) => {
        dice.isDragging = true;
        dice.draggedDiceIndex = 0;
        dice.mouse.x = ndcX;
        dice.mouse.y = ndcY;
        dice.applyDragPosition();
        dice.isDragging = false;
        dice.draggedDiceIndex = -1;
        const b = dice.diceBodyArray[0];
        return { x: b.position.x, z: b.position.z };
    };
    const halfW = (dice.camera.right - dice.camera.left) / 2;
    const halfL = (dice.camera.top - dice.camera.bottom) / 2;
    // Per-die size belongs to the pack now, not the settings.
    const dieSize = plugin.settings.diceSize *
        (dice.pack?.dice?.[dice.diceTypeArray[0]]?.scale ?? 1);
    const corner = reach(1, -1);
    record('a held die reaches the tray wall',
        halfW - Math.abs(corner.x) <= dieSize * 1.5 &&
        halfL - Math.abs(corner.z) <= dieSize * 1.5,
        `reached ${corner.x.toFixed(1)},${corner.z.toFixed(1)} of ${halfW.toFixed(1)},${halfL.toFixed(1)}`);
    record('a held die stays inside the tray wall',
        Math.abs(corner.x) <= halfW && Math.abs(corner.z) <= halfL);

    // --- hit testing --------------------------------------------------------
    const rect = dice.renderer.domElement.getBoundingClientRect();
    const target = dice.diceArray[0];
    const v = target.position.clone().project(dice.camera);
    const sx = rect.left + (v.x * 0.5 + 0.5) * rect.width;
    const sy = rect.top + (-v.y * 0.5 + 0.5) * rect.height;
    record('centre of a die hit-tests', dice.pickDiceIndex(sx, sy) === 0, `idx=${dice.pickDiceIndex(sx, sy)}`);
    record('empty tray misses', dice.pickDiceIndex(rect.left + 5, rect.top + 5) === -1);

    // --- reroll path --------------------------------------------------------
    // Returns true only when there was something to reroll, and must never throw.
    const caughtNow = dice.diceStates.filter((st) => st.isCaught && !st.isComplete).length;
    let rerollReturned;
    let rerollThrew = false;
    try { rerollReturned = dice.rerollCaughtDice(); } catch (e) { rerollThrew = true; }
    record(
        'rerollCaughtDice matches the caught count',
        !rerollThrew && rerollReturned === caughtNow > 0,
        `caught=${caughtNow} returned=${rerollReturned}`
    );

    // --- art the right way round ---------------------------------------------
    //
    // Every face of every type, posed at the camera: walk its corners and check
    // the walk turns the same way on screen as the same walk turns in the image.
    // Disagreeing means the digit is drawn back to front.
    //
    // Worth its own check because nothing else catches it. Comparing faces with
    // each other only says they are all wrong the same way, a mirrored polygon
    // has exactly the edge lengths of an unmirrored one, and posing a face and
    // looking at it needs someone to notice that a 2 is the wrong way round.
    // The whole atlas shipped mirrored for a while on the strength of that.
    {
        const V = dice.camera.position.constructor;
        const M = dice.camera.matrixWorld.constructor;
        const backwards = [];
        for (const type of ['d4', 'd6', 'd8', 'd10', 'd100', 'd12', 'd20']) {
            dice.clearAllDice();
            dice.createSingleDice(type);
            const mesh = dice.diceArray[0];
            const g = mesh.geometry, pos = g.attributes.position, uv = g.attributes.uv;
            const faces = dice.getFaceCountForDiceType(type);
            const per = g.userData.faceVertexCount || pos.count / faces;
            const normals = dice.getFaceNormalsForDiceType(type);
            let wrong = 0;

            for (let f = 0; f < faces; f++) {
                const yAxis = normals[f].clone().normalize();
                const seed = Math.abs(yAxis.y) > 0.9 ? new V(1, 0, 0) : new V(0, 1, 0);
                const zAxis = seed.clone().sub(yAxis.clone().multiplyScalar(seed.dot(yAxis))).normalize();
                const xAxis = new V().crossVectors(yAxis, zAxis).normalize();
                const from = new M().makeBasis(xAxis, yAxis, zAxis);
                const to = new M().makeBasis(new V(-1, 0, 0), new V(0, 1, 0), new V(0, 0, -1));
                mesh.quaternion.setFromRotationMatrix(to.multiply(from.invert()));
                mesh.position.set(0, 0, 0);
                mesh.updateMatrixWorld(true);

                const P = [], U = [];
                for (let v = 0; v < per; v++) {
                    const world = new V().fromBufferAttribute(pos, f * per + v).applyMatrix4(mesh.matrixWorld);
                    if (P.some((r) => r.distanceToSquared(world) < 1e-8)) continue;
                    P.push(world);
                    U.push([uv.getX(f * per + v), uv.getY(f * per + v)]);
                }

                // Round the face, not in buffer order: a signed area only means
                // something if the polygon is walked along its edge.
                const order = P.map((world, i) => {
                    const n = world.clone().project(dice.camera);
                    return { i, a: Math.atan2(-n.y, n.x) };
                }).sort((x, y) => x.a - y.a).map((e) => e.i);

                const area = (pts) => {
                    let sum = 0;
                    for (let i = 0; i < pts.length; i++) {
                        const a = pts[i], b = pts[(i + 1) % pts.length];
                        sum += a[0] * b[1] - b[0] * a[1];
                    }
                    return sum;
                };
                const screen = order.map((i) => {
                    const n = P[i].clone().project(dice.camera);
                    return [n.x, -n.y];
                });
                const image = order.map((i) => [U[i][0], 1 - U[i][1]]);
                if (Math.sign(area(screen)) !== Math.sign(area(image))) wrong++;
            }
            if (wrong) backwards.push(`${type} ${wrong}/${faces}`);
        }
        dice.clearAllDice();
        record('no face is mirrored', backwards.length === 0, backwards.join(' '));
    }

    // --- close and reopen (leak check) ---------------------------------------
    const canvasesBefore = document.querySelectorAll('canvas').length;
    app.commands.executeCommandById('atlas-physical-dice:toggle-dice-roller');
    await wait(400);
    record('overlay closes', plugin.isVisible === false);
    record('overlay removed from dom', document.querySelectorAll('.dice-floating-overlay').length === 0);

    app.commands.executeCommandById('atlas-physical-dice:toggle-dice-roller');
    await wait(600);
    app.commands.executeCommandById('atlas-physical-dice:toggle-dice-roller');
    await wait(400);
    record('canvases not accumulating', document.querySelectorAll('canvas').length <= canvasesBefore,
        `${canvasesBefore} -> ${document.querySelectorAll('canvas').length}`);
} finally {
    console.error = origError;
    console.warn = origWarn;
    window.removeEventListener('error', onErr);
    window.removeEventListener('unhandledrejection', onErr);
}

return {
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    failures: results.filter((r) => !r.ok),
    all: results.map((r) => `${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`),
    consoleNoise: errors.slice(0, 15)
};
