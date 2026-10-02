import { Plugin, Notice, debounce, setIcon, Platform, FileSystemAdapter } from 'obsidian';
import { D20Dice, DicePack, type RolledDie } from './d20-dice';
import { DiceSettings, DEFAULT_SETTINGS, DiceSettingTab, type DiceColor } from './settings';
import { sendRollToAtlas } from './atlas-bridge';
import { appendDiceIcon } from './dice-icons';
import { ensureDefaultPack } from './default-pack';

/** The slice of Electron's renderer API the packs-folder button uses. */
interface ElectronWindow {
    require(module: 'electron'): { shell: { openPath(path: string): Promise<string> } };
}

export default class D20DicePlugin extends Plugin {
    settings: DiceSettings;
    private diceOverlay: HTMLElement | null = null;
    private dice: D20Dice | null = null;
    /** Closes the column of colours a right-click opened over a die, when one is showing. */
    private closeColorPicker: (() => void) | null = null;
    private isVisible = false;
    private controlsPanel: HTMLElement | null = null;
    private isDraggingControls = false;
    private controlsDragOffset = { x: 0, y: 0 };
    private updateRollButtonTextCallback: ((diceType: string) => void) | null = null;
    private updateDiceCountDisplayCallback: (() => void) | null = null;

    // Everything the overlay registers, so hideDiceOverlay can undo all of it.
    private overlayCleanups: Array<() => void> = [];
    private statusInterval: number | null = null;

    // Settings changes arrive one per slider tick. Coalesce them.
    private readonly queueSave = debounce(() => { void this.writeSettings(); }, 500, true);

    async onload() {
        await this.loadSettings();

        // A community install arrives without the pack folder; lay it out.
        if (this.manifest.dir) {
            try {
                await ensureDefaultPack(this.app.vault.adapter, this.manifest.dir, this.manifest.version);
            } catch (error) {
                console.error('Could not write the default dice pack:', error);
                new Notice('Could not write the default dice pack.');
            }
        }

        this.addCommand({
            id: 'toggle-dice-roller',
            name: 'Toggle dice roller',
            callback: () => {
                this.toggleDiceOverlay();
            }
        });

        this.addRibbonIcon('dice', 'Toggle dice roller', (evt: MouseEvent) => {
            this.toggleDiceOverlay();
        });

        this.addSettingTab(new DiceSettingTab(this.app, this));
    }

    onunload() {
        this.hideDiceOverlay();
        // Write straight through: a queued debounce would never fire.
        this.queueSave.cancel();
        void this.writeSettings();
    }

    private toggleDiceOverlay() {
        if (this.isVisible) {
            this.hideDiceOverlay();
        } else {
            this.showDiceOverlay();
        }
    }

