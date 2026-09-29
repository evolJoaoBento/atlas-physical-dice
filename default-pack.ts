import type { DataAdapter } from 'obsidian';
import d4 from './dice/Texture-Pack-Default/d4_Numbers.png';
import d6 from './dice/Texture-Pack-Default/d6_Numbers.png';
import d8 from './dice/Texture-Pack-Default/d8_Numbers.png';
import d10 from './dice/Texture-Pack-Default/d10_Numbers.png';
import d10Percent from './dice/Texture-Pack-Default/d10_Percent_Numbers.png';
import d12 from './dice/Texture-Pack-Default/d12_Numbers.png';
import d20 from './dice/Texture-Pack-Default/d20_Numbers.png';
import packJson from './dice/Texture-Pack-Default/pack.json';

/** The folder the default set lives in, under the plugin's `dice/` directory. */
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

/** Records which release wrote the folder, so an update replaces stale art. */
const STAMP = '.version';

/**
 * Write the default pack into `<pluginDir>/dice/` unless this release already
 * did. The folder belongs to the plugin: a custom set is a copy under another
 * name, so replacing it on update loses nothing.
 */
export async function ensureDefaultPack(adapter: DataAdapter, pluginDir: string, version: string): Promise<void> {
    const dir = `${pluginDir}/dice/${DEFAULT_PACK}`;
    const stamp = `${dir}/${STAMP}`;
    if (await adapter.exists(stamp) && (await adapter.read(stamp)).trim() === version) return;

    if (!(await adapter.exists(`${pluginDir}/dice`))) await adapter.mkdir(`${pluginDir}/dice`);
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    for (const [name, bytes] of Object.entries(FILES)) {
        const copy = bytes.slice();
        await adapter.writeBinary(`${dir}/${name}`, copy.buffer);
    }
    await adapter.write(`${dir}/pack.json`, JSON.stringify(packJson, null, 2) + '\n');
    await adapter.write(stamp, version);
}
