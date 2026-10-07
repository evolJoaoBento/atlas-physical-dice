import type { Plugin } from 'obsidian';
import type { RolledDie } from './d20-dice';

/**
 * Hands settled rolls to Atlas VTT, and holds the plugin's connection to
 * Atlas's extension API for everything else (dice looks, the dice packs tab,
 * dice colours).
 *
 * Atlas (extension API 1.x) publishes `app.plugins.plugins['atlas-vtt'].api`
 * once it is ready and announces it with the workspace event
 * `atlas-vtt:api-ready`. When the API is there, rolls go through
 * `dice.publish`. An Atlas without it still listens for one DOM event on the
 * main window's document, so that stays the way a roll is sent whenever the API
 * is missing, too old, or has no `dice` namespace. Nothing happens, and
 * nothing throws, when Atlas is not installed at all.
 *
 * Everything is feature-detected: the API's own `has()` where it names the
 * capability, and the presence of the function otherwise.
 */
const ATLAS_DICE_EVENT = 'atlas-dice-rolled';
const ATLAS_PLUGIN_ID = 'atlas-vtt';
const API_READY = 'atlas-vtt:api-ready';
const API_UNLOAD = 'atlas-vtt:api-unload';
/** The API's major version this plugin was written against. */
const API_MAJOR = 1;

/** Shape of Atlas' `DiceRollResult` (docs/extension-api.md, `dice.publish`). */
export interface AtlasDiceRoll {
    id: string;
    timestamp: number;
    formula: string;
    /** `color` and `colorName` are the die's tag: its colour, for an Atlas that shows it. */
    rolls: Array<{ die: string; value: number; max: number; color?: string; colorName?: string }>;
    modifiers: number;
    total: number;
    player?: string;
    source?: { type: 'toolbar' | 'statblock' };
}

export type Disposer = () => void;
export type LookDieSides = 4 | 6 | 8 | 10 | 12 | 20 | 100;
export type FaceArt = Readonly<Record<number, ImageBitmap | HTMLCanvasElement | string>>;

/** Atlas's `DiceLookSpec`, as far as this plugin uses it. */
export interface DiceLookSpec {
    id: string;
    name: string;
    faces(sides: LookDieSides): Promise<FaceArt>;
    bump?(sides: LookDieSides): Promise<FaceArt>;
    body?: { colour?: string; ink?: string };
    preview?: string;
    /** API 1.18.0: `'face'` draws the art over the whole face cell. */
    fill?: 'numeral' | 'face';
}

/** Atlas's `DiceColour`: a colour dice can be rolled in. */
export interface AtlasDiceColour {
    name: string;
    color: string;
}

/** Atlas's `DiceLookInEffect`. */
export interface AtlasLookInEffect {
    lookId: string;
    from: 'collection' | 'default';
    loaded: boolean;
}

export interface AtlasTabSpec {
    id: string;
    title: string;
    icon: string;
    mount(container: HTMLElement, ctx: { collectionId: string }): Disposer;
}

/** The slice of Atlas's `AtlasExtension` this plugin touches. All of it optional: an older Atlas lacks parts. */
export interface AtlasExtensionLike {
    readonly id?: string;
    dice?: {
        publish?(result: AtlasDiceRoll, options?: { throw?: boolean }): void;
        registerLook?(spec: DiceLookSpec): Disposer;
        registerColours?(provider: (collectionId: string) => readonly AtlasDiceColour[]): Disposer;
        useLook?(lookId: string | null, options?: { collectionId?: string }): Promise<void>;
        lookFor?(collectionId?: string | null): Promise<AtlasLookInEffect>;
    };
    ui?: {
        addAssetTab?(tab: AtlasTabSpec): Disposer;
        addCollectionSettingsTab?(tab: AtlasTabSpec): Disposer;
        invalidate?(): void;
    };
    collections?: {
        list?(): Promise<Array<{ id: string; name: string }>>;
        getData?(collectionId: string): Promise<unknown>;
        setData?(collectionId: string, value: unknown): Promise<void>;
    };
    views?: {
        active?(): { mapPath: string | null } | null;
    };
    rules?: {
        forMap?(mapPath: string | null): { collectionId: string | null };
    };
    on?(event: string, listener: (...args: unknown[]) => void): Disposer;
}

