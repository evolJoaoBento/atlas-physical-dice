import type { AtlasQuad, DicePack, PackDie } from './d20-dice';

/**
 * Where each face of a pack's net lies, for Atlas dice looks.
 *
 * This file is geometry only - no canvas, no Obsidian - so it can be checked on
 * its own. `atlas-looks.ts` does the cutting. A "cut" says which part of a
 * sheet is one face value's art and how it goes onto Atlas's die.
 */

/** The die types Atlas asks a look for (`DiceLookDie`): 100 is the d100's tens die. */
export type LookDie = 4 | 6 | 8 | 10 | 12 | 20 | 100;

export const LOOK_DICE: LookDie[] = [4, 6, 8, 10, 12, 20, 100];

export type Point = [number, number];

/** One face value's digit, as a region of its sheet in sheet pixels (Atlas before API 1.18). */
export interface FaceCut {
    /** Atlas's face value (`DiceLookSpec.faces` key). */
    value: number;
    /** The face's outline. Pixels outside it are never part of the art. */
    polygon: Point[];
    /** Which way the digit's top points on the sheet: degrees clockwise from the top of the image. */
    up: number;
    /** A d4 face carries three digits; this keeps the one by a single corner. */
    window?: { x: number; y: number; r: number };
}

/** Canvas `setTransform(a, b, c, d, e, f)`: sheet pixels to the pixels of Atlas's face cell. */
export interface CellTransform {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
}

/** One face value's whole face (API 1.18 `fill: 'face'`): the face's outline on the sheet and where it goes in Atlas's cell. */
export interface WholeFaceCut {
    value: number;
    /** The face's outline on its sheet, in sheet pixels. */
    polygon: Point[];
    /** Sheet pixels to cell pixels, so the face lands on Atlas's outline of it. */
    transform: CellTransform;
    /**
     * True when the face was fitted corner to corner onto Atlas's outline. False when the
     * pack's digit stands at an angle Atlas's face shape does not allow: the face is then
     * only turned upright and scaled, and the cell round it is filled with its background.
     */
    fitted: boolean;
    /** How far the fitted face is turned off the pack's `up`, in degrees: the digit's tilt on Atlas's die. */
    tilt: number;
    /**
     * Only for a d4 whose numbers go round its corners the other way to Atlas's (the
     * two ways to number a d4 are mirror images). Its face cannot be laid on Atlas's
     * whole, so `transform` lays only its background there, and each number is cut
     * out round its corner (`window`, sheet pixels) and laid at Atlas's corner of
     * that number by its own transform.
     */
    corners?: Array<{ window: { x: number; y: number; r: number }; transform: CellTransform }>;
}

/** The pack key a look die is drawn from: `d20`, and the tens die is the pack's `d100`. */
export function packTypeOf(sides: LookDie): string {
    return `d${sides}`;
}

/** Where along a d4 face's corner-to-centre line its digit sits, and how far around it reaches. */
const CORNER_DIGIT_AT = 0.3;
const CORNER_DIGIT_REACH = 0.3;

function centroid(points: Point[]): Point {
    let x = 0;
    let y = 0;
    for (const p of points) { x += p[0]; y += p[1]; }
    return [x / points.length, y / points.length];
}

function scaled(points: Point[], by: number): Point[] {
    return points.map((p): Point => [p[0] * by, p[1] * by]);
}

function finite(n: unknown): n is number {
    return typeof n === 'number' && isFinite(n);
}

/**
 * The cell of a net that holds Atlas's face `value`.
 *
 * A d10 counts from 0, and the face Atlas calls 10 is the one printed "0" - a
 * pack that does print "10" is used as it is.
 */
function wanted<T extends { number: number }>(cells: T[], sides: LookDie, value: number): T | undefined {
    const exact = cells.filter((c) => c.number === value)[0];
    if (exact || sides !== 10 || value !== 10) return exact;
    return cells.filter((c) => c.number === 0)[0];
}

/** A cube cross's square cell, in sheet pixels. */
function cellPolygon(cell: AtlasQuad, grid: { cols: number; rows: number }, width: number, height: number): Point[] {
    const w = width / grid.cols;
    const h = height / grid.rows;
    const x = cell.col * w;
    const y = cell.row * h;
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}

/**
 * Which way up a cube-cross cell's digit is drawn when the pack does not say.
 * The pack format has always laid the d6 out with the cross's flaps rotated
 * three quarter turns (digit upright) or one (upside down); anything else is
 * not known, so that face keeps Atlas's numeral.
 */
function quadUp(cell: AtlasQuad): number | null {
    if (finite(cell.up)) return cell.up;
    if (cell.rotation === 3) return 0;
    if (cell.rotation === 1) return 180;
    return null;
}

