/**
 * Browser harness.
 *
 * This boots the *real* plugin — the same `main.ts`, `d20-dice.ts`,
 * `settings.ts` and `styles.css` that Obsidian loads — against a fake
 * `obsidian` module. There is no second copy of any dice or settings code, so
 * a change to the plugin is a change to the harness by construction.
 *
 * What is genuinely identical: the dice engine, the physics, the overlay panel,
 * the settings tab and all the stylesheet.
 * What is not: Obsidian's own chrome, and Chromium here versus Electron there.
 * Treat this as fast, high-confidence iteration; confirm the last mile in a
 * real vault.
 */

import { installDomShim } from './dom-shim';

// The DOM helpers have to exist before any plugin module body runs.
installDomShim();

import D20DicePlugin from '../main';
import { DEFAULT_SETTINGS } from '../settings';
import {
    harnessApp,
    harnessRegistry,
    harnessStorage,
    PluginManifest
} from './obsidian-stub';
import { installCounters, probe, resetCounters, HarnessProbe } from './instrument';

installCounters();

const MANIFEST: PluginManifest = {
    id: 'atlas-physical-dice',
    name: 'Physical Dice',
    version: '1.0.0',
    dir: '.obsidian/plugins/obsidian-physical-dice-main'
};

const DICE_TYPES = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20'] as const;

let plugin: D20DicePlugin | null = null;

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

const el = {
    ribbons: document.getElementById('harness-ribbons')!,
    commands: document.getElementById('harness-commands')!,
    stats: document.getElementById('harness-stats')!,
    dice: document.getElementById('harness-dice')!,
    settings: document.getElementById('harness-settings')!,
    notices: document.getElementById('harness-notices')!,
    storage: document.getElementById('harness-storage')!
};

harnessRegistry.onNotice = (message) => {
    const item = document.createElement('div');
    item.className = 'harness-notice';
    item.textContent = message;
    el.notices.prepend(item);
    window.setTimeout(() => item.remove(), 6000);
};

function button(parent: HTMLElement, label: string, onClick: () => any): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'harness-button';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    parent.appendChild(btn);
    return btn;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Prime the fake vault from the real one.
 *
 * The server root is the plugin directory, so the actual `data.json` and
 * `textures.json` are a fetch away. Without this the harness starts on
 * DEFAULT_SETTINGS, which has no face textures — the dice come out plain
 * coloured solids and look nothing like they do in the vault.
 *
 * Only runs when the fake vault is empty, so anything changed in the harness
 * afterwards sticks. `wipe storage` re-seeds.
 */
async function seedVaultFromRealPlugin(): Promise<void> {
    const already = harnessStorage.keys().some((k) => k.endsWith('data.json'));
    if (already) return;

    for (const file of ['data.json', 'textures.json']) {
        try {
            const response = await fetch(`/${file}`, { cache: 'no-store' });
            if (!response.ok) continue;
            const text = await response.text();
            JSON.parse(text);   // don't seed something that will not parse
            localStorage.setItem(`harness-vault:${MANIFEST.dir}/${file}`, text);
            console.info(`[harness] seeded ${file} from the real plugin (${(text.length / 1024).toFixed(0)} KB)`);
        } catch (error) {
            console.warn(
                `[harness] could not seed ${file}; starting from DEFAULT_SETTINGS. ` +
                `Dice will have no textures.`,
                error
            );
        }
    }
}

async function boot(): Promise<void> {
    await seedVaultFromRealPlugin();

    el.ribbons.replaceChildren();
    el.commands.replaceChildren();
    el.settings.replaceChildren();
    harnessRegistry.reset();
    harnessRegistry.onNotice = harnessRegistry.onNotice;

    // The one place the two type worlds meet. tsc resolves `obsidian` to the
    // real package, so the plugin is type-checked against the real API; the
    // stub only stands in at bundle time and is deliberately partial. Casting
    // here rather than widening the stub keeps that check meaningful — if the
    // plugin starts calling something unstubbed, the Proxy throws at runtime
    // and names it, which is more useful than a structural type error here.
    plugin = new D20DicePlugin(harnessApp as any, MANIFEST as any);
    await plugin.onload();

    // The plugin's ribbons appended themselves; mirror its commands too.
    for (const command of harnessRegistry.commands) {
        button(el.commands, command.name, () => command.callback?.());
    }

    // Mount the real settings tab. Its controls drive the plugin's own
    // onChange handlers, so a settings bug reproduces here exactly.
    const tab = harnessRegistry.settingTab;
    if (tab) {
        el.settings.appendChild(tab.containerEl);
        tab.display();
    }

    console.info(
        '%c[harness] plugin loaded. Try window.__dice — probe(), roll(), add("d20"), open(), reset().',
        'color:#4a9'
    );
}

