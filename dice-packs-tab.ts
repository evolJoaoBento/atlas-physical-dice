import { Notice, setIcon } from 'obsidian';
import type { AtlasLink, AtlasLookInEffect, Disposer } from './atlas-bridge';
import type { AtlasLooks, PackEntry } from './atlas-looks';

/**
 * A "Dice packs" tab in Atlas's asset manager (`ui.addAssetTab`), as Atlas's
 * own native Dice tab: every pack with a picture of its d20, a button to read
 * the packs again and one to open their folder. Picking a pack makes it the
 * collection's dice look (`dice.useLook`, by collection), and the pack in use is
 * marked from `dice.lookFor`.
 *
 * Needs `asset-tabs`; choosing needs `dice-look-choice` too, and without it the
 * tab only lists the packs.
 */

export interface PacksTabHost {
    openPacksFolder(): Promise<void>;
}

export class DicePacksTab {
    private dispose: Disposer | null = null;

    constructor(
        private readonly link: AtlasLink,
        private readonly looks: AtlasLooks,
        private readonly host: PacksTabHost,
    ) {
        link.onChange(() => this.reconnect());
    }

    private reconnect(): void {
        this.unregister();
        const ui = this.link.extension?.ui;
        if (!ui || typeof ui.addAssetTab !== 'function' || !this.link.has('asset-tabs')) return;
        try {
            this.dispose = ui.addAssetTab({
                id: 'dice-packs',
                title: 'Dice packs',
                icon: 'dice',
                mount: (container: HTMLElement, ctx: { collectionId: string }) => this.mount(container, ctx.collectionId),
            });
        } catch (error) {
            console.warn('Atlas VTT Physical Dice: could not add the Dice packs tab:', error);
        }
    }

    private unregister(): void {
        try { this.dispose?.(); } catch { /* Atlas may already have let it go. */ }
        this.dispose = null;
    }

    unload(): void {
        this.unregister();
    }

    /** Whether picking a pack for the collection works on this Atlas. */
    private get canChoose(): boolean {
        const dice = this.link.dice;
        return !!dice && typeof dice.useLook === 'function' && typeof dice.lookFor === 'function' && this.link.has('dice-look-choice');
    }

    private async lookFor(collectionId: string): Promise<AtlasLookInEffect | null> {
        const dice = this.link.dice;
        if (!this.canChoose || !dice?.lookFor) return null;
        try {
            return await dice.lookFor(collectionId);
        } catch {
            return null;
        }
    }

    private mount(container: HTMLElement, collectionId: string): Disposer {
        let gone = false;
        let busy = false;
        let inEffect: AtlasLookInEffect | null = null;
        const root = container.createDiv({ cls: 'apd-dice-packs' });

        const head = root.createDiv({ cls: 'apd-dice-packs__head' });
        head.createEl('h3', { cls: 'apd-dice-packs__title', text: 'Dice packs' });
        const actions = head.createDiv({ cls: 'apd-dice-packs__actions' });
        const reload = actions.createEl('button', { cls: 'apd-button', attr: { 'aria-label': 'Reload dice packs' } });
        setIcon(reload.createSpan(), 'refresh-cw');
        reload.createSpan({ text: 'Reload' });
        const folder = actions.createEl('button', { cls: 'apd-button', attr: { 'aria-label': 'Open the dice packs folder' } });
        setIcon(folder.createSpan(), 'folder-open');
        folder.createSpan({ text: 'Open folder' });

        root.createEl('p', {
            cls: 'apd-hint',
            text: this.canChoose
                ? 'The dice packs of Atlas VTT Extension - Interactive Dice. Pick one to throw this collection\'s dice in it.'
                : 'The dice packs of Atlas VTT Extension - Interactive Dice. Choose one in Atlas\'s dice look setting.',
        });
        const grid = root.createDiv({ cls: 'apd-dice-packs__grid' });

        const fullId = (entry: PackEntry): string => `${this.link.extensionId}:${entry.folder}`;

        const render = (): void => {
            if (gone) return;
            grid.empty();
            const packs = this.looks.packs;
            if (packs.length === 0) {
                grid.createEl('p', { cls: 'apd-hint', text: 'No dice packs yet. Open the folder, copy a pack under a new name, then reload.' });
            }
            const followsDefault = !inEffect || inEffect.from === 'default';
            for (const entry of packs) {
                const active = !!inEffect && inEffect.lookId === fullId(entry);
                const card = grid.createDiv({ cls: `apd-dice-pack${active ? ' is-active' : ''}` });
                const preview = card.createDiv({ cls: 'apd-dice-pack__preview' });
                if (entry.preview) preview.createEl('img', { attr: { src: entry.preview, alt: '' } });
                else setIcon(preview, 'dice');
                const body = card.createDiv({ cls: 'apd-dice-pack__body' });
                body.createDiv({ cls: 'apd-dice-pack__name', text: entry.name });
                body.createDiv({ cls: 'apd-dice-pack__meta', text: entry.folder === 'Texture-Pack-Default' ? 'Built in' : entry.folder });
                const side = card.createDiv({ cls: 'apd-dice-pack__actions' });
                if (active) {
                    const mark = side.createSpan({ cls: 'apd-dice-pack__in-use' });
                    setIcon(mark.createSpan(), 'check');
                    mark.createSpan({ text: followsDefault ? 'In use (default)' : 'In use' });
                }
                if (this.canChoose && this.looks.isRegistered(entry.folder) && (!active || followsDefault)) {
                    const use = side.createEl('button', { cls: 'apd-button', text: 'Use for collection' });
                    use.disabled = busy;
                    use.addEventListener('click', () => void choose(entry.folder));
                }
            }
            if (this.canChoose && inEffect?.from === 'collection') {
                const reset = grid.createDiv({ cls: 'apd-dice-packs__reset' });
                const button = reset.createEl('button', { cls: 'apd-button', text: 'Follow the default dice look' });
                button.disabled = busy;
                button.addEventListener('click', () => void choose(null));
            }
        };

        const readChoice = async (): Promise<void> => {
            const next = await this.lookFor(collectionId);
            if (gone) return;
            inEffect = next;
            render();
        };

        const choose = async (folderId: string | null): Promise<void> => {
            const dice = this.link.dice;
            if (!dice?.useLook) return;
            busy = true;
            render();
            try {
                await dice.useLook(folderId, { collectionId });
            } catch (error) {
                new Notice(`Could not choose the dice pack: ${error instanceof Error ? error.message : String(error)}`);
            } finally {
                busy = false;
            }
            await readChoice();
        };

        reload.addEventListener('click', () => {
            reload.disabled = true;
            void this.looks.refresh().finally(() => {
                reload.disabled = false;
                void readChoice();
            });
        });
        folder.addEventListener('click', () => { void this.host.openPacksFolder(); });

        // The choice changes from elsewhere too: Atlas's settings (the default), another tab, a collection rename.
        const unhook = [
            this.link.listen('collections-changed', () => { void readChoice(); }),
            this.link.listen('settings-changed', () => { void readChoice(); }),
            this.looks.onChange(() => { render(); void readChoice(); }),
        ];

        render();
        void readChoice();

        return () => {
            gone = true;
            for (const off of unhook) off();
            root.remove();
        };
    }
}
