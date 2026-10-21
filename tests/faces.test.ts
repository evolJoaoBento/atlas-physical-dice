import test from 'node:test';
import assert from 'node:assert/strict';
import { readFace, type Quat, type Vec3 } from '../kit/faces';

const normals: Vec3[] = [{ x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }];
const identity: Quat = { x: 0, y: 0, z: 0, w: 1 };
const aboutX = (angle: number): Quat => ({ x: Math.sin(angle / 2), y: 0, z: 0, w: Math.cos(angle / 2) });

test('identity quaternion reads the face whose normal is +y', () => {
    const reading = readFace('d6', normals, [6, 1], identity, 0.1);
    assert.equal(reading.caught, false);
    assert.equal(reading.face, 6);
});

test('d4 reads the face pointing down', () => {
    const reading = readFace('d4', normals, [4, 1], identity, 0.1);
    assert.equal(reading.caught, false);
    assert.equal(reading.face, 1);
});

test('tilted 45 degrees about x is caught with no face', () => {
    const reading = readFace('d6', normals, [6, 1], aboutX(Math.PI / 4), 0.1);
    assert.equal(reading.caught, true);
    assert.equal(reading.face, null);
});

test('tolerance edge: a tilt with dot exactly 1 - tolerance is not caught', () => {
    const q = aboutX(Math.PI / 3);
    const dot = readFace('d6', normals, [6, 1], q, 1).confidence;
    assert.equal(readFace('d6', normals, [6, 1], q, 1 - dot).caught, false);
    assert.equal(readFace('d6', normals, [6, 1], q, 1 - dot - 1e-6).caught, true);
});