async function reboot(): Promise<void> {
    if (plugin) {
        await plugin.onunload();
        plugin.unload();
    }
    document.querySelectorAll('.dice-floating-overlay').forEach((node) => node.remove());
    resetCounters();
    await boot();
}

// ---------------------------------------------------------------------------
// Dev panel: live readout
// ---------------------------------------------------------------------------

function renderStats(): void {
    const p = probe(plugin);

    el.stats.replaceChildren();
    const rows: Array<[string, string, boolean?]> = [
        ['overlay', p.overlayOpen ? 'open' : 'closed'],
        ['rAF loop', p.loopRunning ? 'RUNNING' : 'stopped', p.loopRunning],
        ['draws/s', String(p.drawsPerSecond), p.drawsPerSecond > 0],
        ['steps/s', String(p.stepsPerSecond), p.stepsPerSecond > 0],
        ['dice', String(p.diceCount)],
        ['world bodies', `${p.worldBodies} (tray ${p.trayBodies})`],
        ['scene objects', String(p.sceneObjects)],
        ['dragging', p.dragging ? 'yes' : 'no'],
        ['rolling', p.rolling ? 'yes' : 'no']
    ];

    for (const [label, value, hot] of rows) {
        const row = document.createElement('div');
        row.className = 'harness-stat' + (hot ? ' is-hot' : '');
        row.innerHTML = '';
        const k = document.createElement('span');
        k.className = 'harness-stat-key';
        k.textContent = label;
        const v = document.createElement('span');
        v.className = 'harness-stat-value';
        v.textContent = value;
        row.appendChild(k);
        row.appendChild(v);
        el.stats.appendChild(row);
    }

    el.dice.replaceChildren();
    for (const d of p.dice) {
        const row = document.createElement('div');
        row.className = 'harness-die';
        const shadow = d.shadow
            ? `${d.shadow.visible ? 'on' : 'off'} α${d.shadow.opacity} ×${d.shadow.scale}`
            : 'none';
        row.textContent =
            `${d.index} ${d.type}  y=${d.position.y}  v=${d.speed}  ${d.sleepState}  shadow ${shadow}`;
        row.classList.toggle('is-asleep', d.sleepState === 'SLEEPING');
        el.dice.appendChild(row);
    }

    const keys = harnessStorage.keys();
    el.storage.textContent = keys.length
        ? keys.map((k) => `${k.split('/').pop()} — ${(harnessStorage.size(k) / 1024).toFixed(1)} KB`).join('\n')
        : 'nothing stored yet';
}

// Deliberately on a timer rather than rAF: a rAF-driven readout would itself
// keep the page busy and mask the very thing being measured.
window.setInterval(renderStats, 250);

// ---------------------------------------------------------------------------
// Console API
// ---------------------------------------------------------------------------

