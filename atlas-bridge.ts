import type { RolledDie } from './d20-dice';

/**
 * Hands settled rolls to Atlas VTT.
 *
 * Atlas has no public API for dice, but everything that shows a roll - the DM
 * toast, the roll sound, the roll log saved with the map and the player view -
 * listens for one DOM event on the main window's document. Dispatching it is
 * all it takes, and nothing happens when Atlas is not installed.
 */
const ATLAS_DICE_EVENT = 'atlas-dice-rolled';

/** Shape of Atlas' `DiceRollResult` (atlas-vtt src/app/tools/DiceTool.ts). */
interface AtlasDiceRoll {
    id: string;
    timestamp: number;
    formula: string;
    /** `color` and `colorName` are extras: the die's colour, for an Atlas that shows it. */
    rolls: Array<{ die: string; value: number; max: number; color?: string; colorName?: string }>;
    modifiers: number;
    total: number;
    player?: string;
    source?: { type: 'toolbar' | 'statblock' };
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

/** A settled die, with the name of its colour when it was added in one. */
export type AtlasRolledDie = RolledDie & { colorName?: string | null };

export function toAtlasRoll(dice: AtlasRolledDie[], now = Date.now()): AtlasDiceRoll {
    return {
        id: `physical_${now}_${Math.random().toString(36).slice(2, 8)}`,
        timestamp: now,
        formula: formulaOf(dice),
        rolls: dice.map((die) => ({
            die: die.type,
            value: die.value,
            max: sidesOf(die.type),
            ...(die.color ? { color: die.color } : {}),
            ...(die.colorName ? { colorName: die.colorName } : {}),
        })),
        modifiers: 0,
        // The same total the overlay shows, so both always agree.
        total: dice.reduce((sum, die) => sum + die.value, 0),
        player: 'Atlas VTT Physical Dice',
        source: { type: 'toolbar' },
    };
}

/**
 * Atlas listens on the main window's document, so this deliberately uses
 * `document` rather than `activeDocument`, which is a popout's while it has focus.
 */
export function sendRollToAtlas(dice: AtlasRolledDie[]): void {
    if (dice.length === 0) return;
    document.dispatchEvent(new CustomEvent(ATLAS_DICE_EVENT, { detail: toAtlasRoll(dice) }));
}
