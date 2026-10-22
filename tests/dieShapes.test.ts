import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DIE_TYPES, readFace, type DieType } from '../kit/faces';
import { dieFaceNormals, dieFaceNumbers, dieGeometry, diePhysicsShape, type DicePack } from '../kit/dieShapes';
import packJson from '../dice/Texture-Pack-Default/pack.json';

// The shipped default pack: it carries the numbers and polygon atlases the tray actually uses.
const pack = packJson as unknown as DicePack;
const FACE_COUNT: Record<DieType, number> = { d4: 4, d6: 6, d8: 8, d10: 10, d100: 10, d12: 12, d20: 20 };
const NUMBERS: Record<DieType, number[]> = {
    d4: [1, 2, 3, 4],
    d6: [1, 2, 3, 4, 5, 6],
    d8: [1, 2, 3, 4, 5, 6, 7, 8],
    d10: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    d100: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90],
    d12: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    d20: Array.from({ length: 20 }, (_, i) => i + 1),
};

/** Centre of the i-th numbered face, as the geometry lays the faces out. */
function faceCentroid(geometry: THREE.BufferGeometry, face: number, faceCount: number): THREE.Vector3 {
    const position = geometry.attributes.position;
    const perFace = (geometry.userData.faceVertexCount as number) || position.count / faceCount;
    const centre = new THREE.Vector3();
    for (let v = 0; v < perFace; v++) centre.add(new THREE.Vector3().fromBufferAttribute(position, face * perFace + v));
    return centre.divideScalar(perFace);
}

test('every die type has as many face normals as faces', () => {
    for (const type of DIE_TYPES) {
        const { normals, numbers } = dieFaceNormals(type, dieGeometry(type, 1, pack));
        assert.equal(normals.length, FACE_COUNT[type], type);
        assert.deepEqual(numbers.slice().sort((a, b) => a - b), NUMBERS[type], type);
    }
});

test('normals are unit length and outward', () => {
    for (const type of DIE_TYPES) {
        const geometry = dieGeometry(type, 1, pack);
        const { normals } = dieFaceNormals(type, geometry);
        normals.forEach((n, i) => {
            assert.ok(Math.abs(Math.hypot(n.x, n.y, n.z) - 1) < 1e-6, `${type} face ${i} length`);
            const centre = faceCentroid(geometry, i, normals.length);
            assert.ok(n.x * centre.x + n.y * centre.y + n.z * centre.z > 0, `${type} face ${i} outward`);
        });
    }
});

test('physics shape has the geometry vertex count after merging', () => {
    for (const type of DIE_TYPES) {
        const geometry = dieGeometry(type, 1, pack);
        const shape = diePhysicsShape(type, geometry);
        assert.ok(shape.vertices.length <= geometry.attributes.position.count, `${type} vertices`);
        assert.ok(shape.faces.length >= FACE_COUNT[type], `${type} faces`);
    }
});

test('each face read upright reads its own number', () => {
    for (const type of DIE_TYPES) {
        const { normals, numbers } = dieFaceNormals(type, dieGeometry(type, 1, pack));
        const up = new THREE.Vector3(0, type === 'd4' ? -1 : 1, 0);
        normals.forEach((n, i) => {
            const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(n.x, n.y, n.z), up);
            assert.equal(readFace(type, normals, numbers, q, 0.01).face, numbers[i], `${type} face ${i}`);
        });
    }
});

test('a d100 with no pack numbers counts tens from 00, never ones', () => {
    assert.deepEqual(dieFaceNumbers('d100', {} as DicePack, 10), [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
});
