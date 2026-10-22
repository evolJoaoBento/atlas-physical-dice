import test from 'node:test';
import assert from 'node:assert/strict';
import { caughtMessage, rollWaiting, withoutDie } from '../kit/caught';

test('no caught dice gives no message', () => {
    assert.equal(caughtMessage([]), null);
});

test('one caught die', () => {
    assert.equal(caughtMessage([{ type: 'd20' }]), 'd20 caught: roll it again');
});

test('several of one type', () => {
    assert.equal(caughtMessage([{ type: 'd6' }, { type: 'd6' }]), '2 d6 caught: roll them again');
});

test('mixed types', () => {
    assert.equal(caughtMessage([{ type: 'd20' }, { type: 'd6' }, { type: 'd6' }]), 'd20 and 2 d6 caught: roll them again');
});

test('a roll waits while any die is caught or in the air', () => {
    const settled = { isCaught: false, isRolling: false };
    assert.equal(rollWaiting([settled, settled]), false);
    assert.equal(rollWaiting([{ isCaught: true, isRolling: false }, settled]), true);
    assert.equal(rollWaiting([settled, { isCaught: false, isRolling: true }]), true);
});

test('a die leaving the tray takes its caught record with it', () => {
    const idle = { index: 0, isCaught: false, isRolling: false };
    const caught = { index: 1, isCaught: true, isRolling: false };
    // A d20 and a d6; the d6 was thrown alone and caught, then removed.
    const left = withoutDie([idle, caught], 1);
    assert.equal(left.length, 1);
    assert.equal(rollWaiting(left), false);
    // Clearing the tray leaves nothing waiting.
    assert.equal(rollWaiting(withoutDie([caught], 0)), false);
});

test('dice after a removed one move down a place and keep their state', () => {
    const states = [
        { index: 0, isCaught: false, isRolling: false },
        { index: 1, isCaught: false, isRolling: false },
        { index: 2, isCaught: true, isRolling: false },
    ];
    const left = withoutDie(states, 0);
    assert.deepEqual(left, [
        { index: 0, isCaught: false, isRolling: false },
        { index: 1, isCaught: true, isRolling: false },
    ]);
    assert.equal(rollWaiting(left), true);
    assert.equal(states[2].index, 2, 'the old states are not changed');
});
