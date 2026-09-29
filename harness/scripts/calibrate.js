/*
 * Pin down what a cell's `rotation` actually does, without guessing from art.
 *
 *   node harness/obsidian-cdp.mjs eval "window.__type='d6'; return 1"
 *   node harness/obsidian-cdp.mjs eval-file harness/scripts/calibrate.js
 *
 * Paints a stand-in atlas over the real one: every cell gets its own number and
 * a big arrow pointing up *in sheet space*. Pose a face and the arrow says
 * exactly how that cell landed on the die - which a digit cannot, because a
 * rotated 5 and an upright one look alike at any size a whole die fits in.
 *
 * Read the arrows, set each cell's rotation to whatever brings its arrow
 * upright, and the art follows: the sheet and the stand-in are laid out by the
 * same code.
 */

const p = app.plugins.plugins["atlas-physical-dice"];
if (!p.isVisible) { app.commands.executeCommandById('atlas-physical-dice:toggle-dice-roller'); await new Promise(r => setTimeout(r, 900)); }
const d = p.dice;

// Poses faces upward, which is what every type wants except the d4: that one is
// read at the corner its resting face leaves out, so posing a face up reports
// the opposite face. Use harness/scripts/rest-d4.js for it.
const type = window.__type || 'd6';
const grid = window.__grid || { cols: 4, rows: 4 };
const faces = d.getFaceCountForDiceType(type);

// --- the stand-in sheet ------------------------------------------------------
const SIZE = 1024;
const canvas = document.createElement('canvas');
canvas.width = canvas.height = SIZE;
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#2b2b2b';
ctx.fillRect(0, 0, SIZE, SIZE);

const cellW = SIZE / grid.cols;
const cellH = SIZE / grid.rows;
for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
        const x = col * cellW;
        const y = row * cellH;
        const n = row * grid.cols + col;

        ctx.fillStyle = (col + row) % 2 ? '#f0f0f0' : '#d0d0d0';
        ctx.fillRect(x + 2, y + 2, cellW - 4, cellH - 4);

        // Arrow pointing up in sheet space.
        ctx.fillStyle = '#c0392b';
        ctx.beginPath();
        ctx.moveTo(x + cellW / 2, y + cellH * 0.18);
        ctx.lineTo(x + cellW * 0.72, y + cellH * 0.5);
        ctx.lineTo(x + cellW * 0.58, y + cellH * 0.5);
        ctx.lineTo(x + cellW * 0.58, y + cellH * 0.84);
        ctx.lineTo(x + cellW * 0.42, y + cellH * 0.84);
        ctx.lineTo(x + cellW * 0.42, y + cellH * 0.5);
        ctx.lineTo(x + cellW * 0.28, y + cellH * 0.5);
        ctx.closePath();
        ctx.fill();

        // Cell index, so a face can be traced back to where it came from.
        ctx.fillStyle = '#2c3e50';
        ctx.font = `bold ${Math.floor(cellH * 0.16)}px sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(`r${row}c${col}`, x + 10, y + 8);
    }
}

// --- pose every face, wearing the stand-in ----------------------------------
const savedSize = p.settings.diceSize;
p.settings.diceSize = window.__poseSize || 1.9;

d.clearAllDice();
for (let i = 0; i < faces; i++) d.createSingleDice(type);

// Reuse whatever texture class the dice already wear, so this needs no import.
const existing = d.diceArray[0].material.map;
const debugTexture = existing ? new existing.constructor(canvas) : null;
if (!debugTexture) throw new Error('no texture on the dice to clone a class from');
debugTexture.colorSpace = existing.colorSpace;
debugTexture.flipY = existing.flipY;
debugTexture.needsUpdate = true;

const V = d.camera.position.constructor;
const Q = d.diceArray[0].quaternion.constructor;
const M = d.camera.matrixWorld.constructor;
const normals = d.getFaceNormalsForDiceType(type);

const reported = [];
for (let i = 0; i < faces; i++) {
    const mesh = d.diceArray[i];
    const body = d.diceBodyArray[i];
    // window.__real keeps the pack's own art, for checking digits once the
    // arrows have settled the rotations.
    if (!window.__real) {
        mesh.material.map = debugTexture;
        mesh.material.needsUpdate = true;
    }

    // Reference direction must come from the geometry, never from the UVs.
    //
    // Deriving it from the UVs is self-cancelling: rotate a cell and the
    // reference rotates with it, so the die turns to compensate and the arrow
    // comes out upright whatever the rotation is. That hid the setting
    // completely - two different values rendered identically.
    const pos = mesh.geometry.attributes.position;
    // A chamfered die keeps its rim vertices after the numbered faces, so the
    // buffer no longer divides evenly into them. Dividing anyway walks off the
    // face and reads an edge that is not on it: the pose still lands the right
    // face up, because the normals are hardcoded, but its spin is nonsense and
    // a degenerate edge takes the quaternion to NaN.
    const vpf = mesh.geometry.userData.faceVertexCount || pos.count / faces;
    const base = i * vpf;
    const a = new V().fromBufferAttribute(pos, base);
    const b = new V().fromBufferAttribute(pos, base + 1);
    const edge = b.clone().sub(a);
    const upLocal = edge.lengthSq() < 1e-12 ? new V(0, 1, 0) : edge.normalize();

    const yAxis = normals[i].clone().normalize();
    const zAxis = upLocal.clone().sub(yAxis.clone().multiplyScalar(upLocal.dot(yAxis)));
    if (zAxis.lengthSq() < 1e-9) zAxis.set(0, 0, 1);
    zAxis.normalize();
    const xAxis = new V().crossVectors(yAxis, zAxis).normalize();

    const from = new M().makeBasis(xAxis, yAxis, zAxis);
    const to = new M().makeBasis(new V(-1, 0, 0), new V(0, 1, 0), new V(0, 0, -1));
    const q = new Q().setFromRotationMatrix(to.multiply(from.invert()));
    body.quaternion.set(q.x, q.y, q.z, q.w);

    const perRow = 5;
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    body.position.set(-8 + col * 4, -1.0, -4 + row * 4);
    body.velocity.set(0, 0, 0);
    body.angularVelocity.set(0, 0, 0);
    body.sleep();
}
d.renderFrame(true);
for (let i = 0; i < faces; i++) reported.push(d.checkDiceResult(i).result);

p.settings.diceSize = savedSize;

const rect = d.renderer.domElement.getBoundingClientRect();
const screen = d.diceArray.map((m) => {
    const v = m.position.clone().project(d.camera);
    return [
        Math.round(rect.left + (v.x * 0.5 + 0.5) * rect.width),
        Math.round(rect.top + (-v.y * 0.5 + 0.5) * rect.height)
    ];
});
return { type, faces, reported, screen };
