import type { App } from 'obsidian';
import type { DicePack } from './d20-dice';
import type { AtlasLink, DiceLookSpec, FaceArt } from './atlas-bridge';
import { ATLAS_CELL, cutsFor, isHex, packTypeOf, wholeFaceCutsFor } from './look-faces';
import type { CellTransform, FaceCut, LookDie, Point, WholeFaceCut } from './look-faces';
import type { PackPreviews } from './pack-previews';

/**
 * Registers every dice pack as a look Atlas can paint its 3D dice with.
 *
 * Atlas asks a look for the art of each face value, one die type at a time. A
 * pack's sheet is a net - every face drawn once, unfolded, on a mask whose
 * transparent parts show the die's own colour - so the art is that net cut
 * apart, one image per face value.
 *
 * - On Atlas's extension API 1.18 and later (`fill: 'face'`) each image is the
 *   whole face: the pack's background and numeral, laid on Atlas's outline of
 *   that face with the digit upright. The sheet's transparency is kept, so the
 *   body colour Atlas paints under it shows through: the pack's colour, or the
 *   colour a die was rolled in.
 * - On 1.16 and 1.17 only the digit is cut out and Atlas prints it on its own
 *   card, where it would print its numeral.
 *
 * A face the pack cannot answer is left out and Atlas prints its own numeral there.
 */

/** Atlas copies art at most this big on its longer side, so there is no point making more. */
const ART_MAX = 256;

/** Room left round the widest digit of a die type, as a share of it. */
const ART_MARGIN = 1.12;

/** Width of the rim of a face, in sheet pixels, that is never read: a net's cell edges are not art. */
const SEAM = 8;

/** The flat of Atlas's relief: grey it paints under a face before its `bump` art. */
const RELIEF_FLAT = 0x8a;

/** What the die is made of when the pack does not say (as the plugin's own dice). */
const FALLBACK_COLOUR = '#ff4444';

/** What the plugin needs of itself to find the packs. */
export interface LookHost {
    app: App;
    manifest: { dir?: string };
    listTexturePacks(): Promise<string[]>;
}

/** One pack on disk, as the looks and the dice packs tab list it. */
export interface PackEntry {
    /** Folder name under `dice/`: the look's id. */
    folder: string;
    /** As shown in Atlas: the pack's `name`, else its folder. */
    name: string;
    pack: DicePack;
    /** A d20 of the pack, 20 up, as a `data:` URL; null without WebGL. */
    preview: string | null;
}

