import d4 from './dice/Texture-Pack-Default/d4_Numbers.png';
import d6 from './dice/Texture-Pack-Default/d6_Numbers.png';
import d8 from './dice/Texture-Pack-Default/d8_Numbers.png';
import d10 from './dice/Texture-Pack-Default/d10_Numbers.png';
import d10Percent from './dice/Texture-Pack-Default/d10_Percent_Numbers.png';
import d12 from './dice/Texture-Pack-Default/d12_Numbers.png';
import d20 from './dice/Texture-Pack-Default/d20_Numbers.png';
import packJson from './dice/Texture-Pack-Default/pack.json';

/** The folder the default set lives in, under the shared packs folder. */
export const DEFAULT_PACK = 'Texture-Pack-Default';

/**
 * The default set, carried inside main.js.
 *
 * Obsidian installs a community plugin as main.js, manifest.json and
 * styles.css and nothing else, so the pack folder the loader reads from would
 * never arrive. The sheets are bundled as bytes instead and written out on
 * load, which keeps a pack a plain folder of images - the default is copied
 * and edited like any other.
 */
const FILES: Record<string, Uint8Array> = {
    'd4_Numbers.png': d4,
    'd6_Numbers.png': d6,
    'd8_Numbers.png': d8,
    'd10_Numbers.png': d10,
    'd10_Percent_Numbers.png': d10Percent,
    'd12_Numbers.png': d12,
    'd20_Numbers.png': d20,
};

/**
 * The default set as files for the shared packs folder, keyed by path under it.
 * The folder writes only the files it lacks, so a pack the user edited in place
 * stays as they left it.
 */
export function defaultPackFiles(): Record<string, ArrayBuffer> {
    const files: Record<string, ArrayBuffer> = {};
    for (const [name, bytes] of Object.entries(FILES)) files[`${DEFAULT_PACK}/${name}`] = bytes.slice().buffer;
    files[`${DEFAULT_PACK}/pack.json`] = new TextEncoder().encode(JSON.stringify(packJson, null, 2) + '\n').buffer;
    return files;
}
