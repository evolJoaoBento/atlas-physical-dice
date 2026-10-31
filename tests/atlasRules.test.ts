import test from 'node:test';
import assert from 'node:assert/strict';
import { critOf, readCollectionDice, viewCollectionDice } from '../atlas-rules';

const d20 = { crit: 'natural', kinds: ['d20'] } as const;

test('a dice set, or a collection\'s own dice, reads as its critical rule and kinds of die', () => {
    assert.deepEqual(readCollectionDice({ dice: [{ count: 1, sides: 12, colour: '#7e22ce' }, { count: 1, sides: 12 }], crit: 'natural' }), { crit: 'natural', kinds: ['d12'] });
    assert.deepEqual(readCollectionDice({ dice: [{ count: 1, sides: 20 }, { count: 2, sides: 6 }], crit: 'none' }), { crit: 'none', kinds: ['d20', 'd6'] });
    assert.deepEqual(readCollectionDice({ defaultRoll: '2d10', crit: 'high-total' }), { crit: 'high-total', kinds: ['d10'] });
    for (const bad of [null, 'x', {}, { dice: [], crit: 'natural' }, { defaultRoll: '1d20', crit: 'sideways' }, { defaultRoll: 'nope', crit: 'natural' }]) {
        assert.equal(readCollectionDice(bad), null);
    }
});

test('the rules come from the view\'s dice tool, and a view without one gives none', () => {
    const view = { serviceManager: { getToolController: () => ({ getDiceTool: () => ({ getDiceRules: () => ({ dice: [{ count: 1, sides: 20 }], crit: 'roll-under' }) }) }) } };
    assert.deepEqual(viewCollectionDice(view), { crit: 'roll-under', kinds: ['d20'] });
    assert.equal(viewCollectionDice({}), null);
    assert.equal(viewCollectionDice({ serviceManager: { getToolController: () => { throw new Error('gone'); } } }), null);
    assert.equal(viewCollectionDice(null), null);
});

test('natural: the highest face is a critical success, a 1 a critical failure, on the set\'s dice only', () => {
    assert.equal(critOf(d20, [{ type: 'd20', value: 20 }]), 'high');
    assert.equal(critOf(d20, [{ type: 'd20', value: 1 }]), 'low');
    assert.equal(critOf(d20, [{ type: 'd20', value: 12 }]), undefined);
    assert.equal(critOf(d20, [{ type: 'd6', value: 6 }]), undefined, 'a die the set does not roll is never critical');
    assert.equal(critOf(d20, [{ type: 'd20', value: 7 }, { type: 'd6', value: 6 }]), undefined);
    assert.equal(critOf(d20, []), undefined);
});

test('roll-under, doubles, high-total and none', () => {
    assert.equal(critOf({ crit: 'roll-under', kinds: ['d100'] }, [{ type: 'd100', value: 1 }]), 'high');
    assert.equal(critOf({ crit: 'roll-under', kinds: ['d100'] }, [{ type: 'd100', value: 100 }]), 'low');
    const twelves = { crit: 'doubles', kinds: ['d12'] } as const;
    assert.equal(critOf(twelves, [{ type: 'd12', value: 7 }, { type: 'd12', value: 7 }]), 'high');
    assert.equal(critOf(twelves, [{ type: 'd12', value: 7 }, { type: 'd12', value: 4 }]), undefined);
    assert.equal(critOf(twelves, [{ type: 'd12', value: 7 }]), undefined, 'one die cannot be a double');
    const tens = { crit: 'high-total', kinds: ['d10'] } as const;
    assert.equal(critOf(tens, [{ type: 'd10', value: 10 }, { type: 'd10', value: 9 }]), 'high');
    assert.equal(critOf(tens, [{ type: 'd10', value: 10 }, { type: 'd10', value: 8 }]), undefined);
    assert.equal(critOf({ crit: 'none', kinds: ['d20'] }, [{ type: 'd20', value: 20 }]), undefined);
});
