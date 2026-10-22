import { Plugin, Notice, debounce, setIcon, Platform, FileSystemAdapter } from 'obsidian';
import { D20Dice, DiceClearedError, DicePack, type RolledDie } from './d20-dice';
import { DiceSettings, DEFAULT_SETTINGS, DiceSettingTab, type DiceColor } from './settings';
import { AtlasLink, sendRollToAtlas, useAtlasLink } from './atlas-bridge';
import { AtlasLooks } from './atlas-looks';
import { AtlasColours } from './atlas-colours';
import { DicePacksTab } from './dice-packs-tab';
import { diePictures, PackPreviews } from './pack-previews';
import { defaultPackFiles } from './default-pack';
import { ensureDefaultPack, listPacks, loadPack, migratePacks, packFileUrls, packsFolder, type PackFs } from './kit/packs';
import { caughtMessage } from './kit/caught';
import type { DieType } from './kit/faces';

/** The slice of Electron's renderer API the packs-folder button uses. */
interface ElectronWindow {
    require(module: 'electron'): { shell: { openPath(path: string): Promise<string> } };
}

export default class D20DicePlugin extends Plugin {
    settings: DiceSettings;
    /** Atlas's extension API, when Atlas has one. */
    private atlasLink: AtlasLink | null = null;
    /** Every dice pack, offered to Atlas as a dice look. */
    atlasLooks: AtlasLooks | null = null;
    /** Dice colours kept per Atlas collection. */
    private atlasColours: AtlasColours | null = null;
    /** The Dice packs tab in Atlas's asset manager. */
    private packsTab: DicePacksTab | null = null;
    /** Names of the collection colours dice were added in here, by colour. */
    private readonly collectionColourNames = new Map<string, string>();
    /** The shared folder the dice packs live in. */
    get packsDir(): string {
        return packsFolder(this.app.vault.configDir);
    }

    /** Obsidian's adapter, as the pack kit sees it. */
    get packFs(): PackFs {
        const adapter = this.app.vault.adapter;
        return {
            exists: (p) => adapter.exists(p),
            list: (p) => adapter.list(p),
            read: (p) => adapter.read(p),
            readBinary: (p) => adapter.readBinary(p),
            writeBinary: (p, d) => adapter.writeBinary(p, d),
            mkdir: (p) => adapter.mkdir(p),
            getResourcePath: (p) => adapter.getResourcePath(p)
        };
    }
    private diceOverlay: HTMLElement | null = null;
    private dice: D20Dice | null = null;
    /** Closes the column of colours a right-click opened over a die, when one is showing. */
    private isVisible = false;
    private controlsPanel: HTMLElement | null = null;
    private isDraggingControls = false;
    private controlsDragOffset = { x: 0, y: 0 };
    private updateRollButtonTextCallback: ((diceType: string) => void) | null = null;
    private updateDiceCountDisplayCallback: (() => void) | null = null;
    /** Draws the pictures on the tray's dice again, from the pack the tray holds now. */
    private redrawTrayPictures: (() => Promise<void>) | null = null;

    // Everything the overlay registers, so hideDiceOverlay can undo all of it.
    private overlayCleanups: Array<() => void> = [];
    private statusInterval: number | null = null;

    // Settings changes arrive one per slider tick. Coalesce them.
    private readonly queueSave = debounce(() => { void this.writeSettings(); }, 500, true);

