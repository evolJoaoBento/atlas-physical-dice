import type { DieType } from './faces';

// What to tell the thrower when dice settle on an edge and give no number.
export function caughtMessage(caught: readonly { type: DieType }[]): string | null {
    if (caught.length === 0) return null;
    const counts = new Map<DieType, number>();
    for (const die of caught) counts.set(die.type, (counts.get(die.type) ?? 0) + 1);
    const parts = [...counts].map(([type, count]) => (count === 1 ? type : `${count} ${type}`));
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
    return `${list} caught: roll ${caught.length === 1 ? 'it' : 'them'} again`;
}
