/*
 * Read a pack sheet's net: where every cell is, and what its corners are.
 *
 *   node harness/obsidian-cdp.mjs eval "window.__type='d20'; window.__sides=3; return 1"
 *   node harness/obsidian-cdp.mjs eval-file harness/scripts/net.js
 *
 * Fitting a net by arithmetic does not survive contact with the art. The d6 is
 * a grid and the d8 is a clean zigzag, but the d20 sheet is neither: scanlines
 * through it show vertical rules that no strip of equilateral triangles
 * explains, and a row height that divides 1024 into five while the strip's own
 * width says otherwise.
 *
 * So read it instead. Cell interiors are a flat wash, the digits sit inside
 * them, and every cell is fenced off by a drawn border, which makes each cell
 * exactly one connected region. Flood them, hull them, and reduce each hull to
 * the corner count the shape actually has - triangles for a d4/d8/d20,
 * pentagons for a d12.
 */

const p = app.plugins.plugins["atlas-physical-dice"];
if (!p.isVisible) {
    app.commands.executeCommandById('atlas-physical-dice:toggle-dice-roller');
    await new Promise((r) => setTimeout(r, 900));
}

const type = window.__type || 'd20';
const sides = window.__sides || 3;
const minArea = window.__minArea || 2000;

const url = p.dice.packTextures[type];
if (!url) throw new Error(`no sheet for ${type}`);
const img = new Image();
img.crossOrigin = 'anonymous';
await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });

const canvas = document.createElement('canvas');
canvas.width = img.width;
canvas.height = img.height;
const ctx = canvas.getContext('2d', { willReadFrequently: true });
ctx.drawImage(img, 0, 0);
const W = img.width, H = img.height;
const px = ctx.getImageData(0, 0, W, H).data;

// Inside a cell: painted, and lighter than the border drawn around it. The
// digits are white and pass too, which is what we want - they are part of the
// cell, and a hole where a digit sits would break the fill.
//
// The cut cannot be a fixed number. Sheets in the same pack do not agree on how
// dark the wash is - 88 on the d6, 52 on the d10 - and a threshold picked for
// one leaves the other's cells looking like background, which comes back as a
// handful of tiny regions where the digits are. So take the wash to be whatever
// value covers most of the painted area and keep everything at least that
// light; borders are drawn at 0 and fall away on their own.
const painted = new Uint32Array(256);
for (let i = 0; i < W * H; i++) {
    if (px[i * 4 + 3] > 8) painted[px[i * 4]]++;
}
let wash = 0;
for (let v = 1; v < 256; v++) if (painted[v] > painted[wash]) wash = v;

const inside = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) {
    inside[i] = px[i * 4 + 3] > 8 && px[i * 4] >= wash - 8 ? 1 : 0;
}

const label = new Int32Array(W * H).fill(-1);
const cells = [];
const stack = new Int32Array(W * H);

for (let seed = 0; seed < W * H; seed++) {
    if (!inside[seed] || label[seed] >= 0) continue;

    const id = cells.length;
    let top = 0;
    stack[top++] = seed;
    label[seed] = id;
    const points = [];

    while (top > 0) {
        const at = stack[--top];
        const x = at % W, y = (at - x) / W;
        points.push(at);

        if (x > 0 && inside[at - 1] && label[at - 1] < 0) { label[at - 1] = id; stack[top++] = at - 1; }
        if (x < W - 1 && inside[at + 1] && label[at + 1] < 0) { label[at + 1] = id; stack[top++] = at + 1; }
        if (y > 0 && inside[at - W] && label[at - W] < 0) { label[at - W] = id; stack[top++] = at - W; }
        if (y < H - 1 && inside[at + W] && label[at + W] < 0) { label[at + W] = id; stack[top++] = at + W; }
    }

    if (points.length < minArea) continue;
    cells.push(points);
}

/** Andrew's monotone chain, on the region's boundary points. */
function hull(points) {
    const pts = points.map((at) => {
        const x = at % W;
        return [x, (at - x) / W];
    }).sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    const cross = (o, a, b) =>
        (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

    const half = (list) => {
        const out = [];
        for (const pt of list) {
            while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], pt) <= 0) out.pop();
            out.push(pt);
        }
        return out;
    };

    const lower = half(pts);
    const upper = half(pts.slice().reverse());
    return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * Drop hull vertices until only the shape's real corners are left, always
 * giving up the one that costs the least area. A drawn edge is never perfectly
 * straight, so a hull of a triangle still arrives with dozens of points along
 * each side; those are exactly the cheap ones.
 */
function reduce(poly, want) {
    const work = poly.slice();
    const area = (a, b, c) =>
        Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;

    while (work.length > want) {
        let bestAt = 0, bestCost = Infinity;
        for (let i = 0; i < work.length; i++) {
            const cost = area(
                work[(i - 1 + work.length) % work.length],
                work[i],
                work[(i + 1) % work.length]
            );
            if (cost < bestCost) { bestCost = cost; bestAt = i; }
        }
        work.splice(bestAt, 1);
    }
    return work;
}

const out = cells.map((points) => {
    let sx = 0, sy = 0;
    for (const at of points) {
        const x = at % W;
        sx += x;
        sy += (at - x) / W;
    }
    const corners = reduce(hull(points), sides).map(([x, y]) => [x, y]);
    return {
        centre: [Math.round(sx / points.length), Math.round(sy / points.length)],
        area: points.length,
        corners
    };
});

// Reading order, so the list lines up with the sheet as it looks.
out.sort((a, b) => a.centre[1] - b.centre[1] || a.centre[0] - b.centre[0]);
return { type, size: [W, H], count: out.length, cells: out };
