/**
 * A fake `obsidian` module, swapped in for the real one by esbuild's `alias`
 * when building the browser harness. The plugin source is not modified and does
 * not know this exists.
 *
 * Design rule: implement only what the plugin actually calls, and make anything
 * else **throw loudly** rather than silently return undefined. The harness
 * starting up is then evidence that the plugin uses nothing outside this file.
 * When the plugin starts using a new Obsidian API, the harness breaks
 * immediately and says which one.
 */

// ---------------------------------------------------------------------------
// Registry the harness page reads back
// ---------------------------------------------------------------------------

export interface HarnessCommand {
    id: string;
    name: string;
    callback?: () => any;
}

export const harnessRegistry = {
    commands: [] as HarnessCommand[],
    ribbons: [] as { icon: string; title: string; callback: (evt: MouseEvent) => any; el: HTMLElement }[],
    settingTab: null as PluginSettingTab | null,
    views: new Map<string, unknown>(),
    notices: [] as string[],
    /** Set by the harness so Notice can render into the page. */
    onNotice: null as ((message: string) => void) | null,
    reset() {
        this.commands = [];
        this.ribbons = [];
        this.settingTab = null;
        this.views.clear();
        this.notices = [];
    }
};

function notImplemented(path: string): never {
    throw new Error(
        `[harness] The plugin used ${path}, which the Obsidian stub does not implement. ` +
        `Add it to harness/obsidian-stub.ts.`
    );
}

/** Wraps an object so any property the plugin reaches for that we did not stub throws. */
function loud<T extends object>(name: string, impl: T): T {
    return new Proxy(impl, {
        get(target, prop, receiver) {
            if (prop in target || typeof prop === 'symbol') {
                return Reflect.get(target, prop, receiver);
            }
            return notImplemented(`${name}.${String(prop)}`);
        }
    });
}

// ---------------------------------------------------------------------------
// Storage: localStorage stands in for the vault's config directory
// ---------------------------------------------------------------------------

const STORE_PREFIX = 'harness-vault:';

function readStore(path: string): string | null {
    return localStorage.getItem(STORE_PREFIX + path);
}

function writeStore(path: string, data: string): void {
    try {
        localStorage.setItem(STORE_PREFIX + path, data);
    } catch (error) {
        // A texture upload pushes about a megabyte of base64 through here.
        console.error(
            `[harness] Could not store ${path} — localStorage is full. ` +
            `The plugin will see this exactly as it would see a failed vault write.`,
            error
        );
        throw error;
    }
}

export const harnessStorage = {
    keys(): string[] {
        return Object.keys(localStorage)
            .filter((k) => k.startsWith(STORE_PREFIX))
            .map((k) => k.slice(STORE_PREFIX.length));
    },
    size(path: string): number {
        return readStore(path)?.length ?? 0;
    },
    clear(): void {
        for (const path of this.keys()) localStorage.removeItem(STORE_PREFIX + path);
    }
};

// ---------------------------------------------------------------------------
// App / Workspace / Vault
// ---------------------------------------------------------------------------

export class EventRef {
    constructor(public readonly name: string, public readonly callback: (...args: any[]) => any) {}
}

const workspaceListeners = new Map<string, Set<EventRef>>();

const workspace = loud('app.workspace', {
    on(name: string, callback: (...args: any[]) => any): EventRef {
        const ref = new EventRef(name, callback);
        if (!workspaceListeners.has(name)) workspaceListeners.set(name, new Set());
        workspaceListeners.get(name)!.add(ref);
        return ref;
    },
    offref(ref: EventRef): void {
        workspaceListeners.get(ref.name)?.delete(ref);
    },
    /** Harness-only: let the page fire a workspace event, e.g. layout-change. */
    trigger(name: string, ...args: any[]): void {
        workspaceListeners.get(name)?.forEach((ref) => ref.callback(...args));
    },
    /** Harness-only: how many listeners are registered, for leak checks. */
    listenerCount(name: string): number {
        return workspaceListeners.get(name)?.size ?? 0;
    },
    getLeavesOfType(_type: string): unknown[] {
        return [];
    },
    detachLeavesOfType(_type: string): void {
        // No views are ever mounted in the harness.
    },
    getRightLeaf(_split: boolean): null {
        return null;
    },
    revealLeaf(_leaf: unknown): void {
        // Unreachable while getLeavesOfType returns nothing.
    }
});