    async onload() {
        await this.loadSettings();

        // Packs live in a folder shared with Tabletop. Bring over any the old
        // per-plugin folder holds (once, copying and never deleting), then lay
        // out the default, which a community install arrives without.
        // Each step has its own guard: a failed copy must not leave the user
        // without the default pack, and a failed copy is retried next load.
        try {
            if (!this.settings.packsMigrated && this.manifest.dir) {
                await migratePacks(this.packFs, `${this.manifest.dir}/dice`, this.packsDir);
                this.settings.packsMigrated = true;
                await this.writeSettings();
            }
        } catch (error) {
            console.error('Could not copy the old dice packs:', error);
            new Notice('Could not copy the old dice packs.');
        }
        try {
            await ensureDefaultPack(this.packFs, this.packsDir, defaultPackFiles());
        } catch (error) {
            console.error('Could not write the default dice pack:', error);
            new Notice('Could not write the default dice pack.');
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

        // Atlas's extension API: rolls go through it, each pack becomes one of
        // Atlas's dice looks, the asset manager gets a Dice packs tab and each
        // collection its dice colours. Without it everything below does nothing
        // and rolls keep going out as the DOM event.
        this.atlasLink = new AtlasLink(this);
        useAtlasLink(this.atlasLink);
        this.atlasLooks = new AtlasLooks(this, this.atlasLink, new PackPreviews(this));
        this.atlasColours = new AtlasColours(this.atlasLink);
        this.packsTab = new DicePacksTab(this.atlasLink, this.atlasLooks, this);
        this.atlasLink.start();
    }

    onunload() {
        this.packsTab?.unload();
        this.atlasColours?.dispose();
        this.atlasLooks?.dispose();
        useAtlasLink(null);
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

        // Read the open map's collection colours in now, so the first right-click has them.
        this.atlasColours?.forActiveMap();

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

        // The tray, as Tabletop's (Atlas's own dice tray, its classes): a picture of each die with its count, the grip
        // under it taking one back, right-click for its colours (laid out the same way), then Roll and Clear.
        this.controlsPanel.addClass('atlas-vtt-plugin');
        const trayContent = this.controlsPanel.createDiv('atlas-dice-tray__content');
        const diceButtonsContainer = trayContent.createDiv('atlas-dice-tray__dice');
        const coloursRow = trayContent.createDiv('dice-tray-colours');
        coloursRow.hide();
        let coloursFor: string | null = null;

        // Result display
        const resultElement = trayContent.createDiv({ cls: 'dice-result-overlay' });

        // Dice status display
        const statusElement = trayContent.createDiv({ cls: 'dice-status-display' });

        // Reroll caught dice button
        const rerollButton = trayContent.createEl('button', {
            text: 'Reroll caught dice',
            cls: 'dice-reroll-button'
        });
        rerollButton.hide();
        rerollButton.disabled = true;

        // What is on the table, as Atlas's tray writes a formula, then Roll and Clear.
        const formula = trayContent.createEl('p', { cls: 'atlas-dice-tray__formula', attr: { role: 'status', 'aria-live': 'polite' } });
        const actions = trayContent.createDiv('atlas-dice-tray__actions');
        const rollButton = actions.createEl('button', { text: 'Roll', cls: 'btn btn--default btn--sm atlas-dice-tray__roll' });
        const clearButton = actions.createEl('button', { text: 'Clear', cls: 'btn btn--outline btn--sm', attr: { 'aria-label': 'Clear all dice' } });

        // Update roll button text based on dice type
        const updateRollButtonText = (diceType: string) => {
            rollButton.textContent = 'Roll';
        };
        updateRollButtonText('d20');

        // Atlas VTT's order, percentile last.
        const diceTypes = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'];
        // A picture of each die of the pack, drawn once its sheets are in (the die's name until then).
        let pictures = new Map<string, HTMLCanvasElement>();
        const total = (): number => Object.values(this.settings.diceCounts).reduce((sum, count) => sum + count, 0);

        /** A tray cell: a face button with its count, and the grip under it taking one back (or the space it would take). */
        const trayCell = (into: HTMLElement, face: (button: HTMLButtonElement) => void, count: number, label: string, onAdd: () => void, onTakeBack: () => void, takeBackLabel: string): HTMLButtonElement => {
            const cell = into.createDiv('atlas-dice-tray__die');
            const button = cell.createEl('button', { cls: 'atlas-dice-tray__face', attr: { type: 'button', 'aria-label': label } });
            face(button);
            if (count > 0) button.createSpan({ cls: 'atlas-dice-tray__count', text: String(count), attr: { 'aria-hidden': 'true' } });
            button.disabled = total() >= 50;
            button.addEventListener('click', onAdd);
            if (count > 0) {
                const grip = cell.createEl('button', { cls: 'atlas-dice-tray__grip', attr: { type: 'button', 'aria-label': takeBackLabel } });
                setIcon(grip, 'minus');
                grip.addEventListener('click', onTakeBack);
            } else cell.createSpan({ cls: 'atlas-dice-tray__grip-space', attr: { 'aria-hidden': 'true' } });
            return button;
        };

        const updateDiceCountDisplay = () => {
            const counts = this.settings.diceCounts as Record<string, number>;
            const totalDice = total();
            const terms = diceTypes.filter((type) => (counts[type] ?? 0) > 0).map((type) => `${counts[type]}${type}`);
            formula.textContent = terms.length > 0 ? terms.join(' + ') : 'The tray is empty.';
            formula.toggleClass('atlas-dice-tray__formula--empty', terms.length === 0);
            diceButtonsContainer.empty();
            for (const type of diceTypes) {
                const count = counts[type] ?? 0;
                const button = trayCell(diceButtonsContainer, (face) => {
                    const picture = pictures.get(type);
                    if (picture) face.appendChild(picture);
                    else face.createSpan({ cls: 'dice-tray-name', text: type });
                }, count, count === 0 ? `Add a ${type}` : `Add a ${type}, ${count} in the tray`, () => void addDie(type, null, button), () => void removeDie(type), `Take one ${type} back`);
                button.dataset.die = type;
                button.title = `${type} · right-click: colours`;
                // The colours picked for it, as a stripe of their shares under the picture (the pack's own leaves no mark).
                const colours = this.dice?.coloursOf(type) ?? [];
                if (colours.some((colour) => colour !== null)) {
                    const stops = colours.map((colour, index) => `${colour ?? 'transparent'} ${(index / colours.length) * 100}% ${((index + 1) / colours.length) * 100}%`);
                    button.addClass('has-colours');
                    button.setCssProps({ '--dice-tray-colours': `linear-gradient(to right, ${stops.join(', ')})` });
                }
                button.addEventListener('contextmenu', (event) => {
                    event.preventDefault();
                    coloursFor = coloursFor === type ? null : type;
                    updateDiceCountDisplay();
                });
            }
            drawColours();
            rollButton.disabled = totalDice === 0;
            clearButton.toggle(totalDice > 0);
        };

        /** The open die's colours, in a row like the dice: a button of each colour (its badge how many), its grip taking one back. */
        const drawColours = () => {
            coloursRow.empty();
            const type = coloursFor;
            if (!type) { coloursRow.hide(); return; }
            coloursRow.show();
            coloursRow.createSpan({ cls: 'atlas-dice-tray__modifier-label', text: `${type} colours` });
            const row = coloursRow.createDiv('atlas-dice-tray__dice');
            const entries: Array<{ color: string | null; name: string; fromCollection?: boolean }> = [{ color: null, name: "The pack's colour" }, ...this.pickerColours().map((entry) => ({ color: entry.color, name: entry.name || entry.color, fromCollection: entry.fromCollection }))];
            for (const entry of entries) {
                const count = this.dice?.countOf(type, entry.color) ?? 0;
                const button = trayCell(row, (face) => {
                    face.addClass('dice-tray-colour');
                    if (entry.color) face.setCssProps({ '--dice-swatch': entry.color });
                    else face.addClass('is-pack-colour');
                }, count, count === 0 ? `Add a ${entry.name} ${type}` : `Add a ${entry.name} ${type}, ${count} in the tray`, () => {
                    if (entry.fromCollection && entry.color) this.collectionColourNames.set(entry.color, entry.name);
                    void addDie(type, entry.color, button);
                }, () => void removeDie(type, entry.color), `Take a ${entry.name} ${type} back`);
                button.title = entry.name;
            }
        };

        const addDie = async (type: string, color: string | null, button: HTMLElement): Promise<void> => {
            if (total() >= 50) {
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

        /** Takes one of a die back: the last added, or with `color` (null: the pack's own) the last in that colour. */
        const removeDie = async (type: string, color?: string | null): Promise<void> => {
            const counts = this.settings.diceCounts as Record<string, number>;
            if (!counts[type]) return;
            // The roll in flight tracks its dice by position.
            if (this.dice?.rollInProgress) {
                new Notice('Wait for the roll to finish');
                return;
            }
            if (this.dice && !this.dice.removeSingleDice(type, color)) return;
            counts[type]--;
            updateDiceCountDisplay();
            this.refreshDiceView();
            await this.saveSettings();
        };

        /** The pictures of the pack's dice, drawn again (the pack changed, or its sheets came in). */
        this.redrawTrayPictures = async () => {
            if (!this.dice) return;
            pictures = await diePictures(this.dice, diceTypes);
            if (this.controlsPanel) updateDiceCountDisplay();
        };
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

        // Dice status, for every throw: the Roll button, a drag of one die or of
        // the set, and a reroll. A caught die is only ever told about here ("d20
        // caught: roll it again", with the reroll button), so the poll runs for as
        // long as the overlay is open, and only touches the line when the dice's
        // state changes. The handle lives on the plugin so closing the overlay
        // stops it.
        let shownStatus = '';
        const showDiceStatus = () => {
            if (!this.dice) return;
            const status = this.dice.getDiceStatus();
            const key = JSON.stringify(status);
            if (key === shownStatus) return;
            shownStatus = key;
            this.updateDiceStatusDisplay(status, statusElement, rerollButton);
        };
        /** Leave a message on the status line until the dice's state next changes. */
        const holdStatusLine = () => {
            shownStatus = JSON.stringify(this.dice?.getDiceStatus() ?? []);
        };
        if (this.statusInterval !== null) window.clearInterval(this.statusInterval);
        this.statusInterval = window.setInterval(showDiceStatus, 500);

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

            try {
                const result = await this.dice.roll();
                this.handleRollComplete(result, resultElement);
                statusElement.textContent = 'Roll complete!';
                rerollButton.hide();
                holdStatusLine();

                // Clear the message, unless a later throw has put its own there
                window.setTimeout(() => {
                    if (statusElement.textContent === 'Roll complete!') statusElement.textContent = '';
                }, 3000);
            } catch (error) {
                // Cleared mid-roll: nothing to report, and nothing went wrong
                if (error instanceof DiceClearedError) {
                    statusElement.textContent = '';
                    rerollButton.hide();
                    holdStatusLine();
                    return;
                }
                resultElement.textContent = 'Error rolling dice';
                resultElement.className = 'dice-result-overlay error';
                statusElement.textContent = 'Roll failed';
                holdStatusLine();
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

    private hideDiceOverlay() {
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
        this.redrawTrayPictures = null;
    }

    /**
     * Resource URLs for the selected texture pack, keyed by die type.
     *
     * A pack is a folder under the shared `atlas-dice-packs/` directory holding
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
        if (!pack) return {};
        return packFileUrls(this.packFs, this.packsDir, pack, this.packConfig, key);
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
        if (!pack) return null;
        const config = await loadPack(this.packFs, this.packsDir, pack);
        if (!config) console.warn(`No usable pack.json in ${pack}`);
        return config;
    }

    /** Load the pack and hand every part of it to the renderer. */
    async applyTexturePack(): Promise<void> {
        this.packConfig = await this.loadPackConfig();
        if (!this.dice) return;
        this.dice.setPack(this.packConfig || {});
        this.dice.setPackTextures(this.resolvePackFiles('texture'), this.resolvePackFiles('normal'));
        this.dice.rebuildDice();
        await this.redrawTrayPictures?.();
    }

    /**
     * Open the shared packs folder in the system file manager, where a new pack is
     * dropped in. Mobile has no file manager to hand it to, so it gets the path.
     */
    async openPacksFolder(): Promise<void> {
        const packsDir = this.packsDir;
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
        return listPacks(this.packFs, this.packsDir);
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
        if (match?.name) return match.name;
        const fromCollection = this.collectionColourNames.get(color)
            ?? this.atlasColours?.forActiveMap().find((c) => c.color === color)?.name;
        return fromCollection || match?.name || color;
    }

    /**
     * The colours a die can be added in: the plugin's own, then those of the Atlas
     * collection whose map is open (its Dice tab), leaving out a colour already listed.
     */
    private pickerColours(): Array<DiceColor & { fromCollection?: boolean }> {
        const own = this.settings.diceColors;
        const seen = new Set(own.map((c) => c.color.toLowerCase()));
        const extra: Array<DiceColor & { fromCollection?: boolean }> = [];
        for (const entry of this.atlasColours?.forActiveMap() ?? []) {
            if (seen.has(entry.color.toLowerCase())) continue;
            seen.add(entry.color.toLowerCase());
            extra.push({ id: `collection-${entry.id}`, name: entry.name.trim(), color: entry.color, fromCollection: true });
        }
        return [...own, ...extra];
    }

    private updateDiceStatusDisplay(
        status: Array<{index: number, type: string, status: string, result?: number}>,
        statusElement: HTMLElement,
        rerollButton: HTMLButtonElement
    ) {
        // Dice that are not part of a roll (held beside a caught one) are not listed
        status = status.filter(d => d.status !== 'unknown');
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

            const message = caughtMessage(status.filter(d => d.status === 'caught') as Array<{ type: DieType }>);
            if (message) displayText += `\n${message}`;
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