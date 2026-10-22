// Texture packs in a folder both dice plugins read, so neither depends on the
// other's plugin folder. Obsidian-free: it takes an adapter-like object, so
// Tabletop can copy this file as it is.
import type { DicePack } from './dieShapes';
import { DIE_TYPES, type DieType } from './faces';

/** The part of Obsidian's DataAdapter the packs need. */
export interface PackFs {
    exists(p: string): Promise<boolean>;
    list(p: string): Promise<{ files: string[]; folders: string[] }>;
    read(p: string): Promise<string>;
    readBinary(p: string): Promise<ArrayBuffer>;
    writeBinary(p: string, d: ArrayBuffer): Promise<void>;
    mkdir(p: string): Promise<void>;
    getResourcePath(p: string): string;
}

export const PACKS_FOLDER_NAME = 'atlas-dice-packs';

/** Where the packs live: beside the vault's other config, not inside either plugin. */
export function packsFolder(configDir: string): string {
    return `${configDir}/${PACKS_FOLDER_NAME}`;
}

const lastSegment = (p: string): string => p.split('/').pop() || '';

/** Pack folder names, sorted. A folder that cannot be listed holds no packs. */
export async function listPacks(fs: PackFs, folder: string): Promise<string[]> {
    try {
        const listing = await fs.list(folder);
        return listing.folders.map(lastSegment).filter(Boolean).sort();
    } catch {
        return [];
    }
}

/** A pack's manifest; null when it has none or cannot be read, and the pack still renders. */
export async function loadPack(fs: PackFs, folder: string, pack: string): Promise<DicePack | null> {
    try {
        const parsed = JSON.parse(await fs.read(`${folder}/${pack}/pack.json`)) as unknown;
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Resource URLs for a pack's sheets, keyed by die type. A pack with no manifest
 * still works: the sheets are named after their die, and there is no normal map
 * unless one is asked for. A missing file is not checked here; the loader copes.
 */
export function packFileUrls(
    fs: PackFs, folder: string, pack: string, config: DicePack | null, key: 'texture' | 'normal'
): Partial<Record<DieType, string>> {
    const urls: Partial<Record<DieType, string>> = {};
    for (const type of DIE_TYPES) {
        const file = config?.dice?.[type]?.[key] || (key === 'texture' ? `${type}_Numbers.png` : null);
        if (file) urls[type] = fs.getResourcePath(`${folder}/${pack}/${file}`);
    }
    return urls;
}

async function ensureFolder(fs: PackFs, path: string): Promise<void> {
    if (!(await fs.exists(path))) await fs.mkdir(path);
}

/** Write the bundled pack's files, keyed by path under `folder`, skipping any already there. */
export async function ensureDefaultPack(fs: PackFs, folder: string, files: Record<string, ArrayBuffer>): Promise<void> {
    await ensureFolder(fs, folder);
    for (const [name, data] of Object.entries(files)) {
        const path = `${folder}/${name}`;
        if (await fs.exists(path)) continue;
        const slash = name.lastIndexOf('/');
        if (slash > 0) await ensureFolder(fs, `${folder}/${name.slice(0, slash)}`);
        await fs.writeBinary(path, data);
    }
}

async function copyFolder(fs: PackFs, from: string, to: string): Promise<void> {
    await ensureFolder(fs, to);
    const listing = await fs.list(from);
    for (const file of listing.files) {
        const name = lastSegment(file);
        // `.version` stamped the old per-plugin default; it means nothing here.
        if (name.startsWith('.')) continue;
        await fs.writeBinary(`${to}/${name}`, await fs.readBinary(file));
    }
    for (const sub of listing.folders) await copyFolder(fs, sub, `${to}/${lastSegment(sub)}`);
}

/**
 * Copy pack folders from the old per-plugin folder into the shared one, skipping
 * any the shared folder already has. Never deletes. Returns how many it copied.
 */
export async function migratePacks(fs: PackFs, from: string, to: string): Promise<number> {
    if (!(await fs.exists(from))) return 0;
    await ensureFolder(fs, to);
    const have = new Set(await listPacks(fs, to));
    let copied = 0;
    for (const pack of await listPacks(fs, from)) {
        if (have.has(pack)) continue;
        await copyFolder(fs, `${from}/${pack}`, `${to}/${pack}`);
        copied++;
    }
    return copied;
}