const adapter = loud('app.vault.adapter', {
    async exists(path: string): Promise<boolean> {
        return readStore(path) !== null;
    },
    async read(path: string): Promise<string> {
        const data = readStore(path);
        if (data === null) throw new Error(`[harness] No such file: ${path}`);
        return data;
    },
    async write(path: string, data: string): Promise<void> {
        writeStore(path, data);
    }
});

const vault = loud('app.vault', { adapter });

export class App {
    workspace = workspace;
    vault = vault;
}

export const harnessApp = loud('app', new App()) as App;

// ---------------------------------------------------------------------------
// Component / Plugin
// ---------------------------------------------------------------------------

export class Component {
    private _eventRefs: EventRef[] = [];
    private _cleanups: Array<() => any> = [];

    load(): void {}
    unload(): void {
        this._eventRefs.forEach((ref) => workspace.offref(ref));
        this._eventRefs = [];
        this._cleanups.forEach((fn) => fn());
        this._cleanups = [];
    }
    register(cb: () => any): void {
        this._cleanups.push(cb);
    }
    registerEvent(ref: EventRef): void {
        this._eventRefs.push(ref);
    }
    registerDomEvent(el: HTMLElement | Window | Document, type: string, cb: any, options?: any): void {
        (el as HTMLElement).addEventListener(type, cb, options);
        this.register(() => (el as HTMLElement).removeEventListener(type, cb, options));
    }
    registerInterval(id: number): number {
        this.register(() => window.clearInterval(id));
        return id;
    }
    addChild<T>(child: T): T {
        return child;
    }
}

export interface PluginManifest {
    id: string;
    name: string;
    version: string;
    dir: string;
}

export class Plugin extends Component {
    constructor(public app: App, public manifest: PluginManifest) {
        super();
    }

    async onload(): Promise<void> {}
    async onunload(): Promise<void> {}

    addCommand(command: HarnessCommand): HarnessCommand {
        harnessRegistry.commands.push(command);
        return command;
    }

    addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => any): HTMLElement {
        // main.ts keeps this element and calls .remove() on it, so it has to be
        // a real node in the document.
        const el = document.createElement('button');
        el.className = 'harness-ribbon';
        el.textContent = title;
        el.title = `${title}  (ribbon: ${icon})`;
        el.addEventListener('click', (evt) => callback(evt));
        harnessRegistry.ribbons.push({ icon, title, callback, el });
        document.getElementById('harness-ribbons')?.appendChild(el);
        return el;
    }

    addSettingTab(tab: PluginSettingTab): void {
        harnessRegistry.settingTab = tab;
    }

    registerView(type: string, ctor: unknown): void {
        harnessRegistry.views.set(type, ctor);
    }

    async loadData(): Promise<any> {
        const raw = readStore(`${this.manifest.dir}/data.json`);
        return raw === null ? null : JSON.parse(raw);
    }

    async saveData(data: unknown): Promise<void> {
        writeStore(`${this.manifest.dir}/data.json`, JSON.stringify(data));
    }
}

export class PluginSettingTab extends Component {
    containerEl: HTMLElement;

    constructor(public app: App, public plugin: Plugin) {
        super();
        this.containerEl = document.createElement('div');
        this.containerEl.className = 'harness-settings-tab';
    }

    display(): void {}
    hide(): void {}
}

// ---------------------------------------------------------------------------
// Views and modals — bundled because main.ts imports chat-view, never mounted
// ---------------------------------------------------------------------------