const api = {
    /** Everything the dev panel shows, as an object. */
    probe(): HarnessProbe {
        return probe(plugin);
    },
    /** One-line summary, handy for reading out of the console. */
    summary(): string {
        const p = probe(plugin);
        return [
            `overlay=${p.overlayOpen ? 'open' : 'closed'}`,
            `loop=${p.loopRunning ? 'RUNNING' : 'stopped'}`,
            `draws/s=${p.drawsPerSecond}`,
            `steps/s=${p.stepsPerSecond}`,
            `dice=${p.diceCount}`,
            `sleep=[${p.dice.map((d) => d.sleepState[0]).join('')}]`
        ].join(' ');
    },
    get plugin() {
        return plugin as any;
    },
    /** The live D20Dice instance, or null when the overlay is closed. */
    get engine() {
        return (plugin as any)?.dice ?? null;
    },
    get settings() {
        return (plugin as any)?.settings ?? null;
    },
    open(): void {
        if (!(plugin as any)?.isVisible) harnessRegistry.ribbons[0]?.callback(new MouseEvent('click'));
    },
    close(): void {
        if ((plugin as any)?.isVisible) harnessRegistry.ribbons[0]?.callback(new MouseEvent('click'));
    },
    add(type: string, count = 1): void {
        api.open();
        const engine = api.engine;
        for (let i = 0; i < count; i++) engine?.createSingleDice(type);
    },
    clear(): void {
        api.engine?.clearAllDice();
    },
    async roll(): Promise<string | undefined> {
        return api.engine?.roll();
    },
    /**
     * Advance the dice by `frames` frames without waiting for rAF.
     *
     * Chrome suspends requestAnimationFrame in a tab that is not visible, and
     * an automated browser tab usually is not — so the whole render loop
     * freezes and nothing can be checked. Pumping the loop by hand sidesteps
     * that, and is better than rAF for verification anyway: fixed timesteps,
     * no timing flake, and a run that means the same thing every time.
     *
     * This calls the plugin's real animate(), so physics, the sleep check, the
     * transform copy, the blob update and the draw all happen exactly as they
     * would on a frame. Only the clock is synthetic.
     */
    pump(frames = 60, dtMs = 1000 / 60): number {
        const engine = api.engine;
        if (!engine) return 0;

        let drawn = 0;
        for (let i = 0; i < frames; i++) {
            // animate() re-arms rAF at the end of every frame; those callbacks
            // will never fire in a hidden tab, so drop them rather than let
            // thousands queue up.
            if (engine.animationId !== null) {
                cancelAnimationFrame(engine.animationId);
                engine.animationId = null;
            }
            engine.lastFrameTime = performance.now() - dtMs;
            engine.animate();
            drawn++;
        }
        if (engine.animationId !== null) {
            cancelAnimationFrame(engine.animationId);
            engine.animationId = null;
        }
        return drawn;
    },
    /**
     * Roll, pump the physics to a standstill, then wait out the settle monitor.
     *
     * Worth knowing why both waits are needed: pumping advances the *physics*
     * clock as fast as the CPU allows, but startIndividualDiceMonitoring() polls
     * on setTimeout and requires two seconds of **wall-clock** stability before
     * it will read a face. So the dice can be fast asleep while the roll has not
     * resolved yet, and a test that only pumps will see an empty result and
     * conclude something is broken.
     */
    async rollAndWait(maxFrames = 3000): Promise<{ result: string; frames: number; settled: boolean }> {
        const engine = api.engine;
        if (!engine) return { result: '', frames: 0, settled: false };

        const rolled = engine.roll() as Promise<string>;
        const settle = api.settle(maxFrames);
        const result = await Promise.race([
            rolled,
            new Promise<string>((resolve) => window.setTimeout(() => resolve('(timed out)'), 20000))
        ]);
        return { result, frames: settle.frames, settled: settle.settled };
    },
    /**
     * Pump until every die is asleep, or `maxFrames` runs out. Returns the
     * frame count, which is the honest measure of "how long until the loop
     * would have stopped".
     */
    settle(maxFrames = 1200): { frames: number; settled: boolean } {
        const engine = api.engine;
        if (!engine) return { frames: 0, settled: true };

        for (let i = 0; i < maxFrames; i++) {
            api.pump(1);
            const awake = engine.diceBodyArray.some((b: any) => b && b.sleepState !== 2);
            if (!awake) return { frames: i + 1, settled: true };
        }
        return { frames: maxFrames, settled: false };
    },
    /** Change one setting and push it through the plugin's own refresh path. */
    set(key: string, value: unknown): void {
        const p = plugin as any;
        if (!p) return;
        p.settings[key] = value;
        p.saveSettings();
        p.refreshDiceView();
    },
    /** Reload the plugin without reloading the page. */
    reboot,
    /** Wipe the fake vault, then reboot with stock settings. */
    async reset(): Promise<void> {
        harnessStorage.clear();
        await reboot();
    },
    /** Fire an Obsidian workspace event, e.g. 'layout-change'. */
    trigger(name: string, ...args: unknown[]): void {
        (harnessApp.workspace as any).trigger(name, ...args);
    },
    /** Listener count for a workspace event — for checking cleanup. */
    listenerCount(name: string): number {
        return (harnessApp.workspace as any).listenerCount(name);
    },
    storage: harnessStorage,
    notices: harnessRegistry.notices,
    DEFAULT_SETTINGS,
    DICE_TYPES
};