/** The face values Atlas asks for, for one die type. */
function valuesOf(sides: LookDie): number[] {
    const values: number[] = [];
    if (sides === 100) for (let v = 0; v < 100; v += 10) values.push(v);
    else for (let v = 1; v <= sides; v++) values.push(v);
    return values;
}

/**
 * The cuts for one die type of a pack, for every face value Atlas asks for
 * that the pack can answer. `width`/`height` are the sheet's real size in
 * pixels; a pack's face corners are given for its `sheetSize` and scaled to it.
 */
export function cutsFor(sides: LookDie, pack: DicePack, width: number, height: number): FaceCut[] {
    const die: PackDie | undefined = pack.dice?.[packTypeOf(sides)];
    if (!die) return [];

    const values = valuesOf(sides);
    const cuts: FaceCut[] = [];

    if (die.grid) {
        for (const value of values) {
            const cell = wanted(die.grid.cells, sides, value);
            const up = cell ? quadUp(cell) : null;
            if (!cell || up === null) continue;
            cuts.push({ value, polygon: cellPolygon(cell, die.grid, width, height), up });
        }
        return cuts;
    }

    if (!die.faces || !finite(die.sheetSize) || die.sheetSize <= 0) return [];
    const by = width / die.sheetSize;

    if (sides === 4) {
        // Every face of a d4 carries three digits, one by each corner, and a
        // digit belongs to a corner of the die: the three that meet at a corner
        // agree. `vertices` names each cell corner's die corner, so a value is
        // the digit at any cell corner naming it. Its top points at the corner.
        for (const value of values) {
            let found: FaceCut | null = null;
            for (const face of die.faces) {
                const at = face.vertices ? face.vertices.indexOf(value) : -1;
                if (at < 0 || !face.corners[at]) continue;
                const polygon = scaled(face.corners, by);
                const corner = polygon[at];
                const middle = centroid(polygon);
                const dx = corner[0] - middle[0];
                const dy = corner[1] - middle[1];
                const reach = Math.sqrt(dx * dx + dy * dy);
                if (reach === 0) continue;
                found = {
                    value,
                    polygon,
                    up: (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360,
                    window: {
                        x: corner[0] - dx * CORNER_DIGIT_AT,
                        y: corner[1] - dy * CORNER_DIGIT_AT,
                        r: reach * CORNER_DIGIT_REACH,
                    },
                };
                break;
            }
            if (found) cuts.push(found);
        }
        return cuts;
    }

    for (const value of values) {
        const face = wanted(die.faces, sides, value);
        // Where a digit's top points is drawn into the sheet and nowhere the
        // geometry can read it, so a face the pack does not say is left to Atlas.
        if (!face || !finite(face.up) || face.corners.length < 3) continue;
        cuts.push({ value, polygon: scaled(face.corners, by), up: face.up });
    }
    return cuts;
}

// ---------------------------------------------------------------------------
// Whole faces (Atlas extension API 1.18, `fill: 'face'`)
// ---------------------------------------------------------------------------

/** Side of Atlas's face cell in pixels (`CELL` in Atlas's dice3d), and the side of every whole-face image. */
export const ATLAS_CELL = 256;

/** How far a face reaches from its centre into Atlas's cell (`FACE_CELL_REACH`). */
const FACE_REACH = 0.41 * ATLAS_CELL;

/** Furthest a pack's `up` may be from the face shape's own upright before the face is not fitted. */
const FIT_TOLERANCE = 30;

/** Worst corner miss, as a share of the face's reach, for a fit to count. */
const FIT_RESIDUAL = 0.2;

function regularOutline(corners: number): Point[] {
    // Atlas stands an odd-cornered face on a corner: its first corner straight up.
    const points: Point[] = [];
    for (let i = 0; i < corners; i++) {
        const angle = Math.PI / 2 + (i * 2 * Math.PI) / corners;
        points.push([FACE_REACH * Math.cos(angle), FACE_REACH * Math.sin(angle)]);
    }
    return points;
}

/**
 * Atlas's outline of a face in its cell, in cell pixels from the centre with y up, as
 * Atlas's `faceOutline` draws it. Every face of a body has the same outline: the
 * numeral's top is up, and up is a corner (d4, d8, d12, d20), the middle of an edge
 * (d6) or the long tip of the kite (d10, and the d100's tens die).
 */
function atlasOutlineUp(sides: LookDie): Point[] {
    switch (sides) {
        case 6: {
            const h = FACE_REACH / Math.SQRT2;
            return [[h, h], [-h, h], [-h, -h], [h, -h]];
        }
        case 10:
        case 100:
            // The pentagonal trapezohedron Atlas builds (ring height 0.12).
            return [[0, 104.96], [-58.693, -24.778], [0, -55.405], [58.693, -24.778]];
        case 12:
            return regularOutline(5);
        default:
            return regularOutline(3);
    }
}

/** The same, in the pixels of a cell image: from its top left, y down. */
export function atlasOutline(sides: LookDie): Point[] {
    return atlasOutlineUp(sides).map((p): Point => [ATLAS_CELL / 2 + p[0], ATLAS_CELL / 2 - p[1]]);
}

/**
 * The numbers at the corners of Atlas's d4 faces, in `atlasOutline(4)`'s corner order
 * (top, bottom left, bottom right), by face value. Face 1 is the one without a 1 on
 * it: it lies on the table when the 1 points up.
 */
export const ATLAS_D4_CORNERS: Readonly<Record<number, readonly number[]>> = {
    1: [4, 3, 2],
    2: [3, 4, 1],
    3: [4, 2, 1],
    4: [3, 1, 2],
};

function signedArea(points: Point[]): number {
    let area = 0;
    for (let i = 0; i < points.length; i++) {
        const [x0, y0] = points[i];
        const [x1, y1] = points[(i + 1) % points.length];
        area += x0 * y1 - x1 * y0;
    }
    return area / 2;
}

/** The angle `a` brought into (-180, 180]. */
function wrapDegrees(a: number): number {
    let r = a % 360;
    if (r <= -180) r += 360;
    if (r > 180) r -= 360;
    return r;
}

interface Fit {
    transform: CellTransform;
    /** Degrees the transform turns the sheet by. */
    turn: number;
    /** Worst corner miss as a share of Atlas's face reach. */
    residual: number;
}

/**
 * The turn, scale and shift (no mirroring, no shear) that lays `from` best onto `to`,
 * corner for corner: least squares on the points as complex numbers.
 */
function similarityFit(from: Point[], to: Point[]): Fit {
    const n = from.length;
    const fc = centroid(from);
    const tc = centroid(to);
    let re = 0;
    let im = 0;
    let norm = 0;
    for (let i = 0; i < n; i++) {
        const zx = from[i][0] - fc[0];
        const zy = from[i][1] - fc[1];
        const wx = to[i][0] - tc[0];
        const wy = to[i][1] - tc[1];
        // (w) * conj(z)
        re += wx * zx + wy * zy;
        im += wy * zx - wx * zy;
        norm += zx * zx + zy * zy;
    }
    const a = norm > 0 ? re / norm : 0;
    const b = norm > 0 ? im / norm : 0;
    const e = tc[0] - (a * fc[0] - b * fc[1]);
    const f = tc[1] - (b * fc[0] + a * fc[1]);
    let worst = 0;
    for (let i = 0; i < n; i++) {
        const x = a * from[i][0] - b * from[i][1] + e;
        const y = b * from[i][0] + a * from[i][1] + f;
        worst = Math.max(worst, Math.hypot(x - to[i][0], y - to[i][1]));
    }
    return {
        transform: { a, b, c: -b, d: a, e, f },
        turn: Math.atan2(b, a) * 180 / Math.PI,
        residual: worst / FACE_REACH,
    };
}

/** Of the ways a pack face's corners can meet Atlas's, in turn and keeping the winding, the one that stands its digit nearest upright. */
function bestFit(polygon: Point[], up: number, outline: Point[]): { fit: Fit; tilt: number } | null {
    if (polygon.length !== outline.length) return null;
    // The turn that stands the digit up: its top, `up` degrees clockwise on the sheet, to straight up.
    const upright = -up;
    const ordered = Math.sign(signedArea(polygon)) === Math.sign(signedArea(outline)) ? polygon : polygon.slice().reverse();
    let best: { fit: Fit; tilt: number } | null = null;
    for (let shift = 0; shift < ordered.length; shift++) {
        const rotated = ordered.map((_, i) => ordered[(i + shift) % ordered.length]);
        const fit = similarityFit(rotated, outline);
        const tilt = wrapDegrees(fit.turn - upright);
        if (fit.residual <= FIT_RESIDUAL && (!best || Math.abs(tilt) < Math.abs(best.tilt))) best = { fit, tilt };
    }
    return best;
}

/** The face turned by its `up` alone, about its centre, at the size Atlas gives a face. */
function uprightFit(polygon: Point[], up: number): CellTransform {
    const middle = centroid(polygon);
    let reach = 0;
    for (const p of polygon) reach = Math.max(reach, Math.hypot(p[0] - middle[0], p[1] - middle[1]));
    const k = reach > 0 ? FACE_REACH / reach : 1;
    const turn = -up * Math.PI / 180;
    const a = k * Math.cos(turn);
    const b = k * Math.sin(turn);
    const centre = ATLAS_CELL / 2;
    return { a, b, c: -b, d: a, e: centre - (a * middle[0] - b * middle[1]), f: centre - (b * middle[0] + a * middle[1]) };
}

function median(values: number[]): number {
    const sorted = values.slice().sort((x, y) => x - y);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The whole faces of one die type, for every face value Atlas asks for that the pack
 * can answer. Atlas draws each one over its face cell, not turned (`fill: 'face'`), so
 * each comes with the transform that lays it on Atlas's outline of that face with the
 * pack's digit upright.
 *
 * A d4 face carries three numbers. Atlas's d4 face `v` is the one without a `v` on it,
 * so it is the pack face whose `vertices` leave `v` out, with each corner laid on the
 * corner of Atlas's that carries the same number.
 */
export function wholeFaceCutsFor(sides: LookDie, pack: DicePack, width: number, height: number): WholeFaceCut[] {
    const die: PackDie | undefined = pack.dice?.[packTypeOf(sides)];
    if (!die) return [];
    const outline = atlasOutline(sides);
    const cuts: WholeFaceCut[] = [];

    if (sides === 4) {
        if (die.grid || !die.faces || !finite(die.sheetSize) || die.sheetSize <= 0) return [];
        const by = width / die.sheetSize;
        for (const value of valuesOf(4)) {
            const corners = ATLAS_D4_CORNERS[value];
            const face = die.faces.filter((f) => f.vertices && f.vertices.length === 3 && f.corners.length === 3
                && f.vertices.indexOf(value) < 0)[0];
            if (!face || !face.vertices) continue;
            const polygon = scaled(face.corners, by);
            const targets = face.vertices.map((corner) => outline[corners.indexOf(corner)]);
            if (targets.some((t) => !t)) continue;
            const fit = similarityFit(polygon, targets);
            if (fit.residual <= FIT_RESIDUAL) {
                cuts.push({ value, polygon, transform: fit.transform, fitted: true, tilt: 0 });
                continue;
            }
            // Numbered the other way round: the background goes on as a whole, each
            // number on its own, cut round its corner as the digit-only looks are.
            const sheetMiddle = centroid(polygon);
            const cellMiddle = centroid(outline);
            const background = bestFit(polygon, 0, outline);
            if (!background) continue;
            const pasted: NonNullable<WholeFaceCut['corners']> = [];
            face.vertices.forEach((corner, i) => {
                const from = polygon[i];
                const to = outline[corners.indexOf(corner)];
                const dx = from[0] - sheetMiddle[0];
                const dy = from[1] - sheetMiddle[1];
                const reach = Math.hypot(dx, dy);
                if (!to || reach === 0) return;
                pasted.push({
                    window: { x: from[0] - dx * CORNER_DIGIT_AT, y: from[1] - dy * CORNER_DIGIT_AT, r: reach * CORNER_DIGIT_REACH },
                    transform: similarityFit([sheetMiddle, from], [cellMiddle, to]).transform,
                });
            });
            if (pasted.length === 3) cuts.push({ value, polygon, transform: background.fit.transform, fitted: false, tilt: 0, corners: pasted });
        }
        return cuts;
    }

    // A die type is laid face on face when the pack draws its digits the way Atlas
    // stands its faces (towards a corner of a triangle, the long tip of a kite): most
    // faces then fit within FIT_TOLERANCE, and the few that do not have an `up` that
    // was measured off (a 6 or 9 read by its underline), so they are fitted too. When
    // most do not - a percentile die prints its tens across the kite - the faces are
    // stood upright by `up` instead, on their own background.
    const base = cutsFor(sides, pack, width, height);
    const fits = base.map((cut) => bestFit(cut.polygon, cut.up, outline));
    const tilts = fits.map((fit) => (fit ? Math.abs(fit.tilt) : Infinity));
    const faceOnFace = tilts.length > 0 && median(tilts) <= FIT_TOLERANCE;
    base.forEach((cut, i) => {
        const fit = fits[i];
        if (faceOnFace && fit) {
            cuts.push({ value: cut.value, polygon: cut.polygon, transform: fit.fit.transform, fitted: true, tilt: fit.tilt });
        } else {
            cuts.push({ value: cut.value, polygon: cut.polygon, transform: uprightFit(cut.polygon, cut.up), fitted: false, tilt: 0 });
        }
    });
    return cuts;
}

/** `#rrggbb`, which is all Atlas takes of a colour. */
export function isHex(value: unknown): value is string {
    return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}