interface AtlasApiLike {
    version?: string;
    has?(capability: string): boolean;
    connect?(plugin: Pick<Plugin, 'manifest' | 'register'>): AtlasExtensionLike;
}

const DIE_ORDER = ['d4', 'd6', 'd8', 'd10', 'd100', 'd12', 'd20'];

/** `2d6 + 1d20`, dice grouped by type in the order the overlay reports them. */
function formulaOf(dice: RolledDie[]): string {
    const counts = new Map<string, number>();
    for (const die of dice) counts.set(die.type, (counts.get(die.type) ?? 0) + 1);
    return [...counts.keys()]
        .sort((a, b) => DIE_ORDER.indexOf(a) - DIE_ORDER.indexOf(b))
        .map((type) => `${counts.get(type)}${type}`)
        .join(' + ');
}

/** Faces on a die type: `d20` has 20. */
function sidesOf(type: string): number {
    return parseInt(type.slice(1), 10) || 0;
}

/** Characters Atlas refuses in a tag name: markup, backticks, control and invisible formatting. */
function refusedInTagName(text: string): boolean {
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if ('<>[]`'.indexOf(text.charAt(i)) >= 0) return true;
        // Control characters, then invisible formatting: soft hyphen, zero-width and
        // direction marks, line and paragraph separators, word joiners, the BOM.
        if (c < 32 || (c >= 127 && c <= 159) || c === 173 || (c >= 8203 && c <= 8207)
            || (c >= 8232 && c <= 8238) || (c >= 8288 && c <= 8292) || c === 65279) return true;
    }
    return false;
}

/** A tag colour Atlas keeps: `#rrggbb`. Anything else is left off the die. */
export function cleanTagColor(color: unknown): string | undefined {
    return typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color) ? color : undefined;
}

/** A tag name Atlas keeps: plain text, trimmed, at most 32 characters. */
export function cleanTagName(name: unknown): string | undefined {
    if (typeof name !== 'string') return undefined;
    const trimmed = name.trim();
    return trimmed && trimmed.length <= 32 && !refusedInTagName(trimmed) ? trimmed : undefined;
}

/** A settled die, with the name of its colour when it was added in one. */
export type AtlasRolledDie = RolledDie & { colorName?: string | null };

export function toAtlasRoll(dice: AtlasRolledDie[], now = Date.now()): AtlasDiceRoll {
    return {
        id: `physical_${now}_${Math.random().toString(36).slice(2, 8)}`,
        timestamp: now,
        formula: formulaOf(dice),
        rolls: dice.map((die) => {
            const rolled: AtlasDiceRoll['rolls'][number] = { die: die.type, value: die.value, max: sidesOf(die.type) };
            // A tagged die (a colour, a name) carries it to Atlas, which only shows it.
            const color = cleanTagColor(die.color);
            const colorName = cleanTagName(die.colorName);
            if (color) rolled.color = color;
            if (colorName) rolled.colorName = colorName;
            return rolled;
        }),
        modifiers: 0,
        // The same total the overlay shows, so both always agree.
        total: dice.reduce((sum, die) => sum + die.value, 0),
        player: 'Atlas VTT Physical Dice',
        source: { type: 'toolbar' },
    };
}

/**
 * The plugin's connection to Atlas's extension API, when there is one.
 *
 * Atlas may be ready before this plugin loads, load after it, or reload while
 * both run, so the link looks once and then listens for `api-ready`. Each
 * feature listens with `onChange` and registers again from scratch whenever the
 * connection is made or lost.
 */
export class AtlasLink {
    private api: AtlasApiLike | null = null;
    private ext: AtlasExtensionLike | null = null;
    private dropUnload: Disposer | null = null;
    private readonly listeners = new Set<() => void>();

    constructor(private readonly plugin: Plugin) {}

    start(): void {
        const workspace = this.plugin.app.workspace;
        this.plugin.registerEvent(workspace.on(API_READY as never, ((api: AtlasApiLike) => this.bind(api)) as never));
        this.plugin.registerEvent(workspace.on(API_UNLOAD as never, (() => this.unbind()) as never));
        const plugins = (this.plugin.app as unknown as { plugins?: { plugins?: Record<string, { api?: AtlasApiLike }> } }).plugins;
        const api = plugins?.plugins?.[ATLAS_PLUGIN_ID]?.api;
        if (api) this.bind(api);
    }

