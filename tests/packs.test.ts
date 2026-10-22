import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureDefaultPack, listPacks, loadPack, migratePacks, packFileUrls, packsFolder, type PackFs } from '../kit/packs';

/** An in-memory PackFs: files by path, folders as a set. */
function memoryFs(initial: Record<string, string> = {}) {
    const files = new Map<string, ArrayBuffer>();
    const folders = new Set<string>();
    const writes: string[] = [];
    const put = (path: string, text: string) => {
        files.set(path, new TextEncoder().encode(text).buffer);
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
    };
    for (const [path, text] of Object.entries(initial)) put(path, text);
    const direct = (p: string, f: string) => f.startsWith(`${p}/`) && !f.slice(p.length + 1).includes('/');
    const fs: PackFs = {
        exists: async (p) => files.has(p) || folders.has(p),
        list: async (p) => ({
            files: [...files.keys()].filter((f) => direct(p, f)),
            folders: [...folders].filter((f) => direct(p, f))
        }),
        read: async (p) => new TextDecoder().decode(files.get(p)),
        readBinary: async (p) => files.get(p),
        writeBinary: async (p, d) => { writes.push(p); files.set(p, d); },
        mkdir: async (p) => { folders.add(p); },
        getResourcePath: (p) => `app://${p}`
    };
    return { fs, files, writes, text: (p: string) => new TextDecoder().decode(files.get(p)) };
}

const bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer;

test('packsFolder sits in the config dir', () => {
    assert.equal(packsFolder('.obsidian'), '.obsidian/atlas-dice-packs');
});

test('listPacks returns sorted folder names, and nothing for a missing folder', async () => {
    const m = memoryFs({ 'p/B/pack.json': '{}', 'p/A/pack.json': '{}', 'p/loose.txt': 'x' });
    assert.deepEqual(await listPacks(m.fs, 'p'), ['A', 'B']);
    m.fs.list = async () => { throw new Error('no folder'); };
    assert.deepEqual(await listPacks(m.fs, 'gone'), []);
});

test('loadPack reads the manifest, null when absent or broken', async () => {
    const m = memoryFs({ 'p/A/pack.json': '{"name":"Alpha"}', 'p/B/pack.json': 'nope' });
    assert.equal((await loadPack(m.fs, 'p', 'A'))?.name, 'Alpha');
    assert.equal(await loadPack(m.fs, 'p', 'B'), null);
    assert.equal(await loadPack(m.fs, 'p', 'C'), null);
});

test('packFileUrls falls back to <type>_Numbers.png without a config', () => {
    const { fs } = memoryFs();
    const urls = packFileUrls(fs, 'p', 'A', null, 'texture');
    assert.equal(urls.d20, 'app://p/A/d20_Numbers.png');
    assert.equal(urls.d100, 'app://p/A/d100_Numbers.png');
    assert.deepEqual(packFileUrls(fs, 'p', 'A', null, 'normal'), {});
});

test('packFileUrls uses the names the manifest gives', () => {
    const { fs } = memoryFs();
    const config = { dice: { d6: { texture: 'six.png', normal: 'six_n.png' } } };
    assert.equal(packFileUrls(fs, 'p', 'A', config, 'texture').d6, 'app://p/A/six.png');
    assert.deepEqual(packFileUrls(fs, 'p', 'A', config, 'normal'), { d6: 'app://p/A/six_n.png' });
});

test('ensureDefaultPack writes missing files and nothing that exists', async () => {
    const m = memoryFs({ 'p/Default/a.png': 'mine' });
    const files = { 'Default/a.png': bytes('bundled'), 'Default/b.png': bytes('b') };
    await ensureDefaultPack(m.fs, 'p', files);
    assert.deepEqual(m.writes, ['p/Default/b.png']);
    assert.equal(m.text('p/Default/a.png'), 'mine');
    m.writes.length = 0;
    await ensureDefaultPack(m.fs, 'p', files);
    assert.deepEqual(m.writes, []);
});

test('ensureDefaultPack lays out a fresh folder', async () => {
    const m = memoryFs();
    await ensureDefaultPack(m.fs, 'cfg/packs', { 'Default/a.png': new ArrayBuffer(1) });
    assert.ok(m.files.has('cfg/packs/Default/a.png'));
});

test('migratePacks copies new packs, skips existing ones, leaves the source intact', async () => {
    const m = memoryFs({
        'old/A/pack.json': '{"a":1}', 'old/A/d6_Numbers.png': 'a6', 'old/A/.version': '1',
        'old/B/pack.json': 'old B',
        'new/B/pack.json': 'kept B'
    });
    assert.equal(await migratePacks(m.fs, 'old', 'new'), 1);
    assert.equal(m.text('new/A/pack.json'), '{"a":1}');
    assert.equal(m.text('new/A/d6_Numbers.png'), 'a6');
    assert.equal(m.files.has('new/A/.version'), false);
    assert.equal(m.text('new/B/pack.json'), 'kept B');
    for (const p of ['old/A/pack.json', 'old/A/d6_Numbers.png', 'old/B/pack.json']) assert.ok(m.files.has(p), p);
    assert.equal(await migratePacks(m.fs, 'old', 'new'), 0);
});

test('migratePacks with no old folder copies nothing', async () => {
    const m = memoryFs();
    assert.equal(await migratePacks(m.fs, 'old', 'new'), 0);
});

test('migratePacks finishes a pack a failed run left half copied', async () => {
    const m = memoryFs({ 'old/A/a.png': 'one', 'old/A/b.png': 'two', 'old/A/c.png': 'three' });
    const write = m.fs.writeBinary.bind(m.fs) as PackFs['writeBinary'];
    let count = 0;
    m.fs.writeBinary = async (p, d) => {
        if (++count === 2) throw new Error('disk full');
        await write(p, d);
    };
    await assert.rejects(migratePacks(m.fs, 'old', 'new'));
    assert.equal(m.files.size, 3 + 1);
    const first = [...m.files.keys()].filter((k) => k.startsWith('new/A/'));
    assert.equal(first.length, 1);
    const kept = m.text(first[0]);
    m.fs.writeBinary = write;
    assert.equal(await migratePacks(m.fs, 'old', 'new'), 1);
    for (const f of ['a', 'b', 'c']) assert.ok(m.files.has(`new/A/${f}.png`), f);
    assert.equal(m.text(first[0]), kept);
});
