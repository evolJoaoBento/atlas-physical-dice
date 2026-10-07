import { App, PluginSettingTab, Setting } from 'obsidian';
import D20DicePlugin from './main';

export interface DiceSettings {
    // Dice configuration
    diceType: 'd4' | 'd6' | 'd8' | 'd10' | 'd12' | 'd20'; // Legacy - will be removed
    diceSize: number;

    // Multi-dice counts (how many of each type)
    diceCounts: {
        d4: number;
        d6: number;
        d8: number;
        d10: number;
        d100: number;
        d12: number;
        d20: number;
    };

    // Shadow settings
    enableShadows: boolean;

    // Lighting settings
    ambientLightIntensity: number;
    ambientLightColor: string;
    directionalLightIntensity: number;
    directionalLightColor: string;
    directionalLightPositionX: number;
    directionalLightPositionY: number;
    directionalLightPositionZ: number;

    // Animation settings
    enableResultAnimation: boolean;

    // Motion detection settings
    motionThreshold: number;

    // Face detection settings
    faceDetectionTolerance: number;

    // Highlight settings
    highlightCompletedDice: boolean;
    completedDiceHighlightColor: string;

    // Face calibration mapping
    /**
     * Folder under the plugin's dice/ directory holding one atlas per die type,
     * named `<type>_Numbers.png`. Copy the folder, edit the images, pick it
     * here - that is the whole of making a custom set.
     */
    texturePack: string;

    faceMapping: { [faceIndex: number]: number };

    /** Colours dice can be added in, beside the pack's own. */
    diceColors: DiceColor[];

}

/** A colour dice can be added in: a red set for damage, a blue d20 for advantage. */
export interface DiceColor {
    id: string;
    name: string;
    /** `#rrggbb` */
    color: string;
}

export const DEFAULT_SETTINGS: DiceSettings = {
    // Dice defaults
    diceType: 'd20', // Legacy - will be removed
    diceSize: 0.8,

    // Multi-dice counts defaults (start with no dice)
    diceCounts: {
        d4: 0,
        d6: 0,
        d8: 0,
        d10: 0,
        d100: 0,
        d12: 0,
        d20: 0
    },

    // Shadow defaults
    enableShadows: true,

    // Lighting defaults
    // Ambient near 1 flattens everything it touches: with no gradient across a
    // face the chamfer stops reading and the dice go back to looking like tiles.
    // Keep the fill low and let the key light do the shaping.
    ambientLightIntensity: 0.45,
    ambientLightColor: '#ffffff',
    // three stopped treating light intensity as a plain multiplier: a
    // directional light is divided by PI now, so these read far dimmer than the
    // numbers suggest. Both were picked against the rendered die, not the scale.
    directionalLightIntensity: 2.8,
    directionalLightColor: '#ffffff',
    directionalLightPositionX: 0,
    directionalLightPositionY: 35,
    directionalLightPositionZ: 0,

    // Animation defaults
    enableResultAnimation: true,

    // Motion detection defaults
    motionThreshold: 2.0,

    // Face detection defaults
    faceDetectionTolerance: 0.3,

    // Highlight defaults
    // Off by default: the highlight is an emissive wash over the whole die, so
    // a settled die stops showing its own colour while it is on.
    highlightCompletedDice: false,
    completedDiceHighlightColor: '#00ff00',

    // Face mapping defaults (1:1 mapping initially)
    texturePack: 'Texture-Pack-Default',

    faceMapping: {
        0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10,
        10: 11, 11: 12, 12: 13, 13: 14, 14: 15, 15: 16, 16: 17, 17: 18, 18: 19, 19: 20
    },

    diceColors: []

};

export class DiceSettingTab extends PluginSettingTab {
    plugin: D20DicePlugin;