function canvasOf(width: number, height: number): HTMLCanvasElement {
    const canvas = createEl('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
    return canvas.getContext('2d', { willReadFrequently: true });
}

function trace(ctx: CanvasRenderingContext2D, points: Point[]): void {
    ctx.beginPath();
    points.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
}

function useTransform(ctx: CanvasRenderingContext2D, t: CellTransform): void {
    ctx.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
}

/** The commonest colour of the pixels `inside` marks fully opaque, as straight (not premultiplied) RGBA. */
function commonestColour(pixels: Uint8ClampedArray, inside: Uint8ClampedArray): [number, number, number, number] | null {
    const bins = 4096;
    const hits = new Float64Array(bins);
    const sums = new Float64Array(bins * 4);
    for (let i = 0; i < pixels.length; i += 4) {
        if (inside[i + 3] < 255) continue;
        const a = pixels[i + 3];
        const bin = a < 16 ? 0 : ((pixels[i] >> 5) << 9) | ((pixels[i + 1] >> 5) << 6) | ((pixels[i + 2] >> 5) << 3) | (a >> 5);
        hits[bin]++;
        sums[bin * 4] += pixels[i];
        sums[bin * 4 + 1] += pixels[i + 1];
        sums[bin * 4 + 2] += pixels[i + 2];
        sums[bin * 4 + 3] += a;
    }
    let top = 0;
    for (let b = 1; b < bins; b++) if (hits[b] > hits[top]) top = b;
    if (hits[top] === 0) return null;
    return [sums[top * 4] / hits[top], sums[top * 4 + 1] / hits[top], sums[top * 4 + 2] / hits[top], sums[top * 4 + 3] / hits[top]];
}

// ---------------------------------------------------------------------------
// Whole faces (API 1.18, `fill: 'face'`)
// ---------------------------------------------------------------------------

/**
 * One whole face, in Atlas's cell: the pack's face laid on Atlas's outline of it. The
 * cell round the face is filled with the face's own background, so a face shape that
 * differs a little from Atlas's never shows a neighbour from the sheet. `under`, when
 * given, is painted beneath (a die type with a colour of its own in the pack).
 */
function cutWholeFace(sheet: ImageBitmap, cut: WholeFaceCut, under: string | null): HTMLCanvasElement | null {
    const n = ATLAS_CELL;
    const face = canvasOf(n, n);
    const mask = canvasOf(n, n);
    const faceCtx = context2d(face);
    const maskCtx = context2d(mask);
    if (!faceCtx || !maskCtx) return null;

    // The face, clipped to its outline.
    faceCtx.imageSmoothingQuality = 'high';
    useTransform(faceCtx, cut.transform);
    trace(faceCtx, cut.polygon);
    faceCtx.clip();
    if (!cut.corners) faceCtx.drawImage(sheet, 0, 0);
    faceCtx.setTransform(1, 0, 0, 1, 0, 0);

    // Where its background is read: inside, off the seams between a net's cells.
    useTransform(maskCtx, cut.transform);
    trace(maskCtx, cut.polygon);
    maskCtx.fillStyle = '#fff';
    maskCtx.fill();
    maskCtx.globalCompositeOperation = 'destination-out';
    maskCtx.lineWidth = SEAM;
    maskCtx.stroke();
    maskCtx.globalCompositeOperation = 'source-over';
    maskCtx.setTransform(1, 0, 0, 1, 0, 0);

    let wash: [number, number, number, number] | null;
    if (cut.corners) {
        // A d4 numbered the other way round: its background from the sheet, then each number at its corner.
        const probe = canvasOf(n, n);
        const probeCtx = context2d(probe);
        if (!probeCtx) return null;
        useTransform(probeCtx, cut.transform);
        trace(probeCtx, cut.polygon);
        probeCtx.clip();
        probeCtx.drawImage(sheet, 0, 0);
        wash = commonestColour(probeCtx.getImageData(0, 0, n, n).data, maskCtx.getImageData(0, 0, n, n).data);
        if (!wash) return null;
        faceCtx.fillStyle = `rgba(${wash[0]},${wash[1]},${wash[2]},${wash[3] / 255})`;
        faceCtx.fillRect(0, 0, n, n);
        for (const corner of cut.corners) {
            faceCtx.save();
            useTransform(faceCtx, corner.transform);
            faceCtx.beginPath();
            faceCtx.arc(corner.window.x, corner.window.y, corner.window.r, 0, Math.PI * 2);
            faceCtx.clip();
            // The window's own background lies over the wash: clear it first so the two do not add up.
            faceCtx.clearRect(corner.window.x - corner.window.r, corner.window.y - corner.window.r, corner.window.r * 2, corner.window.r * 2);
            faceCtx.drawImage(sheet, 0, 0);
            faceCtx.restore();
        }
    } else {
        wash = commonestColour(faceCtx.getImageData(0, 0, n, n).data, maskCtx.getImageData(0, 0, n, n).data);
    }

    const out = canvasOf(n, n);
    const ctx = context2d(out);
    if (!ctx) return null;
    if (wash) {
        ctx.fillStyle = `rgba(${Math.round(wash[0])},${Math.round(wash[1])},${Math.round(wash[2])},${wash[3] / 255})`;
        ctx.fillRect(0, 0, n, n);
        useTransform(ctx, cut.transform);
        trace(ctx, cut.polygon);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
    }
    ctx.drawImage(face, 0, 0);
    if (under) {
        ctx.globalCompositeOperation = 'destination-over';
        ctx.fillStyle = under;
        ctx.fillRect(0, 0, n, n);
        ctx.globalCompositeOperation = 'source-over';
    }
    return out;
}

/**
 * The relief of one whole face, from the pack's normal map: grey, Atlas's flat where
 * the face is flat and darker the steeper it slopes, so engraved edges press in.
 * Laid out exactly as the face. Transparent off the face, where Atlas's flat shows.
 */
function cutWholeRelief(normals: ImageBitmap, cut: WholeFaceCut): HTMLCanvasElement | null {
    const n = ATLAS_CELL;
    const canvas = canvasOf(n, n);
    const ctx = context2d(canvas);
    if (!ctx) return null;
    useTransform(ctx, cut.transform);
    trace(ctx, cut.polygon);
    ctx.clip();
    ctx.drawImage(normals, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const image = ctx.getImageData(0, 0, n, n);
    const data = image.data;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        const nx = data[i] / 127.5 - 1;
        const ny = data[i + 1] / 127.5 - 1;
        const slope = Math.min(1, Math.hypot(nx, ny));
        const grey = Math.round(RELIEF_FLAT * (1 - slope));
        data[i] = data[i + 1] = data[i + 2] = grey;
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
}

// ---------------------------------------------------------------------------
// Digits only (API 1.16 and 1.17)
// ---------------------------------------------------------------------------

interface Unmixed {
    value: number;
    canvas: HTMLCanvasElement;
    /** Where the digit's ink lies on `canvas`. */
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

/**
 * Cut one face out of its sheet, turn the digit upright and keep only its ink.
 *
 * What a sheet paints is a faint wash over each face and the digits over it.
 * The wash is the commonest colour in the face; the ink is whatever lies
 * furthest from it. Each pixel is placed on the line between the two and the
 * share of ink it holds becomes its opacity, so the result is the digit alone,
 * in the colour it was drawn in, however faint or strong the wash is.
 */
function unmixFace(sheet: ImageBitmap, cut: FaceCut): Unmixed | null {
    const win = cut.window;
    const points = cut.polygon;
    let cx = 0;
    let cy = 0;
    if (win) {
        cx = win.x;
        cy = win.y;
    } else {
        for (const p of points) { cx += p[0]; cy += p[1]; }
        cx /= points.length;
        cy /= points.length;
    }
    let reach = win ? win.r : 0;
    if (!win) for (const p of points) reach = Math.max(reach, Math.hypot(p[0] - cx, p[1] - cy));
    const n = Math.ceil(reach * 2) + 4;
    if (!(n >= 8) || n > 2048) return null;

    const turn = -cut.up * Math.PI / 180;
    const frame = (ctx: CanvasRenderingContext2D) => {
        ctx.translate(n / 2, n / 2);
        ctx.rotate(turn);
        ctx.translate(-cx, -cy);
    };

    // Where the face is, apart from what is drawn there: a transparent wash
    // is still the face.
    const maskCanvas = canvasOf(n, n);
    const mask = context2d(maskCanvas);
    const workCanvas = canvasOf(n, n);
    const work = context2d(workCanvas);
    if (!mask || !work) return null;

    mask.save();
    frame(mask);
    trace(mask, points);
    mask.fillStyle = '#fff';
    mask.fill();
    // Without its rim: the seams between a net's cells are pale lines that would
    // be taken for the strongest ink there is.
    mask.globalCompositeOperation = 'destination-out';
    mask.lineWidth = SEAM;
    mask.stroke();
    mask.globalCompositeOperation = 'source-over';
    if (win) {
        mask.globalCompositeOperation = 'destination-in';
        mask.beginPath();
        mask.arc(win.x, win.y, win.r, 0, Math.PI * 2);
        mask.fill();
    }
    mask.restore();

    work.save();
    work.imageSmoothingQuality = 'high';
    frame(work);
    trace(work, points);
    work.clip();
    if (win) {
        work.beginPath();
        work.arc(win.x, win.y, win.r, 0, Math.PI * 2);
        work.clip();
    }
    work.drawImage(sheet, 0, 0);
    work.restore();

    const pixels = work.getImageData(0, 0, n, n).data;
    const inside = mask.getImageData(0, 0, n, n).data;
    const count = n * n;

    // The wash: the commonest colour, found in coarse bins and then averaged.
    // Only pixels wholly inside count; the clip's soft edge is half outside.
    const bins = 4096;
    const hits = new Float64Array(bins);
    const sums = new Float64Array(bins * 4);
    for (let i = 0; i < count; i++) {
        if (inside[i * 4 + 3] < 255) continue;
        const a = pixels[i * 4 + 3];
        const bin = a < 16 ? 0 : ((pixels[i * 4] >> 5) << 9) | ((pixels[i * 4 + 1] >> 5) << 6) | ((pixels[i * 4 + 2] >> 5) << 3) | (a >> 5);
        hits[bin]++;
        sums[bin * 4] += pixels[i * 4] * a / 255;
        sums[bin * 4 + 1] += pixels[i * 4 + 1] * a / 255;
        sums[bin * 4 + 2] += pixels[i * 4 + 2] * a / 255;
        sums[bin * 4 + 3] += a;
    }
    let top = 0;
    for (let b = 1; b < bins; b++) if (hits[b] > hits[top]) top = b;
    if (hits[top] === 0) return null;
    const wash = [sums[top * 4] / hits[top], sums[top * 4 + 1] / hits[top], sums[top * 4 + 2] / hits[top], sums[top * 4 + 3] / hits[top]];

    // The ink: the pixel furthest from the wash.
    let far = 0;
    let at = -1;
    for (let i = 0; i < count; i++) {
        if (inside[i * 4 + 3] < 255) continue;
        const a = pixels[i * 4 + 3];
        const d0 = pixels[i * 4] * a / 255 - wash[0];
        const d1 = pixels[i * 4 + 1] * a / 255 - wash[1];
        const d2 = pixels[i * 4 + 2] * a / 255 - wash[2];
        const d3 = a - wash[3];
        const d = d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
        if (d > far) { far = d; at = i; }
    }
    // Nothing printed here: Atlas's numeral is the better answer.
    if (at < 0 || far < 40 * 40) return null;
    const inkA = pixels[at * 4 + 3];
    const ink = [pixels[at * 4] * inkA / 255 - wash[0], pixels[at * 4 + 1] * inkA / 255 - wash[1], pixels[at * 4 + 2] * inkA / 255 - wash[2], inkA - wash[3]];

    const out = work.createImageData(n, n);
    let x0 = n;
    let y0 = n;
    let x1 = -1;
    let y1 = -1;
    for (let i = 0; i < count; i++) {
        if (inside[i * 4 + 3] < 255) continue;
        const a = pixels[i * 4 + 3];
        const d0 = pixels[i * 4] * a / 255 - wash[0];
        const d1 = pixels[i * 4 + 1] * a / 255 - wash[1];
        const d2 = pixels[i * 4 + 2] * a / 255 - wash[2];
        const d3 = a - wash[3];
        let share = (d0 * ink[0] + d1 * ink[1] + d2 * ink[2] + d3 * ink[3]) / far;
        // The seams between cells of a net are a pale line, not a digit.
        if (share < 0.15) continue;
        if (share > 1) share = 1;
        out.data[i * 4] = pixels[at * 4];
        out.data[i * 4 + 1] = pixels[at * 4 + 1];
        out.data[i * 4 + 2] = pixels[at * 4 + 2];
        out.data[i * 4 + 3] = Math.round(share * inkA);
        if (share > 0.5) {
            const x = i % n;
            const y = (i - x) / n;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
        }
    }
    if (x1 < 0) return null;

    const canvas = canvasOf(n, n);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.putImageData(out, 0, 0);
    return { value: cut.value, canvas, x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/**
 * Every digit of one die type, as images the same size.
 *
 * All of a die type's faces share one size - the room the widest digit needs -
 * and each digit is centred in it, so a 1 and a 20 keep their real proportions
 * instead of each being stretched to fill its own image.
 */
function cutDigits(sheet: ImageBitmap, cuts: FaceCut[]): Record<number, HTMLCanvasElement> {
    const faces: Unmixed[] = [];
    for (const cut of cuts) {
        try {
            const face = unmixFace(sheet, cut);
            if (face) faces.push(face);
        } catch (error) {
            console.warn(`Atlas VTT Physical Dice: could not cut face ${cut.value} for an Atlas look:`, error);
        }
    }
    const art: Record<number, HTMLCanvasElement> = {};
    if (faces.length === 0) return art;

    let widest = 1;
    for (const f of faces) widest = Math.max(widest, f.x1 - f.x0, f.y1 - f.y0);
    const side = Math.ceil(widest * ART_MARGIN) + 2;
    const k = Math.min(1, ART_MAX / side);
    const size = Math.max(1, Math.round(side * k));

    for (const f of faces) {
        const canvas = canvasOf(size, size);
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        ctx.imageSmoothingQuality = 'high';
        const mx = (f.x0 + f.x1) / 2;
        const my = (f.y0 + f.y1) / 2;
        ctx.drawImage(f.canvas, (side / 2 - mx) * k, (side / 2 - my) * k, f.canvas.width * k, f.canvas.height * k);
        art[f.value] = canvas;
    }
    return art;
}

// ---------------------------------------------------------------------------
// Packs as looks
// ---------------------------------------------------------------------------

/** How a look's faces are drawn: Atlas 1.18's whole faces, or the digit on Atlas's card. */
export type LookFill = 'face' | 'numeral';

/** One pack, as a look. Faces are cut once per die type and kept until the pack is reloaded. */
export class PackLook {
    private readonly art = new Map<string, Promise<FaceArt>>();

    constructor(
        private readonly host: LookHost,
        readonly entry: PackEntry,
        private readonly fill: LookFill,
    ) {}

    get folder(): string {
        return this.entry.folder;
    }

    private get pack(): DicePack {
        return this.entry.pack;
    }

    faces(sides: LookDie): Promise<FaceArt> {
        return this.cached(`faces:${sides}`, () => this.cutFaces(sides));
    }

    bump(sides: LookDie): Promise<FaceArt> {
        return this.cached(`bump:${sides}`, () => this.cutRelief(sides));
    }

    /** Whether the pack has a normal map for any die. */
    get hasNormals(): boolean {
        return Object.values(this.pack.dice ?? {}).some((die) => typeof die?.normal === 'string' && die.normal.length > 0);
    }

    private cached(key: string, make: () => Promise<FaceArt>): Promise<FaceArt> {
        let answer = this.art.get(key);
        if (answer === undefined) {
            answer = make().catch((error: unknown) => {
                console.warn(`Atlas VTT Physical Dice: could not cut ${this.folder} (${key}) for an Atlas look:`, error);
                return {};
            });
            this.art.set(key, answer);
        }
        return answer;
    }

    /** A sheet of the pack, read by hand: an app:// resource URL may not be readable back. */
    private async sheet(file: string | undefined): Promise<ImageBitmap | null> {
        if (!file) return null;
        const adapter = this.host.app.vault.adapter;
        const path = `${this.host.manifest.dir}/dice/${this.folder}/${file}`;
        if (!(await adapter.exists(path))) return null;
        const bytes = await adapter.readBinary(path);
        return createImageBitmap(new Blob([bytes]));
    }

    private async cutFaces(sides: LookDie): Promise<FaceArt> {
        const type = packTypeOf(sides);
        const die = this.pack.dice?.[type];
        const sheet = await this.sheet(die?.texture || `${type}_Numbers.png`);
        if (!sheet) return {};
        try {
            const art: Record<number, HTMLCanvasElement> = {};
            if (this.fill === 'face') {
                // A die type with a colour of its own wears it under its faces; Atlas has one body colour per look.
                const own = isHex(die?.color) && die?.color !== this.bodyColour ? die?.color : null;
                for (const cut of wholeFaceCutsFor(sides, this.pack, sheet.width, sheet.height)) {
                    try {
                        const face = cutWholeFace(sheet, cut, own ?? null);
                        if (face) art[cut.value] = face;
                    } catch (error) {
                        console.warn(`Atlas VTT Physical Dice: could not cut ${this.folder} d${sides} face ${cut.value}:`, error);
                    }
                }
                return art;
            }
            return cutDigits(sheet, cutsFor(sides, this.pack, sheet.width, sheet.height));
        } finally {
            sheet.close();
        }
    }

    private async cutRelief(sides: LookDie): Promise<FaceArt> {
        if (this.fill !== 'face') return {};
        const type = packTypeOf(sides);
        const die = this.pack.dice?.[type];
        if (!die?.normal) return {};
        const normals = await this.sheet(die.normal);
        if (!normals) return {};
        try {
            // Cut by the face sheet's layout: a normal map is drawn over the same net.
            const sheet = await this.sheet(die.texture || `${type}_Numbers.png`);
            const width = sheet?.width ?? normals.width;
            const height = sheet?.height ?? normals.height;
            sheet?.close();
            const scaleX = normals.width / width;
            const scaleY = normals.height / height;
            const relief: Record<number, HTMLCanvasElement> = {};
            for (const cut of wholeFaceCutsFor(sides, this.pack, width, height)) {
                if (cut.corners) continue;
                // The normal map may be drawn at another size than the face sheet.
                const scaled: WholeFaceCut = {
                    ...cut,
                    polygon: cut.polygon.map((p): Point => [p[0] * scaleX, p[1] * scaleY]),
                    transform: { ...cut.transform, a: cut.transform.a / scaleX, b: cut.transform.b / scaleX, c: cut.transform.c / scaleY, d: cut.transform.d / scaleY },
                };
                const canvas = cutWholeRelief(normals, scaled);
                if (canvas) relief[cut.value] = canvas;
            }
            return relief;
        } finally {
            normals.close();
        }
    }

    /** What Atlas paints under the faces: the pack's colour. */
    get bodyColour(): string {
        return isHex(this.pack.color) ? this.pack.color : FALLBACK_COLOUR;
    }

    spec(name: string): DiceLookSpec {
        const spec: DiceLookSpec = {
            id: this.folder,
            name,
            faces: (sides) => this.faces(sides),
        };
        const body: { colour?: string; ink?: string } = {};
        if (this.fill === 'face') {
            // Always a colour: without one, the transparent parts of a whole face would not be filled.
            body.colour = this.bodyColour;
            spec.fill = 'face';
            if (this.hasNormals) spec.bump = (sides) => this.bump(sides);
        } else if (isHex(this.pack.color)) {
            body.colour = this.pack.color;
        }
        const ink = (this.pack as { ink?: unknown }).ink;
        if (isHex(ink)) body.ink = ink;
        if (body.colour || body.ink) spec.body = body;
        if (this.entry.preview) spec.preview = this.entry.preview;
        return spec;
    }

    dispose(): void {
        this.art.clear();
    }
}

/** Reads the packs on disk: name, manifest and preview. */
export async function readPacks(host: LookHost, previews: PackPreviews | null): Promise<PackEntry[]> {
    const folders = await host.listTexturePacks();
    const adapter = host.app.vault.adapter;
    const entries: PackEntry[] = [];
    for (const folder of folders) {
        let pack: DicePack = {};
        try {
            const read = JSON.parse(await adapter.read(`${host.manifest.dir}/dice/${folder}/pack.json`)) as unknown;
            if (read && typeof read === 'object') pack = read;
        } catch {
            // A pack without a manifest still has its sheets, named after their die.
        }
        entries.push({ folder, name: folder, pack, preview: null });
    }

    // Two packs named alike would be indistinguishable in Atlas's list.
    const wanted = entries.map((e) => (typeof e.pack.name === 'string' && e.pack.name.trim()) || e.folder);
    const taken = new Set<string>();
    entries.forEach((entry, i) => {
        let name = wanted[i].slice(0, 64);
        if (taken.has(name) || wanted.filter((w) => w === wanted[i]).length > 1) name = `${wanted[i]} (${entry.folder})`.slice(0, 64);
        taken.add(name);
        entry.name = name;
    });

    if (previews) {
        for (const entry of entries) entry.preview = await previews.render(entry.folder, entry.pack);
    }
    return entries;
}

/** Keeps Atlas's dice looks in step with the dice packs on disk. */
export class AtlasLooks {
    private looks: PackLook[] = [];
    private disposers: Array<() => void> = [];
    private generation = 0;
    private readonly changeListeners = new Set<() => void>();
    /** The packs as last read, for the dice packs tab. */
    packs: PackEntry[] = [];
    /** The names Atlas was given, for the settings note. */
    registered: string[] = [];

    constructor(
        private readonly host: LookHost,
        private readonly link: AtlasLink,
        private readonly previews: PackPreviews | null,
    ) {
        link.onChange(() => { void this.refresh(); });
    }

    /** Be told when the packs have been read again. */
    onChange(listener: () => void): () => void {
        this.changeListeners.add(listener);
        return () => this.changeListeners.delete(listener);
    }

    /** Whether Atlas takes looks at all. */
    get available(): boolean {
        return !!this.link.dice && typeof this.link.dice.registerLook === 'function' && this.link.has('dice-looks');
    }

    /** Whole faces need API 1.18; any of its capabilities says so (minor versions are never compared). */
    private get fill(): LookFill {
        for (const capability of ['dice-look-choice', 'dice-colours', 'asset-tabs', 'collections']) {
            if (this.link.has(capability)) return 'face';
        }
        return 'numeral';
    }

    /** Read the packs and register every one again. Safe to call whether or not Atlas is there. */
    async refresh(): Promise<void> {
        const generation = ++this.generation;
        this.dispose();
        if (!this.available || !this.host.manifest.dir) {
            this.packs = [];
            this.notify();
            return;
        }

        this.previews?.forget();
        const entries = await readPacks(this.host, this.previews);
        // Another refresh began while the packs were being read.
        if (generation !== this.generation) return;

        const dice = this.link.dice;
        if (!dice || typeof dice.registerLook !== 'function') return;
        const fill = this.fill;
        this.packs = entries;
        for (const entry of entries) {
            const look = new PackLook(this.host, entry, fill);
            try {
                this.disposers.push(dice.registerLook(look.spec(entry.name)));
                this.looks.push(look);
                this.registered.push(entry.name);
            } catch (error) {
                console.warn(`Atlas VTT Physical Dice: Atlas would not take the dice look "${entry.name}":`, error);
                look.dispose();
            }
        }
        this.notify();
    }

    /** Whether a pack was registered as a look, so it can be chosen. */
    isRegistered(folder: string): boolean {
        return this.looks.some((look) => look.folder === folder);
    }

    private notify(): void {
        for (const listener of this.changeListeners) {
            try { listener(); } catch (error) { console.warn('Atlas VTT Physical Dice:', error); }
        }
    }

    /** Take the looks back out, for a reload or because Atlas went away. */
    dispose(): void {
        for (const dispose of this.disposers) {
            try { dispose(); } catch { /* Atlas may already have let them go. */ }
        }
        for (const look of this.looks) look.dispose();
        this.disposers = [];
        this.looks = [];
        this.registered = [];
    }
}
