import type { DieType } from './faces';

// A roll is still waiting while any die is in the air or caught.
export function rollWaiting(states: readonly { isCaught: boolean; isRolling: boolean }[]): boolean {
    return states.some((state) => state.isCaught || state.isRolling);
}

// What to tell the thrower when dice settle on an edge and give no number.
export function caughtMessage(caught: readonly { type: DieType }[]): string | null {
    if (caught.length === 0) return null;
    const counts = new Map<DieType, number>();
    for (const die of caught) counts.set(die.type, (counts.get(die.type) ?? 0) + 1);
    const parts = [...counts].map(([type, count]) => (count === 1 ? type : `${count} ${type}`));
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
    return `${list} caught: roll ${caught.length === 1 ? 'it' : 'them'} again`;
}

// The states left when the die at `index` leaves the tray: its own record goes with it,
// and the dice after it move down a place, so a removed die can never hold a roll.
export function withoutDie<T extends { index: number }>(states: readonly T[], index: number): T[] {
    return states.filter((_, i) => i !== index).map((state) => (state.index > index ? { ...state, index: state.index - 1 } : state));
}