    constructor(app: App, plugin: D20DicePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    private createCollapsibleSection(containerEl: HTMLElement, title: string, key: string): HTMLElement {
        const sectionContainer = containerEl.createDiv({ cls: 'dice-settings-section' });

        const header = sectionContainer.createDiv({ cls: 'dice-settings-header' });
        header.createDiv({ cls: 'dice-settings-title', text: title });
        header.createSpan({ cls: 'dice-settings-arrow', text: '▼' });

        const content = sectionContainer.createDiv({ cls: 'dice-settings-content' });

        // Collapsed unless the user opened it last time.
        const storageKey = `atlas-physical-dice-settings-${key}`;
        sectionContainer.toggleClass('is-collapsed', this.app.loadLocalStorage(storageKey) !== 'false');

        header.addEventListener('click', () => {
            const collapsed = !sectionContainer.hasClass('is-collapsed');
            sectionContainer.toggleClass('is-collapsed', collapsed);
            this.app.saveLocalStorage(storageKey, collapsed.toString());
        });

        return content;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        // Dice colours section
        const colorsSection = this.createCollapsibleSection(containerEl, 'Dice colours', 'colors');
        colorsSection.createEl('p', {
            cls: 'setting-item-description',
            text: 'Colours you can add dice in, beside the pack’s own: right-click a die in the dice panel to pick one. Each die keeps the colour it was added in, and the roll names it. With Atlas VTT 1.18 or later, the colours set in the Dice tab of the open map’s collection are offered too.'
        });

        this.plugin.settings.diceColors.forEach((entry, index) => {
            new Setting(colorsSection)
                .setName(entry.name || `Colour ${index + 1}`)
                .addText(text => text
                    .setPlaceholder('Name, e.g. Fire')
                    .setValue(entry.name)
                    .onChange(async (value) => {
                        entry.name = value.trim();
                        await this.plugin.saveSettings();
                    }))
                .addColorPicker(color => color
                    .setValue(entry.color)
                    .onChange(async (value) => {
                        entry.color = value;
                        await this.plugin.saveSettings();
                    }))
                .addExtraButton(button => button
                    .setIcon('trash-2')
                    .setTooltip('Remove colour')
                    .onClick(async () => {
                        this.plugin.settings.diceColors.splice(index, 1);
                        await this.plugin.saveSettings();
                        this.display();
                    }));
        });

        new Setting(colorsSection)
            .addButton(button => button
                .setButtonText('Add colour')
                .onClick(async () => {
                    const palette = ['#d64545', '#3b82f6', '#22a06b', '#e0a526', '#8b5cf6', '#1f2937'];
                    const used = new Set(this.plugin.settings.diceColors.map((c) => c.color));
                    const color = palette.find((c) => !used.has(c)) ?? '#ffffff';
                    this.plugin.settings.diceColors.push({
                        id: `color-${Date.now().toString(36)}`,
                        name: '',
                        color
                    });
                    await this.plugin.saveSettings();
                    this.display();
                }));

        // Dice Configuration Section
        const diceSection = this.createCollapsibleSection(containerEl, 'Dice', 'dice');


        new Setting(diceSection)
            .setName('Dice pack')
            .setDesc('A folder under the plugin’s dice/ directory. Its pack.json describes the whole set - the face sheets and normal maps to use, how the art is laid out on each die, how big each one is, how it is finished, and whether its edges are taken off. Copy the folder and edit it to make your own.')
            .addDropdown(dropdown => {
                // display() is synchronous and listing folders is not, so the
                // pack in use goes in on its own and the rest of the list joins
                // it a moment later. The control is usable either way.
                const current = this.plugin.settings.texturePack;
                dropdown.addOption(current, current || 'None');
                dropdown.setValue(current);
                dropdown.onChange(async (value) => {
                    this.plugin.settings.texturePack = value;
                    await this.plugin.saveSettings();
                    await this.plugin.applyTexturePack();
                    this.plugin.refreshDiceView();
                });
                void this.plugin.listTexturePacks().then((packs) => {
                    for (const pack of packs) {
                        if (pack !== current) dropdown.addOption(pack, pack);
                    }
                });
            })
            .addExtraButton(button => button
                .setIcon('folder-open')
                .setTooltip('Open dice packs folder')
                .onClick(() => { void this.plugin.openPacksFolder(); }))
            .addExtraButton(button => button
                .setIcon('refresh-cw')
                .setTooltip('Reload dice packs')
                .onClick(() => {
                    // Packs are offered to Atlas as dice looks; read them again too.
                    void this.plugin.atlasLooks?.refresh();
                    this.display();
                }));

        // Atlas VTT 1.16+ only; on an older Atlas the note is simply not true, so say so.
        new Setting(diceSection)
            .setName('Atlas dice looks')
            .setDesc('With Atlas VTT 1.16 or later, each dice pack also appears in Atlas’s dice look setting, so Atlas’s own 3D dice can wear it; from 1.18 they wear its whole faces, and Atlas’s asset manager gets a Dice packs tab to pick a pack per collection. Reload the packs after editing one. This does not change the dice rolled here.');

        new Setting(diceSection)
            .setName('Dice size')
            .setDesc('Size of the dice (0.5 = small, 1.5 = large)')
            .addSlider(slider => slider
                .setLimits(0.3, 2.0, 0.1)
                .setValue(this.plugin.settings.diceSize)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.diceSize = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshDiceView();
                }));

        // Shadow Settings Section
        const shadowSection = this.createCollapsibleSection(containerEl, 'Shadows', 'shadows');

