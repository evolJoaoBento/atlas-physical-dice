import test from 'node:test';
import assert from 'node:assert/strict';
import { caughtMessage, rollWaiting } from '../kit/caught';

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