    private showDiceOverlay() {
        if (this.diceOverlay) return;

        // Create floating overlay that fills the window
        this.diceOverlay = document.body.createDiv('dice-floating-overlay');

        // Create dice container
        const diceContainer = this.diceOverlay.createDiv('dice-floating-container');

        // Create draggable controls panel. Laid out like Atlas VTT's dice panel:
        // a header, one row of dice, and a bar with the formula and the actions.
        this.controlsPanel = this.diceOverlay.createDiv('dice-controls-panel');

        // Header: drag grip and title on the left, close button in the corner.
        const header = this.controlsPanel.createDiv('dice-controls-header');
        const dragHandle = header.createDiv('dice-controls-drag-handle');
        setIcon(dragHandle.createSpan('dice-controls-grip'), 'grip-vertical');
        dragHandle.createSpan({ cls: 'dice-controls-title', text: 'Atlas VTT Physical Dice' });

        const closeBtn = header.createEl('button', {
            cls: 'dice-floating-close-btn',
            attr: { 'aria-label': 'Close dice roller' }
        });
        setIcon(closeBtn, 'x');
        closeBtn.addEventListener('click', () => this.hideDiceOverlay());

        // Dice row: one button per type, adding a die; the badge counts them.
        const diceButtonsContainer = this.controlsPanel.createDiv('dice-type-grid');

        // Result display
        const resultElement = this.controlsPanel.createDiv({ cls: 'dice-result-overlay' });

        // Dice status display
        const statusElement = this.controlsPanel.createDiv({ cls: 'dice-status-display' });

        // Reroll caught dice button
        const rerollButton = this.controlsPanel.createEl('button', {
            text: 'Reroll caught dice',
            cls: 'dice-reroll-button'
        });
        rerollButton.hide();
        rerollButton.disabled = true;

        // Formula bar: what is on the table, then clear and roll.
        const formulaBar = this.controlsPanel.createDiv('dice-formula-bar');
        const diceCountDisplay = formulaBar.createDiv({ cls: 'dice-count-display' });
        const actions = formulaBar.createDiv('dice-formula-actions');

        const clearButton = actions.createEl('button', {
            cls: 'dice-clear-button',
            attr: { 'aria-label': 'Clear all dice' }
        });
        setIcon(clearButton, 'trash-2');

        const rollButton = actions.createEl('button', {
            text: 'Roll',
            cls: 'mod-cta dice-roll-button'
        });

        // Update roll button text based on dice type
        const updateRollButtonText = (diceType: string) => {
            rollButton.textContent = 'Roll';
        };
        updateRollButtonText('d20');

        // Atlas VTT's order, percentile last.
        const diceTypes = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'];
        const badges = new Map<string, HTMLElement>();
        const typeButtons = new Map<string, HTMLElement>();

        const updateDiceCountDisplay = () => {
            const counts = this.settings.diceCounts as Record<string, number>;
            const totalDice = Object.values(counts).reduce((sum, count) => sum + count, 0);
            const countText = Object.entries(counts)
                .filter(([_, count]) => count > 0)
                .map(([type, count]) => `${count}${type}`)
                .join(' + ') || 'No dice';
            diceCountDisplay.textContent = `${countText} · ${totalDice}/50`;
            for (const [type, badge] of badges) {
                const count = counts[type] ?? 0;
                badge.textContent = String(count);
                badge.toggleClass('is-empty', count === 0);
                typeButtons.get(type)?.toggleClass('is-selected', count > 0);
            }
            rollButton.disabled = totalDice === 0;
        };

        const addDie = async (type: string, color: string | null, button: HTMLElement): Promise<void> => {
            const totalDice = Object.values(this.settings.diceCounts).reduce((sum, count) => sum + count, 0);
            if (totalDice >= 50) {
                new Notice('The tray holds at most 50 dice');
                button.addClass('is-at-limit');
                window.setTimeout(() => button.removeClass('is-at-limit'), 1500);
                return;
            }
            (this.settings.diceCounts as Record<string, number>)[type]++;
            this.dice?.createSingleDice(type, color);
            updateDiceCountDisplay();
            this.refreshDiceView();
            await this.saveSettings();
        };

        const removeDie = async (type: string): Promise<void> => {
            const counts = this.settings.diceCounts as Record<string, number>;
            if (!counts[type]) return;
            // The roll in flight tracks its dice by position.
            if (this.dice?.rollInProgress) {
                new Notice('Wait for the roll to finish');
                return;
            }
            if (this.dice && !this.dice.removeSingleDice(type)) return;
            counts[type]--;
            updateDiceCountDisplay();
            this.refreshDiceView();
            await this.saveSettings();
        };

        diceTypes.forEach(type => {
            // As in Atlas: the die's glyph on the button, its name underneath.
            const cell = diceButtonsContainer.createDiv('dice-type-cell');
            const button = cell.createEl('button', {
                cls: 'dice-type-button',
                attr: { 'aria-label': `${type}: click to add, right-click for colours`, 'data-die': type }
            });
            appendDiceIcon(button, type);
            badges.set(type, button.createSpan('dice-type-badge'));
            typeButtons.set(type, button);
            cell.createSpan({ cls: 'dice-type-name', text: type });

            // Click: a die in the pack's colour. Right-click: a column of the dice
            // colours over the button, each adding it in that colour; with no
            // colours set up, right-click removes one.
            button.addEventListener('click', () => void addDie(type, null, button));
            button.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                if (this.settings.diceColors.length === 0) {
                    void removeDie(type);
                    return;
                }
                this.showColorPicker(type, button, (color) => void addDie(type, color, button));
            });
        });
        updateDiceCountDisplay();

        const clearAllDice = async () => {
            Object.keys(this.settings.diceCounts).forEach(key => {
                (this.settings.diceCounts as Record<string, number>)[key] = 0;
            });
            await this.saveSettings();

            // Clear all dice from the 3D scene
            if (this.dice) {
                this.dice.clearAllDice();
            }

            updateDiceCountDisplay();
            this.refreshDiceView();
        };
        clearButton.addEventListener('click', () => { void clearAllDice(); });

        // No clickthrough control: the canvas takes the pointer only while it
        // is over a die, and passes everything else to the note underneath.
        this.updateRollButtonTextCallback = updateRollButtonText;
        this.updateDiceCountDisplayCallback = updateDiceCountDisplay;

        // Setup dragging for controls
        this.setupControlsDragging(dragHandle);

        // Position controls panel initially
        this.controlsPanel.setCssStyles({ left: '50px', top: '100px' });

        // Initialize dice with settings
        this.dice = new D20Dice(diceContainer, this.settings);
        void this.applyTexturePack();

        // Create any dice that are already in the settings (from dice requests)
        Object.entries(this.settings.diceCounts).forEach(([diceType, count]) => {
            for (let i = 0; i < count; i++) {
                this.dice.createSingleDice(diceType);
            }
        });

        // Set up calibration callback
        this.dice.onCalibrationChanged = () => {
            void this.saveSettings();
        };

        // Set up callback for drag-based rolls (now expects string)
        this.dice.onRollComplete = (result: number | string) => {
            this.handleRollComplete(result, resultElement);
        };

        // Set up dice status monitoring. The handle lives on the plugin so that
        // closing the overlay mid-roll stops the poll.
        const startStatusMonitoring = () => {
            if (this.statusInterval !== null) return;
            this.statusInterval = window.setInterval(() => {
                if (this.dice) {
                    const status = this.dice.getDiceStatus();
                    this.updateDiceStatusDisplay(status, statusElement, rerollButton);
                }
            }, 500);
        };

        const stopStatusMonitoring = () => {
            if (this.statusInterval !== null) {
                window.clearInterval(this.statusInterval);
                this.statusInterval = null;
            }
        };

        // Reroll button functionality
        rerollButton.addEventListener('click', () => {
            if (this.dice) {
                const success = this.dice.rerollCaughtDice();
                if (success) {
                    new Notice('Rerolling caught dice...');
                } else {
                    new Notice('No caught dice to reroll');
                }
            }
        });

        // Set up button roll
        const rollAllDice = async () => {
            rollButton.disabled = true;
            rollButton.textContent = 'Rolling...';
            resultElement.textContent = '';
            resultElement.className = 'dice-result-overlay';
            statusElement.textContent = 'Starting roll...';

            // Start monitoring dice status during roll
            startStatusMonitoring();

            try {
                const result = await this.dice.roll();
                this.handleRollComplete(result, resultElement);
                statusElement.textContent = 'Roll complete!';
                rerollButton.hide();

                // Stop monitoring after completion
                window.setTimeout(() => {
                    stopStatusMonitoring();
                    statusElement.textContent = '';
                }, 3000);
            } catch {
                resultElement.textContent = 'Error rolling dice';
                resultElement.className = 'dice-result-overlay error';
                statusElement.textContent = 'Roll failed';

                // Stop monitoring on error
                window.setTimeout(() => {
                    stopStatusMonitoring();
                }, 3000);
            } finally {
                rollButton.disabled = false;
                updateRollButtonText('d20');
            }
        };
        rollButton.addEventListener('click', () => { void rollAllDice(); });

        this.isVisible = true;

        // Handle window resize with debouncing
        const resizeHandler = debounce(() => this.updateOverlaySize(), 100, true);
        window.addEventListener('resize', resizeHandler);
        this.overlayCleanups.push(() => {
            resizeHandler.cancel();
            window.removeEventListener('resize', resizeHandler);
        });

        // Also listen for Obsidian layout changes
        const layoutRef = this.app.workspace.on('layout-change', () => {
            window.setTimeout(() => this.updateOverlaySize(), 100);
        });
        this.overlayCleanups.push(() => this.app.workspace.offref(layoutRef));

        // Dragging a sidebar edge or changing the zoom resizes the workspace
        // without resizing the window, and without firing layout-change either.
        // Watching the element itself is the only thing that catches those.
        const observed = this.overlayRegion().el;
        if (observed && typeof ResizeObserver !== 'undefined') {
            // Same debounce as the window path: a drag fires this per frame,
            // and each call reallocates the renderer's framebuffer.
            const observer = new ResizeObserver(resizeHandler);
            observer.observe(observed);
            this.overlayCleanups.push(() => observer.disconnect());
        }

        // Initial sizing
        window.setTimeout(() => this.updateOverlaySize(), 50);
    }

    private setupControlsDragging(dragHandle: HTMLElement) {
        dragHandle.addEventListener('mousedown', (e) => {
            this.isDraggingControls = true;
            const rect = this.controlsPanel.getBoundingClientRect();
            this.controlsDragOffset.x = e.clientX - rect.left;
            this.controlsDragOffset.y = e.clientY - rect.top;
            dragHandle.addClass('is-dragging');
            e.preventDefault();
        });

        // These sit on document, so they outlive the overlay unless removed —
        // reopening it used to stack another pair every time.
        const onMove = (e: MouseEvent) => {
            if (this.isDraggingControls && this.controlsPanel) {
                const x = e.clientX - this.controlsDragOffset.x;
                const y = e.clientY - this.controlsDragOffset.y;

                // Keep panel within window bounds
                const maxX = window.innerWidth - this.controlsPanel.offsetWidth;
                const maxY = window.innerHeight - this.controlsPanel.offsetHeight;

                this.controlsPanel.setCssStyles({
                    left: `${Math.max(0, Math.min(x, maxX))}px`,
                    top: `${Math.max(44, Math.min(y, maxY))}px` // 44px for ribbon
                });
            }
        };

        const onUp = () => {
            if (this.isDraggingControls) {
                this.isDraggingControls = false;
                dragHandle.removeClass('is-dragging');
            }
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        this.overlayCleanups.push(() => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        });
    }

    private showResult(result: number | string, resultElement: HTMLElement) {
        const copyableText = typeof result === 'string' ? result : `1${this.settings.diceType}=${result}`;
        resultElement.textContent = copyableText;
        resultElement.className = 'dice-result-overlay show';
        resultElement.title = 'Click to copy result';

        // Make result clickable to copy
        resultElement.onclick = () => {
            navigator.clipboard.writeText(copyableText).then(() => {
                const originalText = resultElement.textContent;
                resultElement.textContent = 'Copied!';
                window.setTimeout(() => {
                    resultElement.textContent = originalText;
                }, 1000);
            }).catch(() => {
                new Notice('Could not copy the roll to the clipboard.');
            });
        };
    }

    /**
     * Where the dice are allowed to be, measured rather than guessed.
     *
     * This used to be the window minus a hardcoded 44px for the header. That
     * number is only right on a desktop Obsidian at 100% zoom with the default
     * frame: the zoom setting scales the header, the hidden-frame and native
     * -titlebar settings change it again, and nothing ever subtracted the
     * status bar, so dice rolled underneath it and vanished.
     *
     * `.workspace` spans exactly the region wanted — below the titlebar and tab
     * header, above the status bar, ribbon and sidebars included. The fallback
     * chain keeps this working in the harness, and in any Obsidian that renames
     * things, rather than sizing to nothing.
     */
    private overlayRegion(): { el: HTMLElement | null; rect: DOMRect } {
        let el: HTMLElement | null = null;
        let rect = new DOMRect(0, 0, window.innerWidth, window.innerHeight);

        for (const selector of ['.workspace', '.app-container']) {
            const candidate = document.querySelector<HTMLElement>(selector);
            if (!candidate) continue;
            const candidateRect = candidate.getBoundingClientRect();
            if (candidateRect.width <= 0 || candidateRect.height <= 0) continue;
            el = candidate;
            rect = candidateRect;
            break;
        }

        // `.workspace` reaches the top of the window on desktop Obsidian: the
        // titlebar and its tabs are drawn over it rather than above it. Left
        // alone, dice roll across the tab bar and under the window buttons.
        // Measured at 39px here where the old constant guessed 44 — and it is
        // a different number at a different zoom, which is the whole reason
        // this is measured. Clamping rather than subtracting keeps it correct
        // on a build where `.workspace` already starts below the titlebar.
        const titlebar = document.querySelector<HTMLElement>('.titlebar');
        if (titlebar) {
            const bar = titlebar.getBoundingClientRect();
            const top = Math.max(rect.top, bar.bottom);
            if (top > rect.top) {
                rect = new DOMRect(rect.left, top, rect.width, rect.bottom - top);
            }
        }

        return { el, rect };
    }

    private updateOverlaySize() {
        if (!this.diceOverlay || !this.dice) return;

        const { rect } = this.overlayRegion();

        // The overlay is position: fixed, so viewport coordinates go in as they
        // come out of getBoundingClientRect().
        this.diceOverlay.setCssStyles({
            left: `${rect.left}px`,
            top: `${rect.top}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`
        });

        this.dice.updateSize(rect.width, rect.height);
    }

    /**
     * A column of the dice colours rising from `button`, over the panel. It stays
     * open for adding several dice, and closes on a click elsewhere or Escape.
     */
    private showColorPicker(type: string, button: HTMLElement, onPick: (color: string) => void): void {
        this.closeColorPicker?.();
        const rect = button.getBoundingClientRect();
        const picker = document.body.createDiv({ cls: 'dice-color-picker', attr: { role: 'group', 'aria-label': `Add a ${type} in a colour` } });
        picker.setCssStyles({ left: `${rect.left + rect.width / 2}px`, top: `${rect.top}px` });

        for (const entry of this.settings.diceColors) {
            const circle = picker.createEl('button', {
                cls: 'dice-color-circle',
                attr: { 'aria-label': `${entry.name || entry.color} ${type}` }
            });
            circle.setCssProps({ '--dice-swatch': entry.color });
            circle.addEventListener('click', () => onPick(entry.color));
        }

        const close = (event: Event) => {
            if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
            if (event.target instanceof Node && picker.contains(event.target)) return;
            this.closeColorPicker?.();
        };
        document.addEventListener('mousedown', close, true);
        document.addEventListener('keydown', close, true);
        this.closeColorPicker = () => {
            document.removeEventListener('mousedown', close, true);
            document.removeEventListener('keydown', close, true);
            picker.remove();
            this.closeColorPicker = null;
        };
    }

    private hideDiceOverlay() {
        this.closeColorPicker?.();
        for (const cleanup of this.overlayCleanups) cleanup();
        this.overlayCleanups = [];

        if (this.statusInterval !== null) {
            window.clearInterval(this.statusInterval);
            this.statusInterval = null;
        }

        if (this.diceOverlay) {
            if (this.dice) {
                // Stop all monitoring/animation loops immediately
                this.dice.isViewActive = false;
                // Clear all dice before destroying
                this.dice.clearAllDice();
                this.dice.destroy();
                this.dice = null;
            }
            this.diceOverlay.remove();
            this.diceOverlay = null;
        }

        // Reset dice counts when closing
        Object.keys(this.settings.diceCounts).forEach(key => {
            (this.settings.diceCounts as Record<string, number>)[key] = 0;
        });
        void this.saveSettings();

        this.controlsPanel = null;
        this.isDraggingControls = false;
        this.isVisible = false;
        this.updateRollButtonTextCallback = null;
        this.updateDiceCountDisplayCallback = null;
    }

    /** Die types a pack can carry art for. */
    private static readonly PACK_TYPES = ['d4', 'd6', 'd8', 'd10', 'd100', 'd12', 'd20'];

    /**
     * Resource URLs for the selected texture pack, keyed by die type.
     *
     * A pack is a folder under the plugin's own `dice/` directory holding
     * `<type>_Numbers.png`. `getResourcePath` turns a vault path into an
     * `app://` URL the texture loader takes as-is, so nothing has to be read,
     * encoded, or stored - copying a folder and editing the images is the whole
     * of making a custom set.
     *
     * A missing file is not an error: that type simply falls back to whatever
     * texture the settings hold, or to a plain coloured die.
     */
    private resolvePackFiles(key: 'texture' | 'normal'): Record<string, string> {
        const pack = this.settings.texturePack;
        const dir = this.manifest.dir;
        if (!pack || !dir) return {};

        const adapter = this.app.vault.adapter;
        const urls: Record<string, string> = {};
        for (const type of D20DicePlugin.PACK_TYPES) {
            const named = this.packConfig?.dice?.[type]?.[key];
            // A pack with no manifest still works: the sheets are named after
            // their die, and there is no normal map unless one is asked for.
            const file = named || (key === 'texture' ? `${type}_Numbers.png` : null);
            if (!file) continue;
            urls[type] = adapter.getResourcePath(`${dir}/dice/${pack}/${file}`);
        }
        return urls;
    }

    /** The chosen pack's manifest, once read. */
    private packConfig: DicePack | null = null;

    /**
     * Read the pack's manifest.
     *
     * Everything a set decides about itself lives in this one file - how its
     * art is laid out, how big each die is, what it is finished like, whether
     * its edges are taken off. A pack without one still renders; it simply has
     * no opinions, and the dice fall back to their own proportions and the
     * geometry's own UVs.
     */
    private async loadPackConfig(): Promise<DicePack | null> {
        const pack = this.settings.texturePack;
        const dir = this.manifest.dir;
        if (!pack || !dir) return null;
        try {
            const raw = await this.app.vault.adapter.read(`${dir}/dice/${pack}/pack.json`);
            return JSON.parse(raw) as DicePack;
        } catch (error) {
            console.warn(`No usable pack.json in ${pack}:`, error);
            return null;
        }
    }

    /** Load the pack and hand every part of it to the renderer. */
    async applyTexturePack(): Promise<void> {
        this.packConfig = await this.loadPackConfig();
        if (!this.dice) return;
        this.dice.setPack(this.packConfig || {});
        this.dice.setPackTextures(this.resolvePackFiles('texture'), this.resolvePackFiles('normal'));
        this.dice.rebuildDice();
    }

    /**
     * Open the `dice/` folder in the system file manager, where a new pack is
     * dropped in. Mobile has no file manager to hand it to, so it gets the path.
     */
    async openPacksFolder(): Promise<void> {
        const dir = this.manifest.dir;
        if (!dir) return;
        const packsDir = `${dir}/dice`;
        const adapter = this.app.vault.adapter;
        if (!Platform.isDesktopApp || !(adapter instanceof FileSystemAdapter)) {
            new Notice(`Dice packs live in ${packsDir}`);
            return;
        }
        if (!(await adapter.exists(packsDir))) await adapter.mkdir(packsDir);
        // Electron is only reached on desktop, behind the check above.
        const { shell } = (window as unknown as ElectronWindow).require('electron');
        const error: string = await shell.openPath(adapter.getFullPath(packsDir));
        if (error) new Notice(`Could not open the dice packs folder: ${error}`);
    }

    /** Pack folders available to choose from, for the settings dropdown. */
    async listTexturePacks(): Promise<string[]> {
        const dir = this.manifest.dir;
        if (!dir) return [];
        try {
            const listing = await this.app.vault.adapter.list(`${dir}/dice`);
            return listing.folders
                .map((folder) => folder.split('/').pop() || '')
                .filter(Boolean)
                .sort();
        } catch {
            return [];
        }
    }

    async loadSettings() {
        const stored = ((await this.loadData()) ?? {}) as Partial<DiceSettings> & Record<string, unknown>;
        // Object.assign is shallow, so without cloning the nested objects a
        // fresh vault ends up mutating DEFAULT_SETTINGS itself — dice counts and
        // textures are written in place all over the plugin.
        // Shadow-map settings that no longer exist. Dropping them here stops
        // them being carried straight back out to data.json on the next save.
        delete stored.diceCastShadow;
        delete stored.diceReceiveShadow;
        delete stored.surfaceReceiveShadow;

        // Dice settings the pack now owns. Dropping them here stops them being
        // carried straight back out to data.json on the next save.
        delete stored.diceScales;
        delete stored.diceTextures;
        delete stored.diceNormalMaps;
        delete stored.diceShininess;
        delete stored.diceSpecular;
        delete stored.diceTransparent;
        delete stored.diceOpacity;
        delete stored.beveledDice;

        // Retired in the Atlas VTT fork: the tray and camera border follow the
        // overlay on their own, the online API and its chat are gone, and
        // debug logging is the DEBUG constant in d20-dice.ts.
        for (const key of [
            'showWindowBorder', 'windowBorderColor', 'windowBorderOpacity', 'windowBorderWidth',
            'showSurface', 'surfaceColor', 'surfaceOpacity', 'surfaceBorderColor',
            'surfaceBorderOpacity', 'surfaceBorderWidth', 'trayWidth', 'trayLength',
            'apiEnabled', 'apiEndpoint', 'sendRollsToAtlas', 'enableMotionDebug'
        ]) delete stored[key];

        this.settings = Object.assign({}, DEFAULT_SETTINGS, stored, {
            diceCounts: Object.assign({}, DEFAULT_SETTINGS.diceCounts, stored.diceCounts),
            faceMapping: Object.assign({}, DEFAULT_SETTINGS.faceMapping, stored.faceMapping),
            diceColors: Array.isArray(stored.diceColors) ? stored.diceColors.map((c: DiceColor) => ({ ...c })) : []
        });
    }

    private async writeSettings(): Promise<void> {
        if (!this.settings) return;
        await this.saveData(this.settings);
    }

    /** Settings changes arrive one per slider tick, so writes are coalesced. */
    async saveSettings() {
        this.queueSave();
    }

    /**
     * Every settings control calls this, and updateSettings() rebuilds the tray
     * and the lights. Dragging one slider used to do that forty times a second;
     * a short trailing debounce is imperceptible and does it once.
     */
    refreshDiceView = debounce(() => {
        if (this.dice) {
            this.dice.updateSettings(this.settings);
        }

        // Update floating controls if they exist
        if (this.updateRollButtonTextCallback) {
            this.updateRollButtonTextCallback('d20');
        }
    }, 100, true);

    /** Rebuild the dice, for anything that changes their shape rather than their look. */
    rebuildDice(): void {
        if (this.dice) {
            this.dice.rebuildDice();
        }
    }

    /** Every settled roll goes to Atlas VTT: its toast, roll log and player view. */
    /**
     * Every settled roll: shown on the panel, naming each die's colour, and
     * sent to Atlas VTT (its toast, roll log and player view).
     */
    private handleRollComplete(result: number | string, resultElement: HTMLElement): void {
        const rolled = this.dice?.takeLastRoll() ?? null;
        this.showResult(rolled ? this.describeRoll(rolled) : result, resultElement);
        if (rolled) sendRollToAtlas(rolled.map((die) => ({ ...die, colorName: this.colorName(die.color) })));
    }

    /** `Red d20=14 + d6=3 = 17`: each die, named by its colour when it has one. */
    private describeRoll(rolled: RolledDie[]): string {
        const parts = rolled.map((die) => {
            const name = this.colorName(die.color);
            return `${name ? `${name} ` : ''}${die.type}=${die.value}`;
        });
        const total = rolled.reduce((sum, die) => sum + die.value, 0);
        return `${parts.join(' + ')} = ${total}`;
    }

    private colorName(color: string | null | undefined): string | null {
        if (!color) return null;
        const match = this.settings.diceColors.find((c) => c.color === color);
        return match?.name || color;
    }

    private updateDiceStatusDisplay(
        status: Array<{index: number, type: string, status: string, result?: number}>,
        statusElement: HTMLElement,
        rerollButton: HTMLButtonElement
    ) {
        if (status.length === 0) {
            statusElement.textContent = '';
            rerollButton.hide();
            return;
        }

        const rolling = status.filter(d => d.status === 'rolling').length;
        const caught = status.filter(d => d.status === 'caught').length;
        const complete = status.filter(d => d.status === 'complete').length;

        let displayText = '';

        if (rolling > 0 || caught > 0 || complete > 0) {
            const parts = [];
            if (rolling > 0) parts.push(`🎲 ${rolling} rolling`);
            if (caught > 0) parts.push(`🥅 ${caught} caught`);
            if (complete > 0) parts.push(`✅ ${complete} done`);

            displayText = parts.join(', ');

            // Show individual dice status
            const diceDetails = status.map(dice => {
                const icon = dice.status === 'complete' ? '✅' :
                           dice.status === 'caught' ? '🥅' :
                           dice.status === 'rolling' ? '🎲' : '❓';
                const result = dice.result ? `=${dice.result}` : '';
                return `${icon} ${dice.type}${result}`;
            }).join(' ');

            displayText += `\n${diceDetails}`;
        }

        statusElement.textContent = displayText;

        // Show/hide reroll button based on caught dice
        if (caught > 0) {
            rerollButton.show();
            rerollButton.disabled = false;
            rerollButton.textContent = `Reroll ${caught} Caught Dice`;
        } else {
            rerollButton.hide();
        }
    }
}