export class WorkspaceLeaf {}

export class ItemView extends Component {
    containerEl: HTMLElement;

    constructor(public leaf: WorkspaceLeaf) {
        super();
        this.containerEl = document.createElement('div');
        // Obsidian's view container has a header at [0] and the content at [1].
        this.containerEl.appendChild(document.createElement('div'));
        this.containerEl.appendChild(document.createElement('div'));
    }

    getViewType(): string {
        return 'harness-view';
    }
    getDisplayText(): string {
        return 'harness view';
    }
    async onOpen(): Promise<void> {}
    async onClose(): Promise<void> {}
}

export class Modal {
    containerEl: HTMLElement;
    contentEl: HTMLElement;
    titleEl: HTMLElement;

    constructor(public app: App) {
        this.containerEl = document.createElement('div');
        this.titleEl = document.createElement('div');
        this.contentEl = document.createElement('div');
        this.containerEl.appendChild(this.titleEl);
        this.containerEl.appendChild(this.contentEl);
    }

    open(): void {
        document.body.appendChild(this.containerEl);
        (this as any).onOpen?.();
    }
    close(): void {
        (this as any).onClose?.();
        this.containerEl.remove();
    }
}

// ---------------------------------------------------------------------------
// Notice
// ---------------------------------------------------------------------------

export class Notice {
    constructor(message: string | DocumentFragment, _duration?: number) {
        const text = typeof message === 'string' ? message : message.textContent ?? '';
        harnessRegistry.notices.push(text);
        console.info('[Notice]', text);
        harnessRegistry.onNotice?.(text);
    }
    setMessage(_message: string): this {
        return this;
    }
    hide(): void {}
}

// ---------------------------------------------------------------------------
// Settings controls
// ---------------------------------------------------------------------------

class BaseComponent {
    disabled = false;
    setDisabled(disabled: boolean): this {
        this.disabled = disabled;
        return this;
    }
}

export class ToggleComponent extends BaseComponent {
    /** The div Obsidian styles; is-enabled is what draws the "on" state. */
    toggleEl: HTMLElement;
    private inputEl: HTMLInputElement;
    private handler: ((value: boolean) => any) | null = null;

    constructor(containerEl: HTMLElement) {
        super();
        this.toggleEl = document.createElement('div');
        this.toggleEl.className = 'checkbox-container';

        this.inputEl = document.createElement('input');
        this.inputEl.type = 'checkbox';
        this.toggleEl.appendChild(this.inputEl);

        // app.css draws the knob on the container, so the click lands there.
        this.toggleEl.addEventListener('click', () => {
            if (this.disabled) return;
            this.setValue(!this.inputEl.checked);
            this.handler?.(this.inputEl.checked);
        });

        containerEl.appendChild(this.toggleEl);
    }

    setValue(value: boolean): this {
        this.inputEl.checked = value;
        this.toggleEl.classList.toggle('is-enabled', value);
        return this;
    }
    getValue(): boolean {
        return this.inputEl.checked;
    }
    onChange(handler: (value: boolean) => any): this {
        this.handler = handler;
        return this;
    }
    setDisabled(disabled: boolean): this {
        this.inputEl.disabled = disabled;
        this.toggleEl.classList.toggle('is-disabled', disabled);
        return super.setDisabled(disabled);
    }
}

export class SliderComponent extends BaseComponent {
    sliderEl: HTMLInputElement;
    private readout: HTMLElement;
    private handler: ((value: number) => any) | null = null;

    constructor(containerEl: HTMLElement) {
        super();
        const wrap = document.createElement('div');
        wrap.className = 'harness-slider';
        this.sliderEl = document.createElement('input');
        this.sliderEl.type = 'range';
        this.sliderEl.className = 'slider';
        this.readout = document.createElement('span');
        this.readout.className = 'harness-slider-value';
        wrap.appendChild(this.sliderEl);
        wrap.appendChild(this.readout);
        containerEl.appendChild(wrap);

        this.sliderEl.addEventListener('input', () => {
            const value = parseFloat(this.sliderEl.value);
            this.readout.textContent = String(value);
            this.handler?.(value);
        });
    }

