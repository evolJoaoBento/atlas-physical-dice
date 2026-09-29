/*
 * Draw a cell table back over the sheet it claims to describe.
 *
 *   node harness/obsidian-cdp.mjs eval "window.__type='d20'; window.__table=[...]; return 1"
 *   node harness/obsidian-cdp.mjs eval-file harness/scripts/overlay.js > out.b64
 *
 * Returns a data URL; decode it to a PNG and look. This is the cheap check that
 * a table is right, and it beats reading digits off a rendered die: a posed d20
 * face is small, its neighbours crowd it, and a digit drawn rotated in the net
 * reads as a different digit entirely - a 2 turned upside down was called a 5
 * here, and only the overlay settled it. Outlines that land on the drawn
 * borders say the corners are right; labels that land on the matching digits
 * say the numbers are.
 */

const p = app.plugins.plugins["atlas-physical-dice"];
const type = window.__type;
const table = window.__table;   // [{number, corners}]
const url = p.dice.packTextures[type];
const img = new Image();
img.crossOrigin = 'anonymous';
await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
const c = document.createElement('canvas');
c.width = img.width; c.height = img.height;
const g = c.getContext('2d');
g.fillStyle = '#333'; g.fillRect(0, 0, c.width, c.height);
g.drawImage(img, 0, 0);
for (const cell of table) {
    g.beginPath();
    g.moveTo(cell.corners[0][0], cell.corners[0][1]);
    for (let i = 1; i < cell.corners.length; i++) g.lineTo(cell.corners[i][0], cell.corners[i][1]);
    g.closePath();
    g.strokeStyle = '#00e5ff'; g.lineWidth = 3; g.stroke();
    let cx = 0, cy = 0;
    for (const [x, y] of cell.corners) { cx += x; cy += y; }
    cx /= cell.corners.length; cy /= cell.corners.length;
    g.fillStyle = '#ff2d95';
    g.font = 'bold 44px sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(cell.number), cx, cy);
    if (cell.vertices) {
        // Corner-read art: label every corner, because that is where the
        // numbers actually live and the centre says nothing.
        g.font = 'bold 34px sans-serif';
        cell.corners.forEach(([x, y], i) => {
            const toward = 0.72;
            g.fillStyle = '#ffe600';
            g.fillText(String(cell.vertices[i]), x + (cx - x) * (1 - toward), y + (cy - y) * (1 - toward));
        });
    } else {
        // Mark corner 0, so a rotation can be read as well as a number.
        g.fillStyle = '#ffe600';
        g.beginPath(); g.arc(cell.corners[0][0], cell.corners[0][1], 9, 0, 7); g.fill();
    }
}
return c.toDataURL('image/png');
