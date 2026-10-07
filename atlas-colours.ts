import { setIcon } from 'obsidian';
import type { AtlasDiceColour, AtlasLink, Disposer } from './atlas-bridge';
import { cleanTagColor, cleanTagName } from './atlas-bridge';

/**
 * Dice colours per collection: a "Dice" tab in each collection's settings
 * (`ui.addCollectionSettingsTab`) lists them, they are kept with the collection
 * (`collections.setData`), and Atlas's dice tray offers them
 * (`dice.registerColours`). The plugin's own dice panel offers the colours of
 * the collection whose map is open, beside its own.
 *
 * Every piece is feature-detected on its own: without `collections` there is no
 * tab and nothing is stored, without `dice-colours` the tray offers nothing.
 */

/** A colour dice can be added in, as the collection keeps it. */
export interface CollectionDiceColour {
    id: string;
    name: string;
    color: string;
}

/** What this plugin keeps on a collection (`collections.setData`). */
interface StoredData {
    colors?: unknown;
}

/** As Atlas's own collection settings suggest them, in this order. */
export const SUGGESTED_COLORS = ['#d64545', '#3b82f6', '#22a06b', '#e0a526', '#8b5cf6', '#1f2937'];

/** A write is held this long after the last edit, so typing a name is one save. */
const SAVE_DELAY_MS = 400;

function readColours(data: unknown): CollectionDiceColour[] {
    const list = (data && typeof data === 'object' ? (data as StoredData).colors : null);
    if (!Array.isArray(list)) return [];
    const colours: CollectionDiceColour[] = [];
    for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const { id, name, color } = entry as Partial<CollectionDiceColour>;
        if (!color || !cleanTagColor(color)) continue;
        colours.push({
            id: typeof id === 'string' && id ? id : `color-${colours.length}`,
            name: typeof name === 'string' ? name : '',
            color,
        });
    }
    return colours;
}

/** As Atlas takes them: a name it keeps (the colour code when the entry has none), a `#rrggbb` colour. */
export function asTrayColours(colours: readonly CollectionDiceColour[]): AtlasDiceColour[] {
    const out: AtlasDiceColour[] = [];
    for (const entry of colours) {
        const color = cleanTagColor(entry.color);
        if (!color) continue;
        out.push({ name: cleanTagName(entry.name) ?? color, color });
    }
    return out;
}

export class AtlasColours {
    private readonly cache = new Map<string, CollectionDiceColour[]>();
    private readonly loading = new Map<string, Promise<CollectionDiceColour[]>>();
    private disposers: Disposer[] = [];
    /** Writes waiting for their delay, by collection. */
    private readonly pending = new Map<string, { timer: number; colours: CollectionDiceColour[] }>();

    constructor(private readonly link: AtlasLink) {
        link.onChange(() => this.reconnect());
    }

    private get collections() {
        return this.link.has('collections') ? this.link.extension?.collections ?? null : null;
    }

    /** Whether colours can be kept on collections at all. */
    get available(): boolean {
        const collections = this.collections;
        return !!collections && typeof collections.getData === 'function' && typeof collections.setData === 'function';
    }

    private reconnect(): void {
        this.flushAll();
        for (const dispose of this.disposers) {
            try { dispose(); } catch { /* Atlas may already have let it go. */ }
        }
        this.disposers = [];
        this.cache.clear();
        this.loading.clear();

        const ext = this.link.extension;
        if (!ext || !this.available) return;

        const ui = ext.ui;
        if (ui && typeof ui.addCollectionSettingsTab === 'function') {
            try {
                this.disposers.push(ui.addCollectionSettingsTab({
                    id: 'dice-colours',
                    title: 'Dice',
                    icon: 'dice',
                    mount: (container: HTMLElement, ctx: { collectionId: string }) => this.mountTab(container, ctx.collectionId),
                }));
            } catch (error) {
                console.warn('Atlas VTT Physical Dice: could not add the collection Dice tab:', error);
            }
        }

        const dice = ext.dice;
        if (dice && typeof dice.registerColours === 'function' && this.link.has('dice-colours')) {
            try {
                this.disposers.push(dice.registerColours((collectionId: string) => this.trayColours(collectionId)));
            } catch (error) {
                console.warn('Atlas VTT Physical Dice: could not offer dice colours to Atlas:', error);
            }
        }

        // Someone else (another device's index, a rename, a delete) changed a collection: read again on demand.
        this.disposers.push(this.link.listen('collections-changed', () => {
            this.cache.clear();
            this.link.invalidate();
        }));
    }

    /** What Atlas's dice tray offers for a collection: from what is known now, read in when not. */
    private trayColours(collectionId: string): AtlasDiceColour[] {
        const known = this.peek(collectionId);
        return known ? asTrayColours(known) : [];
    }

    /**
     * A collection's colours as known now, or null when they still have to be read; then
     * they are, and Atlas is asked to look again (`ui.invalidate()`).
     */
    peek(collectionId: string): CollectionDiceColour[] | null {
        const pending = this.pending.get(collectionId);
        if (pending) return pending.colours;
        const known = this.cache.get(collectionId);
        if (known) return known;
        void this.load(collectionId);
        return null;
    }

    load(collectionId: string): Promise<CollectionDiceColour[]> {
        const known = this.cache.get(collectionId);
        if (known) return Promise.resolve(known);
        const inFlight = this.loading.get(collectionId);
        if (inFlight !== undefined) return inFlight;
        const collections = this.collections;
        if (!collections || typeof collections.getData !== 'function') return Promise.resolve<CollectionDiceColour[]>([]);
        const reading = (async (): Promise<CollectionDiceColour[]> => {
            try {
                const colours = readColours(await collections.getData?.(collectionId));
                // An edit made while reading wins.
                const now = this.pending.get(collectionId)?.colours ?? colours;
                this.cache.set(collectionId, now);
                this.link.invalidate();
                return now;
            } catch {
                return [];
            } finally {
                this.loading.delete(collectionId);
            }
        })();
        this.loading.set(collectionId, reading);
        return reading;
    }