    setLimits(min: number, max: number, step: number): this {
        this.sliderEl.min = String(min);
        this.sliderEl.max = String(max);
        this.sliderEl.step = String(step);
        return this;
    }
    setValue(value: number): this {
        this.sliderEl.value = String(value);
        this.readout.textContent = String(value);
        return this;
    }
    getValue(): number {
        return parseFloat(this.sliderEl.value);
    }
    setDynamicTooltip(): this {
        return this;
    }
    onChange(handler: (value: number) => any): this {
        this.handler = handler;
        return this;
    }
}

export class TextComponent extends BaseComponent {
    inputEl: HTMLInputElement;
    private handler: ((value: string) => any) | null = null;

    constructor(containerEl: HTMLElement) {
        super();
        this.inputEl = document.createElement('input');
        this.inputEl.type = 'text';
        this.inputEl.addEventListener('input', () => this.handler?.(this.inputEl.value));
        containerEl.appendChild(this.inputEl);
    }

    setPlaceholder(placeholder: string): this {
        this.inputEl.placeholder = placeholder;
        return this;
    }
    setValue(value: string): this {
        this.inputEl.value = value;
        return this;
    }
    getValue(): string {
        return this.inputEl.value;
    }
    onChange(handler: (value: string) => any): this {
        this.handler = handler;
        return this;
    }
}

export class ColorComponent extends BaseComponent {
    colorEl: HTMLInputElement;
    private handler: ((value: string) => any) | null = null;

    constructor(containerEl: HTMLElement) {
        super();
        this.colorEl = document.createElement('input');
        this.colorEl.type = 'color';
        this.colorEl.addEventListener('input', () => this.handler?.(this.colorEl.value));
        containerEl.appendChild(this.colorEl);
    }

    setValue(value: string): this {
        this.colorEl.value = value;
        return this;
    }
    getValue(): string {
        return this.colorEl.value;
    }
    onChange(handler: (value: string) => any): this {
        this.handler = handler;
        return this;
    }
}

export class ButtonComponent extends BaseComponent {
    buttonEl: HTMLButtonElement;

    constructor(containerEl: HTMLElement) {
        super();
        this.buttonEl = document.createElement('button');
        containerEl.appendChild(this.buttonEl);
    }

    setButtonText(text: string): this {
        this.buttonEl.textContent = text;
        return this;
    }
    setCta(): this {
        this.buttonEl.classList.add('mod-cta');
        return this;
    }
    setWarning(): this {
        this.buttonEl.classList.add('mod-warning');
        return this;
    }
    setClass(cls: string): this {
        this.buttonEl.classList.add(cls);
        return this;
    }
    setTooltip(tooltip: string): this {
        this.buttonEl.title = tooltip;
        return this;
    }
    setDisabled(disabled: boolean): this {
        this.buttonEl.disabled = disabled;
        return super.setDisabled(disabled);
    }
    onClick(handler: (evt: MouseEvent) => any): this {
        this.buttonEl.addEventListener('click', handler);
        return this;
    }
}

/** An icon button beside a setting's controls. */
export class ExtraButtonComponent extends BaseComponent {
    extraSettingsEl: HTMLElement;

    constructor(containerEl: HTMLElement) {
        super();
        this.extraSettingsEl = document.createElement('button');
        this.extraSettingsEl.classList.add('clickable-icon', 'extra-setting-button');
        containerEl.appendChild(this.extraSettingsEl);
    }

    setIcon(icon: string): this {
        setIcon(this.extraSettingsEl, icon);
        return this;
    }
    setTooltip(tooltip: string): this {
        this.extraSettingsEl.setAttribute('aria-label', tooltip);
        return this;
    }
    onClick(handler: () => any): this {
        this.extraSettingsEl.addEventListener('click', () => handler());
        return this;
    }
}

