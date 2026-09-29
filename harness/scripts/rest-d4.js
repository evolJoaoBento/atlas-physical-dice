/* Rest a d4 on one face, so the corner you are meant to read points up. */
const p = app.plugins.plugins["atlas-physical-dice"];
if (!p.isVisible) { app.commands.executeCommandById('atlas-physical-dice:toggle-dice-roller'); await new Promise(r => setTimeout(r, 900)); }
const d = p.dice;
const faceIdx = window.__face ?? 0;

const savedSize = p.settings.diceSize;
try {
    p.settings.diceSize = 3.0;
    d.clearAllDice();
    d.createSingleDice('d4');

    const V = d.camera.position.constructor;
    const Q = d.diceArray[0].quaternion.constructor;
    const M = d.camera.matrixWorld.constructor;
    const normals = d.getFaceNormalsForDiceType('d4');
    const mesh = d.diceArray[0], body = d.diceBodyArray[0];

    // Face down, not up: a d4 has no top face and is read at its apex.
    const yAxis = normals[faceIdx].clone().normalize().negate();
    const seed = Math.abs(yAxis.y) > 0.9 ? new V(1, 0, 0) : new V(0, 1, 0);
    const zAxis = seed.clone().sub(yAxis.clone().multiplyScalar(seed.dot(yAxis))).normalize();
    const xAxis = new V().crossVectors(yAxis, zAxis).normalize();
    const from = new M().makeBasis(xAxis, yAxis, zAxis);
    const to = new M().makeBasis(new V(-1, 0, 0), new V(0, 1, 0), new V(0, 0, -1));
    const q = new Q().setFromRotationMatrix(to.multiply(from.invert()));
    body.quaternion.set(q.x, q.y, q.z, q.w);
    body.position.set(0, -1.0, 0);
    body.velocity.set(0, 0, 0); body.angularVelocity.set(0, 0, 0); body.sleep();
    d.renderFrame(true);

    const rect = d.renderer.domElement.getBoundingClientRect();
    const v = mesh.position.clone().project(d.camera);
    return {
        reported: d.checkDiceResult(0).result,
        centre: [
            Math.round(rect.left + (v.x * 0.5 + 0.5) * rect.width),
            Math.round(rect.top + (-v.y * 0.5 + 0.5) * rect.height)
        ]
    };
} finally {
    p.settings.diceSize = savedSize;
}
