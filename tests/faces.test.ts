import test from 'node:test';
import assert from 'node:assert/strict';
import { readFace, type Quat, type Vec3 } from '../kit/faces';

// Six faces, +y first and -y last, so a d6 reads 6 up and 1 down.
const normals: Vec3[] = [
    { x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }, { x: 0, y: -1, z: 0 },
];
const numbers = [6, 2, 5, 3, 4, 1];
// Four faces for the d4, which reads the one pointing down.
const d4Normals: Vec3[] = [{ x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }];
const identity: Quat = { x: 0, y: 0, z: 0, w: 1 };
const aboutX = (angle: number): Quat => ({ x: Math.sin(angle / 2), y: 0, z: 0, w: Math.cos(angle / 2) });

test('identity quaternion reads the face whose normal is +y', () => {
    const reading = readFace('d6', normals, numbers, identity, 0.1);
    assert.equal(reading.caught, false);
    assert.equal(reading.face, 6);
});

test('d4 reads the face pointing down', () => {
    const reading = readFace('d4', d4Normals, [4, 1, 2, 3], identity, 0.1);
    assert.equal(reading.caught, false);
    assert.equal(reading.face, 1);
});

test('tilted 45 degrees about x is caught with no face', () => {
    const reading = readFace('d6', normals, numbers, aboutX(Math.PI / 4), 0.1);
    assert.equal(reading.caught, true);
    assert.equal(reading.face, null);
});

test('tolerance edge: a tilt with dot exactly 1 - tolerance is not caught', () => {
    const q = aboutX(Math.PI / 3);
    const dot = readFace('d6', normals, numbers, q, 1).confidence;
    assert.equal(readFace('d6', normals, numbers, q, 1 - dot).caught, false);
    assert.equal(readFace('d6', normals, numbers, q, 1 - dot - 1e-6).caught, true);
});

test('a table of the wrong size is caught, never read', () => {
    // A d6 given two faces would otherwise read as if it were landed flat.
    const short = readFace('d6', normals.slice(0, 2), numbers.slice(0, 2), identity, 0.1);
    assert.equal(short.caught, true);
    assert.equal(short.face, null);
    // More numbers than normals is just as wrong.
    assert.equal(readFace('d6', normals, [...numbers, 7], identity, 0.1).caught, true);
});

test('a number that is not on the die is caught, never read', () => {
    const d100Normals = Array.from({ length: 10 }, (_, i) => (i === 0 ? { x: 0, y: 1, z: 0 } : { x: 0, y: -1, z: 0 }));
    const tens = Array.from({ length: 10 }, (_, i) => i * 10);
    assert.equal(readFace('d100', d100Normals, tens, identity, 0.1).face, 0);
    // Past the die's top number, or not a whole number.
    assert.equal(readFace('d100', d100Normals, [...tens.slice(1), 101], identity, 0.1).caught, true);
    assert.equal(readFace('d6', normals, [7, 2, 5, 3, 4, 1], identity, 0.1).caught, true);
    assert.equal(readFace('d6', normals, [1.5, 2, 5, 3, 4, 6], identity, 0.1).caught, true);
    assert.equal(readFace('d6', normals, [-1, 2, 5, 3, 4, 6], identity, 0.1).caught, true);
});

test('a table that repeats a number is caught, never read', () => {
    const reading = readFace('d6', normals, [6, 2, 5, 3, 4, 6], identity, 0.1);
    assert.equal(reading.caught, true);
    assert.equal(reading.face, null);
});

test('a d10 may number its faces 0-9 or 1-10, and no higher', () => {
    const d10Normals = Array.from({ length: 10 }, (_, i) => (i === 0 ? { x: 0, y: 1, z: 0 } : { x: 0, y: -1, z: 0 }));
    assert.equal(readFace('d10', d10Normals, Array.from({ length: 10 }, (_, i) => i), identity, 0.1).face, 0);
    assert.equal(readFace('d10', d10Normals, Array.from({ length: 10 }, (_, i) => i + 1), identity, 0.1).face, 1);
    assert.equal(readFace('d10', d10Normals, Array.from({ length: 10 }, (_, i) => i + 2), identity, 0.1).caught, true);
});