export class DropdownComponent extends BaseComponent {
    selectEl: HTMLSelectElement;
    private handler: ((value: string) => any) | null = null;

    constructor(containerEl: HTMLElement) {
        super();
        this.selectEl = document.createElement('select');
        this.selectEl.className = 'dropdown';
        this.selectEl.addEventListener('change', () => this.handler?.(this.selectEl.value));
        containerEl.appendChild(this.selectEl);
    }

    addOption(value: string, display: string): this {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = display;
        this.selectEl.appendChild(option);
        return this;
    }
    addOptions(options: Record<string, string>): this {
        for (const [value, display] of Object.entries(options)) this.addOption(value, display);
        return this;
    }
    setValue(value: string): this {
        this.selectEl.value = value;
        return this;
    }
    getValue(): string {
        return this.selectEl.value;
    }
    onChange(handler: (value: string) => any): this {
        this.handler = handler;
        return this;
    }
}

export class Setting {
    settingEl: HTMLElement;
    infoEl: HTMLElement;
    nameEl: HTMLElement;
    descEl: HTMLElement;
    controlEl: HTMLElement;

    constructor(containerEl: HTMLElement) {
        this.settingEl = document.createElement('div');
        this.settingEl.className = 'setting-item';

        this.infoEl = document.createElement('div');
        this.infoEl.className = 'setting-item-info';
        this.nameEl = document.createElement('div');
        this.nameEl.className = 'setting-item-name';
        this.descEl = document.createElement('div');
        this.descEl.className = 'setting-item-description';
        this.infoEl.appendChild(this.nameEl);
        this.infoEl.appendChild(this.descEl);

        this.controlEl = document.createElement('div');
        this.controlEl.className = 'setting-item-control';

        this.settingEl.appendChild(this.infoEl);
        this.settingEl.appendChild(this.controlEl);
        containerEl.appendChild(this.settingEl);
    }

    setName(name: string): this {
        this.nameEl.textContent = name;
        return this;
    }
    setDesc(desc: string): this {
        this.descEl.textContent = desc;
        return this;
    }
    setHeading(): this {
        this.settingEl.classList.add('setting-item-heading');
        return this;
    }
    setClass(cls: string): this {
        this.settingEl.classList.add(cls);
        return this;
    }
    setTooltip(tooltip: string): this {
        this.settingEl.title = tooltip;
        return this;
    }
    setDisabled(disabled: boolean): this {
        this.settingEl.classList.toggle('is-disabled', disabled);
        return this;
    }
    addToggle(cb: (component: ToggleComponent) => any): this {
        cb(new ToggleComponent(this.controlEl));
        return this;
    }
    addSlider(cb: (component: SliderComponent) => any): this {
        cb(new SliderComponent(this.controlEl));
        return this;
    }
    addText(cb: (component: TextComponent) => any): this {
        cb(new TextComponent(this.controlEl));
        return this;
    }
    addColorPicker(cb: (component: ColorComponent) => any): this {
        cb(new ColorComponent(this.controlEl));
        return this;
    }
    addButton(cb: (component: ButtonComponent) => any): this {
        cb(new ButtonComponent(this.controlEl));
        return this;
    }
    addExtraButton(cb: (component: ExtraButtonComponent) => any): this {
        cb(new ExtraButtonComponent(this.controlEl));
        return this;
    }
    addDropdown(cb: (component: DropdownComponent) => any): this {
        cb(new DropdownComponent(this.controlEl));
        return this;
    }
}

// ---------------------------------------------------------------------------
// Free functions
// ---------------------------------------------------------------------------

export interface Debouncer<T extends unknown[], V> {
    (...args: T): void;
    cancel(): this;
    run(): V | void;
}

