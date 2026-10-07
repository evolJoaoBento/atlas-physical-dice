import * as THREE from 'three';
import type { App } from 'obsidian';
import { D20Dice, type DicePack } from './d20-dice';
import { DEFAULT_SETTINGS, type DiceSettings } from './settings';

/**
 * A picture of each dice pack: its d20, 20 up, a little turned so it reads as a
 * solid. Atlas shows it in its dice look setting (`DiceLookSpec.preview`) and the
 * dice packs tab shows it on the pack's card.
 *
 * As Atlas's native dice packs do it: a hidden dice engine builds each pack's
 * die the way the tray builds it, and one WebGL renderer draws them in turn, so
 * a long list of packs costs a single rendering context, given back once done.
 */

const PREVIEW_PIXELS = 256;
const TOWARD_CAMERA = new THREE.Vector3(0, 0, 1);
/** A little turn off square, so the die reads as a solid rather than a flat triangle. */
const TILT = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.32, 0.28, 0));
/** Longest wait for a pack's sheets to be painted onto the die. */
const LOAD_TIMEOUT_MS = 4000;
const PACK_TYPES = ['d4', 'd6', 'd8', 'd10', 'd100', 'd12', 'd20'];

interface PreviewHost {
    app: App;
    manifest: { dir?: string };
}

function waitFrame(): Promise<void> {
    return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Scales a die so it fills the preview whatever size its pack gives it. */
function fitToView(mesh: THREE.Mesh): void {
    mesh.geometry.computeBoundingSphere();
    const radius = mesh.geometry.boundingSphere?.radius || 1;
    mesh.scale.setScalar(1.25 / radius);
}

function disposeMesh(mesh: THREE.Mesh): void {
    mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
        const phong = material as THREE.MeshPhongMaterial;
        phong.map?.dispose();
        phong.normalMap?.dispose();
        material.dispose();
    }
}

/** Whether a die's face texture holds its sheet yet: the engine paints a 1 px placeholder until it decodes. */
function textureReady(mesh: THREE.Mesh): boolean {
    const material = mesh.material as THREE.MeshPhongMaterial;
    const map = material.map;
    if (!map) return true;
    const image = map.image as { width?: number } | undefined;
    return !!image && (image.width ?? 0) > 1;
}

export class PackPreviews {
    private readonly cache = new Map<string, Promise<string | null>>();
    private queue: Promise<unknown> = Promise.resolve();

    constructor(private readonly host: PreviewHost) {}

    /** Forget every picture, so the next `render` draws the pack as it is on disk now. */
    forget(): void {
        this.cache.clear();
    }

    /** The pack's d20 as a `data:` URL, or null where it cannot be drawn (no WebGL, no d20 sheet). */
    render(folder: string, pack: DicePack): Promise<string | null> {
        let picture = this.cache.get(folder);
        if (picture === undefined) {
            picture = this.queued(async (): Promise<string | null> => {
                try {
                    return await this.draw(folder, pack);
                } catch (error) {
                    console.warn(`Atlas VTT Physical Dice: could not draw a preview of ${folder}:`, error);
                    return null;
                }
            });
            this.cache.set(folder, picture);
        }
        return picture;
    }

    /** The engine holds one pack at a time, so pictures are drawn one after another. */
    private queued<T>(work: () => Promise<T>): Promise<T> {
        const next = this.queue.then(work, work);
        this.queue = next.catch(() => undefined);
        return next;
    }

    private async draw(folder: string, pack: DicePack): Promise<string | null> {
        const dir = this.host.manifest.dir;
        if (!dir) return null;
        const adapter = this.host.app.vault.adapter;
        const root = `${dir}/dice/${folder}`;

        // The sheets as blob: URLs read by hand, so the picture can be read back from the canvas.
        const urls: string[] = [];
        const files = async (key: 'texture' | 'normal'): Promise<Record<string, string>> => {
            const found: Record<string, string> = {};
            for (const type of PACK_TYPES) {
                const named = pack.dice?.[type]?.[key];
                const file = named || (key === 'texture' ? `${type}_Numbers.png` : null);
                if (!file || !(await adapter.exists(`${root}/${file}`))) continue;
                const url = URL.createObjectURL(new Blob([await adapter.readBinary(`${root}/${file}`)]));
                urls.push(url);
                found[type] = url;
            }
            return found;
        };

        const engineHost = document.body.createDiv({ cls: 'dice-preview-engine' });
        let engine: D20Dice | null = null;
        let mesh: THREE.Mesh | null = null;
        let renderer: THREE.WebGLRenderer | null = null;
        try {
            const textures = await files('texture');
            const normals = await files('normal');
            const settings: DiceSettings = {
                ...DEFAULT_SETTINGS,
                diceCounts: { ...DEFAULT_SETTINGS.diceCounts },
                faceMapping: { ...DEFAULT_SETTINGS.faceMapping },
                diceColors: [],
            };
            engine = new D20Dice(engineHost, settings);
            // It only builds dice here; nothing on it moves or listens.
            engine.isViewActive = false;
            engine.setPack(pack);
            engine.setPackTextures(textures, normals);

            mesh = engine.createDieMesh('d20');
            fitToView(mesh);
            const twenty = engine.faceNormalOf('d20', 20);
            if (twenty) mesh.quaternion.setFromUnitVectors(twenty.normalize(), TOWARD_CAMERA).premultiply(TILT);

            const started = Date.now();
            while (!textureReady(mesh) && Date.now() - started < LOAD_TIMEOUT_MS) await delay(50);
            await waitFrame();

            renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
            renderer.setPixelRatio(1);
            renderer.setSize(PREVIEW_PIXELS, PREVIEW_PIXELS, false);
            renderer.setClearColor(0x000000, 0);
            const scene = new THREE.Scene();
            scene.add(new THREE.AmbientLight(0xffffff, 0.7));
            const key = new THREE.DirectionalLight(0xffffff, 2.2);
            key.position.set(2, 4, 5);
            scene.add(key);
            const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
            camera.position.set(0, 0, 5.2);
            camera.lookAt(0, 0, 0);
            scene.add(mesh);
            renderer.render(scene, camera);
            return renderer.domElement.toDataURL('image/png');
        } finally {
            if (mesh) disposeMesh(mesh);
            if (renderer) {
                renderer.dispose();
                renderer.forceContextLoss();
            }
            engine?.destroy();
            engineHost.remove();
            for (const url of urls) URL.revokeObjectURL(url);
        }
    }
}