    /** The collection of the map open in Atlas now, when it is in one. */
    activeCollection(): string | null {
        const ext = this.link.extension;
        try {
            const views = ext?.views;
            const rules = ext?.rules;
            if (!views || !rules || typeof views.active !== 'function' || typeof rules.forMap !== 'function') return null;
            const view = views.active();
            if (!view?.mapPath) return null;
            return rules.forMap(view.mapPath).collectionId ?? null;
        } catch {
            return null;
        }
    }

    /** The colours of the collection whose map is open, for the plugin's own dice panel. Empty while unknown. */
    forActiveMap(): CollectionDiceColour[] {
        if (!this.available) return [];
        const collectionId = this.activeCollection();
        if (!collectionId) return [];
        return this.peek(collectionId) ?? [];
    }

    /** Keep a collection's colours: at once for Atlas's tray, on disk after a short pause. */
    private save(collectionId: string, colours: CollectionDiceColour[]): void {
        this.cache.set(collectionId, colours);
        const pending = this.pending.get(collectionId);
        if (pending) window.clearTimeout(pending.timer);
        const timer = window.setTimeout(() => this.flush(collectionId), SAVE_DELAY_MS);
        this.pending.set(collectionId, { timer, colours });
        this.link.invalidate();
    }

    private flush(collectionId: string): void {
        const pending = this.pending.get(collectionId);
        if (!pending) return;
        window.clearTimeout(pending.timer);
        this.pending.delete(collectionId);
        const collections = this.collections;
        if (!collections || typeof collections.setData !== 'function') return;
        const colours = pending.colours.map((entry) => ({ id: entry.id, name: entry.name.trim(), color: entry.color }));
        collections.setData(collectionId, colours.length ? { colors: colours } : null).catch((error: unknown) => {
            console.warn('Atlas VTT Physical Dice: could not save the dice colours:', error);
        });
    }

    private flushAll(): void {
        for (const collectionId of [...this.pending.keys()]) this.flush(collectionId);
    }

    dispose(): void {
        this.flushAll();
        for (const dispose of this.disposers) {
            try { dispose(); } catch { /* already gone */ }
        }
        this.disposers = [];
    }

    /** The collection settings tab: name and colour per entry, add and remove, as Atlas's own dice colours field. */
    private mountTab(container: HTMLElement, collectionId: string): Disposer {
        let colours: CollectionDiceColour[] = [];
        let gone = false;
        const root = container.createDiv({ cls: 'apd-collection-dice' });

        const render = (): void => {
            root.empty();
            root.createDiv({ cls: 'apd-field-label', text: 'Dice colours' });
            root.createEl('p', {
                cls: 'apd-hint',
                text: 'Colours dice can be added in, beside the pack\'s own. Pick one in the dice tray or the dice panel, then add dice: each die keeps its colour, and the roll names it. Saved as you type.',
            });

            colours.forEach((entry, index) => {
                const row = root.createDiv({ cls: 'apd-colour-row' });
                const swatch = row.createEl('input', {
                    type: 'color',
                    cls: 'apd-colour-swatch',
                    attr: { 'aria-label': `Colour of ${entry.name || `colour ${index + 1}`}` },
                });
                swatch.value = entry.color;
                swatch.addEventListener('input', () => update(index, { color: swatch.value }, false));
                const name = row.createEl('input', { type: 'text', cls: 'apd-colour-name', attr: { placeholder: 'Name, e.g. Fire' } });
                name.value = entry.name;
                name.addEventListener('input', () => update(index, { name: name.value.trimStart() }, false));
                const remove = row.createEl('button', {
                    cls: 'clickable-icon apd-colour-remove',
                    attr: { 'aria-label': `Remove ${entry.name || 'colour'}` },
                });
                setIcon(remove, 'trash-2');
                remove.addEventListener('click', () => {
                    colours = colours.filter((_, i) => i !== index);
                    this.save(collectionId, colours);
                    render();
                });
            });

            const add = root.createEl('button', { cls: 'apd-colour-add' });
            setIcon(add.createSpan(), 'plus');
            add.createSpan({ text: 'Add colour' });
            add.addEventListener('click', () => {
                const used = new Set(colours.map((entry) => entry.color));
                const color = SUGGESTED_COLORS.find((c) => !used.has(c)) ?? '#ffffff';
                colours = [...colours, { id: `color-${Date.now().toString(36)}`, name: '', color }];
                this.save(collectionId, colours);
                render();
            });
        };

        // Edits in place keep the focus in the field being typed in.
        const update = (index: number, partial: Partial<CollectionDiceColour>, redraw: boolean): void => {
            colours = colours.map((entry, i) => (i === index ? { ...entry, ...partial } : entry));
            this.save(collectionId, colours);
            if (redraw) render();
        };

        root.createEl('p', { cls: 'apd-hint', text: 'Loading…' });
        const known = this.peek(collectionId);
        if (known) {
            colours = known.slice();
            render();
        } else {
            void this.load(collectionId).then((loaded) => {
                if (gone) return;
                colours = loaded.slice();
                render();
            });
        }

        return () => {
            gone = true;
            // The dialog's Save button saves Atlas's settings only: what was typed is saved now.
            this.flush(collectionId);
            root.remove();
        };
    }
}