/**
 * Obsidian's debounce. Fidelity matters here: get the timing wrong and the
 * harness will show save-coalescing bugs that do not exist in the real plugin.
 *
 * `resetTimer` restarts the countdown on every call; without it the first call
 * starts a countdown that later calls do not extend. Either way the callback
 * runs on the trailing edge.
 */
export function debounce<T extends unknown[], V>(
    cb: (...args: T) => V,
    timeout = 0,
    resetTimer = false
): Debouncer<T, V> {
    let timer: number | null = null;
    let pending: T | null = null;

    const fire = () => {
        timer = null;
        if (!pending) return;
        const args = pending;
        pending = null;
        return cb(...args);
    };

    const debounced = ((...args: T) => {
        pending = args;
        if (timer !== null) {
            if (!resetTimer) return;
            window.clearTimeout(timer);
        }
        timer = window.setTimeout(fire, timeout);
    }) as Debouncer<T, V>;

    debounced.cancel = function () {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        pending = null;
        return this;
    };

    debounced.run = function () {
        if (timer !== null) window.clearTimeout(timer);
        return fire();
    };

    return debounced;
}

export function normalizePath(path: string): string {
    return path
        .replace(/([\\/])+/g, '/')
        .replace(/(^\/+|\/+$)/g, '')
        .replace(/ | /g, ' ');
}

export const Platform = {
    isDesktop: true,
    isDesktopApp: false,
    isMobile: false,
    isMobileApp: false
};

export function setIcon(el: HTMLElement, icon: string): void {
    el.setAttribute('data-icon', icon);
}

/** A menu item, as Menu.addItem hands it over. */
export class MenuItem {
    dom: HTMLElement;
    iconEl: HTMLElement;
    private titleEl: HTMLElement;
    private handler: (() => any) | null = null;
    disabled = false;

    constructor() {
        this.dom = document.createElement('div');
        this.dom.className = 'menu-item';
        this.iconEl = document.createElement('span');
        this.iconEl.className = 'menu-item-icon';
        this.titleEl = document.createElement('span');
        this.titleEl.className = 'menu-item-title';
        this.dom.append(this.iconEl, this.titleEl);
        this.dom.addEventListener('click', () => {
            if (!this.disabled) this.handler?.();
            this.dom.closest('.menu')?.remove();
        });
    }

    setTitle(title: string): this {
        this.titleEl.textContent = title;
        return this;
    }
    setIcon(icon: string): this {
        setIcon(this.iconEl, icon);
        return this;
    }
    setDisabled(disabled: boolean): this {
        this.disabled = disabled;
        this.dom.classList.toggle('is-disabled', disabled);
        return this;
    }
    onClick(handler: () => any): this {
        this.handler = handler;
        return this;
    }
}

/** A context menu: a list of items shown at the pointer, gone after a pick. */
export class Menu {
    dom: HTMLElement;

    constructor() {
        this.dom = document.createElement('div');
        this.dom.className = 'menu';
        this.dom.style.cssText = 'position:fixed;z-index:10000;background:var(--background-primary);border:1px solid var(--background-modifier-border);padding:4px;border-radius:8px;';
    }

    addItem(cb: (item: MenuItem) => any): this {
        const item = new MenuItem();
        cb(item);
        this.dom.appendChild(item.dom);
        return this;
    }
    addSeparator(): this {
        const separator = document.createElement('div');
        separator.className = 'menu-separator';
        this.dom.appendChild(separator);
        return this;
    }
    showAtMouseEvent(event: MouseEvent): this {
        return this.showAtPosition({ x: event.clientX, y: event.clientY });
    }
    showAtPosition(position: { x: number; y: number }): this {
        document.querySelectorAll('.menu').forEach((menu) => menu.remove());
        this.dom.style.left = `${position.x}px`;
        this.dom.style.top = `${position.y}px`;
        document.body.appendChild(this.dom);
        return this;
    }
    hide(): this {
        this.dom.remove();
        return this;
    }
}