    /** Be told when a connection is made or lost, so registrations can be made again or let go. */
    onChange(listener: () => void): void {
        this.listeners.add(listener);
    }

    /** Atlas's handle for this plugin, or null: no Atlas, or a different major version. */
    get extension(): AtlasExtensionLike | null {
        return this.ext;
    }

    /** Atlas's `dice` namespace, or null: no Atlas, a different major version, or an API without dice. */
    get dice(): AtlasExtensionLike['dice'] | null {
        return this.ext?.dice ?? null;
    }

    /** The id Atlas knows this plugin by: the prefix of its full look ids. */
    get extensionId(): string {
        return this.ext?.id || this.plugin.manifest.id;
    }

    /** Whether the running Atlas has the capability. False for any doubt. */
    has(capability: string): boolean {
        try {
            return !!this.api && typeof this.api.has === 'function' && this.api.has(capability) === true;
        } catch {
            return false;
        }
    }

    /** Hear an Atlas event while connected. The listener goes with the connection. */
    listen(event: string, listener: () => void): Disposer {
        const ext = this.ext;
        if (!ext || typeof ext.on !== 'function') return () => {};
        try {
            return ext.on(event, listener);
        } catch (error) {
            console.warn(`Atlas VTT Physical Dice: could not listen for ${event}:`, error);
            return () => {};
        }
    }

    /** Ask Atlas to read its menus, providers and badges again. */
    invalidate(): void {
        try { this.ext?.ui?.invalidate?.(); } catch { /* nothing to refresh */ }
    }

    private bind(api: AtlasApiLike): void {
        this.unbind(false);
        try {
            if (!api || Number.parseInt(String(api.version), 10) !== API_MAJOR || typeof api.connect !== 'function') {
                this.notify();
                return;
            }
            this.api = api;
            this.ext = api.connect(this.plugin);
            // Atlas is unloading: let go of what we hold and wait for the next api-ready.
            if (typeof this.ext?.on === 'function') {
                this.dropUnload = this.ext.on('unload', () => this.unbind());
            }
        } catch (error) {
            console.warn('Atlas VTT Physical Dice: could not connect to Atlas:', error);
            this.api = null;
            this.ext = null;
        }
        this.notify();
    }

    private unbind(notify = true): void {
        try { this.dropUnload?.(); } catch { /* already gone */ }
        this.dropUnload = null;
        this.api = null;
        this.ext = null;
        if (notify) this.notify();
    }

    private notify(): void {
        for (const listener of this.listeners) {
            try { listener(); } catch (error) { console.warn('Atlas VTT Physical Dice:', error); }
        }
    }
}

/** Where rolls go: set once by the plugin, so a roll sent from anywhere uses the same link. */
let link: AtlasLink | null = null;

export function useAtlasLink(next: AtlasLink | null): void {
    link = next;
}

/** The roll as a DOM event on the main window's document: what an Atlas without the API listens to. */
function dispatchRollEvent(roll: AtlasDiceRoll): void {
    // Atlas listens on the main window's document, so this deliberately uses
    // `document` rather than `activeDocument`, which is a popout's while it has focus.
    document.dispatchEvent(new CustomEvent(ATLAS_DICE_EVENT, { detail: roll }));
}

export function sendRollToAtlas(dice: AtlasRolledDie[]): void {
    if (dice.length === 0) return;
    const roll = toAtlasRoll(dice);
    const namespace = link?.dice;
    if (namespace && typeof namespace.publish === 'function') {
        try {
            // These dice were already thrown on screen, so Atlas only logs the roll
            // (API 1.16+; an older Atlas ignores the option).
            namespace.publish(roll, { throw: false });
            return;
        } catch (error) {
            // Atlas refused the roll before logging anything, so the old route cannot double it.
            console.warn('Atlas VTT Physical Dice: dice.publish failed, sending the roll as an event instead:', error);
        }
    }
    dispatchRollEvent(roll);
}
