/**
 * How the collection of the map being played rolls dice (the dice set its Dice lab holds), as far as marking a roll
 * critical needs: the critical rule and the kinds of die the set rolls. Read from the map view's own dice tool, as a
 * released Atlas keeps it; every member is checked, and a view that gives none reads as "no rule" (nothing is marked).
 */
export type CritRule = 'natural' | 'roll-under' | 'doubles' | 'high-total' | 'none';

export interface CollectionDice {
    crit: CritRule;
    /** The kinds of die the set rolls (`d20`, `d12`): only they can be critical. */
    kinds: readonly string[];
}

const CRITS: ReadonlySet<string> = new Set(['natural', 'roll-under', 'doubles', 'high-total', 'none']);

type Rec = Record<string, unknown>;
const isObject = (value: unknown): value is Rec => typeof value === 'object' && value !== null;

/** Calls a method of an object by name when it has one; undefined when it has none or it throws. */
function call(target: unknown, method: string): unknown {
    if (!isObject(target) || typeof target[method] !== 'function') return undefined;
    try {
        return (target[method] as () => unknown).call(target);
    } catch {
        return undefined;
    }
}

/** Dice rules as Atlas keeps them: a dice set (`dice: [{count, sides}]`) or a collection's own (`defaultRoll: '1d20'`). */
export function readCollectionDice(raw: unknown): CollectionDice | null {
    if (!isObject(raw) || typeof raw.crit !== 'string' || !CRITS.has(raw.crit)) return null;
    const kinds = new Set<string>();
    if (Array.isArray(raw.dice)) {
        for (const group of raw.dice) {
            if (isObject(group) && typeof group.sides === 'number' && Number.isInteger(group.sides) && group.sides >= 2) kinds.add(`d${group.sides}`);
        }
    } else {
        const match = typeof raw.defaultRoll === 'string' ? /^\d*d(\d+)$/i.exec(raw.defaultRoll.trim()) : null;
        if (match) kinds.add(`d${Number(match[1])}`);
    }
    return kinds.size > 0 ? { crit: raw.crit as CritRule, kinds: [...kinds] } : null;
}

/** The dice rules of a map view: what its dice tool rolls for the map it shows. */
export function viewCollectionDice(view: unknown): CollectionDice | null {
    if (!isObject(view)) return null;
    const tool = call(call(view.serviceManager, 'getToolController'), 'getDiceTool');
    return readCollectionDice(call(tool, 'getDiceRules'));
}

/** A settled die as the roll reports it. */
export interface CritDie {
    type: string;
    value: number;
}

const sidesOf = (type: string): number => parseInt(type.slice(1), 10) || 0;

/**
 * The roll's critical result, from the dice of the set (Atlas's `CritRule`): 'high' a critical success, 'low' a
 * critical failure, undefined none. A critical is decided on the set's own dice only.
 */
export function critOf(rules: CollectionDice, dice: readonly CritDie[]): 'high' | 'low' | undefined {
    const own = dice.filter((die) => rules.kinds.includes(die.type));
    if (own.length === 0) return undefined;
    switch (rules.crit) {
        case 'natural':
            if (own.some((die) => die.value === sidesOf(die.type))) return 'high';
            return own.some((die) => die.value === 1) ? 'low' : undefined;
        case 'roll-under':
            if (own.some((die) => die.value === 1)) return 'high';
            return own.some((die) => die.value === sidesOf(die.type)) ? 'low' : undefined;
        case 'doubles':
            return own.length > 1 && own.every((die) => die.value === own[0].value) ? 'high' : undefined;
        case 'high-total': {
            const sum = own.reduce((total, die) => total + die.value, 0);
            const highest = own.reduce((total, die) => total + sidesOf(die.type), 0);
            return sum >= highest - 1 ? 'high' : undefined;
        }
        default:
            return undefined;
    }
}