        new Setting(shadowSection)
            .setName('Dice shadows')
            .setDesc('Draw a soft shadow under each die, shaped like the die itself')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableShadows)
                .onChange(async (value) => {
                    this.plugin.settings.enableShadows = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshDiceView();
                }));

        // Lighting Settings Section
        const lightingSection = this.createCollapsibleSection(containerEl, 'Lighting', 'lighting');

        new Setting(lightingSection).setName('Ambient light').setHeading();

        new Setting(lightingSection)
            .setName('Ambient light intensity')
            .setDesc('Overall brightness of the scene (0 = dark, 3 = very bright)')
            .addSlider(slider => slider
                .setLimits(0, 3, 0.1)
                .setValue(this.plugin.settings.ambientLightIntensity)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.ambientLightIntensity = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshDiceView();
                }));

        new Setting(lightingSection)
            .setName('Ambient light color')
            .setDesc('Color of the ambient lighting')
            .addColorPicker(color => color
                .setValue(this.plugin.settings.ambientLightColor)
                .onChange(async (value) => {
                    this.plugin.settings.ambientLightColor = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshDiceView();
                }));

        new Setting(lightingSection).setName('Directional light').setHeading();

        new Setting(lightingSection)
            .setName('Directional light intensity')
            .setDesc('Strength of directional lighting (0 = no directional light, 2 = very strong)')
            .addSlider(slider => slider
                .setLimits(0, 2, 0.1)
                .setValue(this.plugin.settings.directionalLightIntensity)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.directionalLightIntensity = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshDiceView();
                }));

        new Setting(lightingSection)
            .setName('Directional light color')
            .setDesc('Color of the directional lighting')
            .addColorPicker(color => color
                .setValue(this.plugin.settings.directionalLightColor)
                .onChange(async (value) => {
                    this.plugin.settings.directionalLightColor = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshDiceView();
                }));

        new Setting(lightingSection)
            .setName('Light horizontal position')
            .setDesc('Horizontal position of the directional light (-50 to 50)')
            .addSlider(slider => slider
                .setLimits(-50, 50, 1)
                .setValue(this.plugin.settings.directionalLightPositionX)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.directionalLightPositionX = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshDiceView();
                }));

        new Setting(lightingSection)
            .setName('Light height')
            .setDesc('Vertical position of the directional light (0 to 100)')
            .addSlider(slider => slider
                .setLimits(0, 100, 1)
                .setValue(this.plugin.settings.directionalLightPositionY)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.directionalLightPositionY = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshDiceView();
                }));

        new Setting(lightingSection)
            .setName('Light depth')
            .setDesc('Depth position of the directional light (-50 to 50)')
            .addSlider(slider => slider
                .setLimits(-50, 50, 1)
                .setValue(this.plugin.settings.directionalLightPositionZ)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.directionalLightPositionZ = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshDiceView();
                }));

        // Motion Detection Settings Section
        const motionSection = this.createCollapsibleSection(containerEl, 'Motion detection', 'motion');

        new Setting(motionSection)
            .setName('Motion threshold')
            .setDesc('How still the dice must be before detecting the result. Higher values = wait longer for complete stillness. Timeout extends by +1 second per unit.')
            .addSlider(slider => slider
                .setLimits(0.1, 10.0, 0.1)
                .setValue(this.plugin.settings.motionThreshold)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.motionThreshold = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshDiceView();
                }));

        // Add explanatory text
        motionSection.createDiv({
            cls: 'setting-item-description dice-settings-note',
            text: 'Examples: 1.0 = normal, 5.0 = very patient (9sec timeout), 10.0 = extremely patient (14sec timeout)'
        });

        new Setting(motionSection)
            .setName('Face detection tolerance')
            .setDesc('How precisely a face must be aligned to be considered valid (0.05 = very strict, 0.5 = relaxed). Dice that don\'t meet this threshold are CAUGHT and highlighted for reroll.')
            .addSlider(slider => slider
                .setLimits(0.05, 0.5, 0.05)
                .setValue(this.plugin.settings.faceDetectionTolerance)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.faceDetectionTolerance = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshDiceView();
                }));

        new Setting(motionSection)
            .setName('Highlight completed dice')
            .setDesc('Glow dice that have settled with a valid result. The glow washes over the whole die, hiding its colour while it is on.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.highlightCompletedDice)
                .onChange(async (value) => {
                    this.plugin.settings.highlightCompletedDice = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshDiceView();
                }));

        new Setting(motionSection)
            .setName('Completed dice highlight color')
            .setDesc('Color to highlight dice that have successfully settled with a valid result')
            .addColorPicker(color => color
                .setValue(this.plugin.settings.completedDiceHighlightColor)
                .onChange(async (value) => {
                    this.plugin.settings.completedDiceHighlightColor = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshDiceView();
                }));
    }
}