(window as any).__dice = api;

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pop-out behaviour
// ---------------------------------------------------------------------------

/**
 * Same gesture as the plugin's own controls panel: press the handle, move,
 * release. Kept clamped to the window so a panel can never be dragged out of
 * reach, and the listeners live on document because the pointer routinely
 * leaves the handle mid-drag.
 */
function makeDraggable(panel: HTMLElement): void {
    const handle = panel.querySelector<HTMLElement>('[data-drag]');
    if (!handle) return;

    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    handle.addEventListener('mousedown', (e) => {
        const rect = panel.getBoundingClientRect();
        dragging = true;
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
        // Switch from right-anchored to left-anchored on first drag, or the
        // panel jumps as soon as it is moved.
        panel.style.left = `${rect.left}px`;
        panel.style.right = 'auto';
        handle.style.cursor = 'grabbing';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const maxX = window.innerWidth - panel.offsetWidth;
        const maxY = window.innerHeight - 40;
        panel.style.left = `${Math.max(0, Math.min(e.clientX - offsetX, maxX))}px`;
        panel.style.top = `${Math.max(0, Math.min(e.clientY - offsetY, maxY))}px`;
    });

    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        handle.style.cursor = 'grab';
    });
}

const harnessPanel = document.getElementById('harness-panel')!;
const settingsPopout = document.getElementById('harness-settings-popout')!;

// Right-hand side by default so the plugin's own panel keeps its spot at
// left:50px. Both are draggable from there.
harnessPanel.style.top = '48px';
harnessPanel.style.right = '16px';
settingsPopout.style.top = '48px';
settingsPopout.style.right = '332px';

makeDraggable(harnessPanel);
makeDraggable(settingsPopout);

// Deliberately no "add dice" / "roll" / "clear" buttons here. Those live in the
// plugin's own floating controls panel, which the harness renders for real —
// duplicating them would mean testing the copy instead of the thing that ships.
const controls = document.getElementById('harness-quick')!;
button(controls, 'settings', () => {
    settingsPopout.hidden = !settingsPopout.hidden;
});
button(controls, 'reboot plugin', () => reboot());
button(controls, 'wipe storage', () => api.reset());
button(controls, 'pump 60', () => api.pump(60));
button(controls, 'settle', () => {
    const r = api.settle();
    console.info(`[harness] settled=${r.settled} after ${r.frames} frames`);
});

// Hide both pop-outs to see the overlay exactly as Obsidian shows it.
const toggle = document.getElementById('harness-toggle')!;
const setCollapsed = (collapsed: boolean) => {
    document.body.classList.toggle('harness-collapsed', collapsed);
    // The overlay sizes itself from window.innerWidth, so there is nothing to
    // tell it — but the plugin re-measures on layout-change, same as in Obsidian.
    (harnessApp.workspace as any).trigger('layout-change');
};
toggle.addEventListener('click', () => setCollapsed(!document.body.classList.contains('harness-collapsed')));
window.addEventListener('keydown', (e) => {
    if (e.key === '\\' && !(e.target instanceof HTMLInputElement)) {
        setCollapsed(!document.body.classList.contains('harness-collapsed'));
    }
});

boot().catch((error) => {
    console.error('[harness] boot failed', error);
    document.body.createDiv({ cls: 'harness-fatal', text: `Boot failed: ${error.message}` });
});
