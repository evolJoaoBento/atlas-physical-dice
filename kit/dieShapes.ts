// A die's solid, its UVs, which way each face points and its collision hull.
// Renderer-free and settings-free, so Tabletop can copy this file as it is:
// it uses only three and cannon-es API that is the same in three 0.156 and 0.185.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { DieType, Vec3 } from './faces';

/**
 * A cell of a texture pack's atlas: where a number is printed, and which way up.
 *
 * `col`/`row` index a grid over the image, counting from the top-left the way
 * the image reads. `rotation` is quarter turns anticlockwise, for the flaps of
 * a net that fold in rotated - a cube net's bottom flap is printed upside down
 * so that it comes out the right way up on the die.
 */
export interface AtlasQuad {
    number: number;
    col: number;
    row: number;
    rotation: 0 | 1 | 2 | 3;
    /**
     * Which way the digit's top points on the sheet, in degrees clockwise from
     * the top of the image. Only Atlas dice looks read it, to stand the digit up.
     */
    up?: number;
}

/**
 * A face of a net that is not laid out on a grid.
 *
 * A cube unfolds onto squares that tile an image, which is why the d6 gets away
 * with columns and rows. Nothing else does: an octahedron unfolds to a zigzag
 * strip of triangles, a dodecahedron to two rings of pentagons. So a cell here
 * carries its own corners, in pixels of the sheet, read off the art rather than
 * derived - the sheets are drawn by hand and only roughly regular.
 *
 * `turn` says which of the cell's corners the die's first vertex lands on, and
 * `mirror` reverses the winding. Both exist for the same reason as the quad
 * atlas's `rotation`: the artist drew each digit for one particular unfolding,
 * and nothing in the geometry knows which.
 */
export interface AtlasFace {
    number: number;
    /** As on `AtlasQuad`: which way the digit's top points on the sheet, in degrees clockwise. */
    up?: number;
    /** Corners in sheet pixels, in the order the image draws them. */
    corners: Array<[number, number]>;
    turn: number;
    mirror?: boolean;
    /**
     * Which numbered corner of the die each corner of this cell is, for art
     * that is printed per corner rather than per face.
     *
     * A d4 has no upward face to read, so it is read at a corner instead, and
     * every face carries three digits - one by each corner - rather than one in
     * the middle. Fold the net up and the three digits that meet at a corner all
     * agree: 1 at the three outer corners of the sheet, and 3, 2 and 4 at the
     * midpoints. So a corner of the die owns a number, and lining the cell up
     * means matching corners to corners, not counting turns. Where this is set
     * `turn` and `mirror` are not consulted; there is nothing left for them to
     * decide.
     */
    vertices?: number[];
}

/**
 * A texture pack, as its pack.json describes it.
 *
 * Everything here used to be tables in this file, which meant a pack could
 * change what a die looked like but not how its art was laid out, how big it
 * was, or whether it had its edges taken off. A pack now brings all of that
 * with it: copy the folder, edit the images, describe them, and it is a
 * different set of dice.
 *
 * `numbers` is the one entry that is not free. It says which number each
 * geometry face carries, and the face order is three.js's, not the art's - so
 * it exists here to be kept in step with the cells, not to be chosen. The
 * values ship paired so opposite faces sum the way a die's should.
 */
export interface PackDie {
    /**
     * Which solid to build, when it is not the one the die is named after.
     *
     * A percentile die is a d10 with different numbers on it, not a different
     * shape, so it says `"geometry": "d10"` and gets the same hull, the same
     * ten faces and the same blob shadow. Everything else about it - its art,
     * its numbers, its size - is still its own.
     */
    geometry?: string;
    /** Face sheet, relative to the pack folder. */
    texture?: string;
    /** Normal map, same folder, optional. */
    normal?: string;
    /** Size relative to the other dice in the set. */
    scale?: number;
    /** This die's own colour, for a set that is not all one. */
    color?: string;
    /** A patch of sheet with nothing on it, for a bevel's rim to wear. */
    rimUV?: [number, number];
    /** Number per geometry face. See above. */
    numbers?: number[];
    /** Cells on a grid, for a net that lies on one - a cube's cross. */
    grid?: { cols: number; rows: number; cells: AtlasQuad[] };
    /** Sheet edge in pixels, for cells given as corners. */
    sheetSize?: number;
    /** Cells as corners, for a net that lies on no grid. */
    faces?: AtlasFace[];
}

export interface DicePack {
    name?: string;
    /** What the set is made of, unless a die says otherwise. */
    color?: string;
    /**
     * Edges taken off. `smooth` rounds the rim's shading from 0 (a flat
     * chamfer) to 1 (light running continuously round the corner), and costs
     * nothing: it changes normals, not geometry.
     */
    bevel?: { enabled?: boolean; depth?: number; smooth?: number };
    material?: { shininess?: number; specular?: string; transparent?: boolean; opacity?: number };
    dice?: Record<string, PackDie>;
}

/** What a die falls back to when its pack says nothing about it. */
export const PACK_FALLBACK: Required<Pick<PackDie, 'scale' | 'rimUV' | 'color'>> = {
    scale: 1,
    rimUV: [0.97, 0.97],
    color: '#ff4444'
};

const BEVEL_FALLBACK = { enabled: true, depth: 0.1, smooth: 0 };

/**
 * What a pack says about one die. An empty pack is a working state: a die with
 * nothing said about it keeps its own proportions and the geometry's own UVs.
 */
export function packDie(diceType: string, pack: DicePack): PackDie {
    return pack.dice?.[diceType] || {};
}

/** Which number each geometry face carries, or nothing if the pack is silent. */
function numbersFor(diceType: string, pack: DicePack): number[] | null {
    const numbers = packDie(diceType, pack).numbers;
    return numbers && numbers.length ? numbers : null;
}

export function dieScale(diceType: string, pack: DicePack): number {
    return packDie(diceType, pack).scale ?? PACK_FALLBACK.scale;
}

/**
 * The solid a die is built from, which is usually the die itself. A percentile
 * die is always a d10: one whose pack lays out no faces of its own (no `faces`
 * or `grid`, or no pack.json at all) is built, laid out and read as the d10 it
 * is, and numbered in tens - never as a d20 that no face table fits.
 */
export function dieSolid(diceType: string, pack: DicePack): string {
    const entry = packDie(diceType, pack);
    if (diceType === 'd100') return entry.faces || entry.grid ? entry.geometry || 'd10' : 'd10';
    return entry.geometry || diceType;
}

/**
 * What colour a die is.
 *
 * The pack's, not the roller's: a set is red or bone or black the way it is
 * a particular shape, and a percentile die that does not match the d10 it
 * pairs with is a different set. A die may still say its own, for a set that
 * is not all one colour.
 */
export function dieColor(diceType: string, pack: DicePack): string {
    return packDie(diceType, pack).color || pack.color || PACK_FALLBACK.color;
}

export function dieFaceCount(diceType: string, pack: DicePack): number {
    return dieFaceCountOfSolid(dieSolid(diceType, pack));
}

function dieFaceCountOfSolid(solid: string): number {
    switch (solid) {
        case 'd4': return 4;
        case 'd6': return 6;
        case 'd8': return 8;
        case 'd10': return 10;
        case 'd12': return 12;
        case 'd20': return 20;
        default: return 20;
    }
}

function createD10PolyhedronGeometry(size: number): THREE.BufferGeometry {
    // Based on react-3d-dice implementation
    const sides = 10;
    const vertices: number[] = [0, 0, 1, 0, 0, -1];

    // Create vertices around the middle
    for (let i = 0; i < sides; ++i) {
        const angle = (i * Math.PI * 2) / sides;
        vertices.push(
            -Math.cos(angle),
            -Math.sin(angle),
            0.105 * (i % 2 ? 1 : -1)
        );
    }

    /*
     * Twenty triangles, two to a face: a d10's faces are kites, and each is
     * a pair of these sharing the edge from the apex to the corner the kite
     * is built around.
     *
     * The order matters, because everything downstream reads a face as two
     * triangles running together in the buffer. A kite is only a kite if the
     * corner in the middle of its three equatorial ones sits on the far side
     * of the equator from its apex - the near corner and the two shoulders
     * have to fall on opposite sides, or the four are not even coplanar. The
     * top fan used to start one triangle early, which built its five faces
     * around the corners nearest the apex instead of the ones furthest from
     * it. They came out a different shape from the bottom five, and the art
     * laid on them was stretched to match. Starting at [0, 11, 2] fixes it;
     * the bottom fan was already right.
     */
    const faces = [
        [0, 11, 2], [0, 2, 3], [0, 3, 4], [0, 4, 5], [0, 5, 6],
        [0, 6, 7], [0, 7, 8], [0, 8, 9], [0, 9, 10], [0, 10, 11],
        [1, 3, 2], [1, 4, 3], [1, 5, 4], [1, 6, 5], [1, 7, 6],
        [1, 8, 7], [1, 9, 8], [1, 10, 9], [1, 11, 10], [1, 2, 11]
    ];

    // Create THREE.js PolyhedronGeometry
    const geometry = new THREE.PolyhedronGeometry(
        vertices,
        faces.flat(),
        size,
        0  // Detail level 0 for sharp edges
    );

    return geometry;
}

function applyD10UVMapping(geometry: THREE.BufferGeometry): void {
    // Convert to non-indexed geometry
    const nonIndexedGeometry = geometry.index ? geometry.toNonIndexed() : geometry;
    geometry.attributes = nonIndexedGeometry.attributes;
    geometry.index = null;

    const uvAttribute = geometry.attributes.uv;
    const uvArray = uvAttribute.array as Float32Array;
    const positionAttribute = geometry.attributes.position;
    const positionArray = positionAttribute.array as Float32Array;

    const totalTriangles = uvAttribute.count / 3;

    // 5x2 grid for 10 faces
    const cols = 5;
    const rows = 2;
    const cellWidth = 1.0 / cols;
    const cellHeight = 1.0 / rows;
    const padding = 0.02;

    // Group triangles by face based on normals
    const faceGroups: number[][] = [];
    const faceNormals: THREE.Vector3[] = [];

    for (let i = 0; i < totalTriangles; i++) {
        const vertexOffset = i * 3;

        // Calculate triangle normal
        const v1 = new THREE.Vector3(
            positionArray[vertexOffset * 3],
            positionArray[vertexOffset * 3 + 1],
            positionArray[vertexOffset * 3 + 2]
        );
        const v2 = new THREE.Vector3(
            positionArray[(vertexOffset + 1) * 3],
            positionArray[(vertexOffset + 1) * 3 + 1],
            positionArray[(vertexOffset + 1) * 3 + 2]
        );
        const v3 = new THREE.Vector3(
            positionArray[(vertexOffset + 2) * 3],
            positionArray[(vertexOffset + 2) * 3 + 1],
            positionArray[(vertexOffset + 2) * 3 + 2]
        );

        const edge1 = new THREE.Vector3().subVectors(v2, v1);
        const edge2 = new THREE.Vector3().subVectors(v3, v1);
        const normal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();

        // Find or create face group
        let faceIndex = -1;
        for (let j = 0; j < faceNormals.length; j++) {
            if (faceNormals[j].dot(normal) > 0.95) {
                faceIndex = j;
                break;
            }
        }

        if (faceIndex === -1) {
            faceIndex = faceNormals.length;
            faceNormals.push(normal.clone());
            faceGroups.push([]);
        }

        faceGroups[faceIndex].push(i);
    }


    // Map each face group to UV coordinates
    for (let faceIndex = 0; faceIndex < Math.min(faceGroups.length, 10); faceIndex++) {
        const triangles = faceGroups[faceIndex];

        //// Calculate face normal to determine if it's top or bottom hemisphere
        //const firstTriangle = triangles[0];
        //const vertexOffset = firstTriangle * 3;
        //const v1 = new THREE.Vector3(
        //    positionArray[vertexOffset * 3],
        //    positionArray[vertexOffset * 3 + 1],
        //    positionArray[vertexOffset * 3 + 2]
        //);
        //const v2 = new THREE.Vector3(
        //    positionArray[(vertexOffset + 1) * 3],
        //    positionArray[(vertexOffset + 1) * 3 + 1],
        //    positionArray[(vertexOffset + 1) * 3 + 2]
        //);
        //const v3 = new THREE.Vector3(
        //    positionArray[(vertexOffset + 2) * 3],
        //    positionArray[(vertexOffset + 2) * 3 + 1],
        //    positionArray[(vertexOffset + 2) * 3 + 2]
        //);

        //// Calculate face center and normal
        //const faceCenter = new THREE.Vector3().addVectors(v1, v2).add(v3).divideScalar(3);
        //const edge1 = new THREE.Vector3().subVectors(v2, v1);
        //const edge2 = new THREE.Vector3().subVectors(v3, v1);
        //const faceNormal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();

        // Determine if this is a top face (Y > 0) or bottom face (Y < 0)
        /*const isTopFace = faceCenter.y > 0;*/

        const isTopFace = faceIndex >= 1 && faceIndex <=4;

        const col = faceIndex % cols;
        const row = Math.floor(faceIndex / cols);

        const cellLeft = col * cellWidth + padding;
        const cellRight = (col + 1) * cellWidth - padding;
        const cellTop = row * cellHeight + padding;
        const cellBottom = (row + 1) * cellHeight - padding;

        const cellCenterX = (cellLeft + cellRight) / 2;

        // Define the 4 vertices of the kite shape (top 80%, bottom 20%)
        const kiteCenter = cellTop + (cellBottom - cellTop) * 0.8; // 80% down from top
        let kiteVertices: Array<{ x: number; y: number }>;


        // Map triangles to the kite
        for (let t = 0; t < triangles.length; t++) {
            const triangleIndex = triangles[t];
            const vertexOffset = triangleIndex * 3;
            const uvIndex = vertexOffset * 2;

            if (isTopFace) {
                kiteVertices = [
                    { x: cellCenterX, y: cellTop },        // Top vertex (0)
                    { x: cellLeft, y: kiteCenter },       // Right vertex (1) - at 80% point
                    { x: cellCenterX, y: cellBottom },     // Bottom vertex (2)
                    { x: cellRight, y: kiteCenter }         // Left vertex (3) - at 80% point
                ];
                if (t === 0) {
                    // First triangle
                    uvArray[uvIndex] = kiteVertices[3].x;
                    uvArray[uvIndex + 1] = kiteVertices[3].y;
                    uvArray[uvIndex + 2] = kiteVertices[2].x;
                    uvArray[uvIndex + 3] = kiteVertices[2].y;
                    uvArray[uvIndex + 4] = kiteVertices[0].x;
                    uvArray[uvIndex + 5] = kiteVertices[0].y;
                } else if (t === 1) {
                    // Second triangle
                    uvArray[uvIndex] = kiteVertices[2].x;
                    uvArray[uvIndex + 1] = kiteVertices[2].y;
                    uvArray[uvIndex + 2] = kiteVertices[1].x;
                    uvArray[uvIndex + 3] = kiteVertices[1].y;
                    uvArray[uvIndex + 4] = kiteVertices[0].x;
                    uvArray[uvIndex + 5] = kiteVertices[0].y;
                }
            } else {
                kiteVertices = [
                    { x: cellCenterX, y: cellBottom },        // Top vertex (0)
                    { x: cellRight, y: kiteCenter },       // Right vertex (1) - at 80% point
                    { x: cellCenterX, y: cellTop },     // Bottom vertex (2)
                    { x: cellLeft, y: kiteCenter }         // Left vertex (3) - at 80% point
                ];
                if (t === 0) {
                    // First triangle
                    uvArray[uvIndex] = kiteVertices[0].x;
                    uvArray[uvIndex + 1] = kiteVertices[0].y;
                    uvArray[uvIndex + 2] = kiteVertices[3].x;
                    uvArray[uvIndex + 3] = kiteVertices[3].y;
                    uvArray[uvIndex + 4] = kiteVertices[2].x;
                    uvArray[uvIndex + 5] = kiteVertices[2].y;
                } else if (t === 1) {
                    // Second triangle
                    uvArray[uvIndex] = kiteVertices[1].x;
                    uvArray[uvIndex + 1] = kiteVertices[1].y;
                    uvArray[uvIndex + 2] = kiteVertices[0].x;
                    uvArray[uvIndex + 3] = kiteVertices[0].y;
                    uvArray[uvIndex + 4] = kiteVertices[2].x;
                    uvArray[uvIndex + 5] = kiteVertices[2].y;
                }
            }
        }
    }

    uvAttribute.needsUpdate = true;
}

function applyTriangleUVMapping(geometry: THREE.BufferGeometry, faceCount: number): void {
    // Convert to non-indexed geometry so each face has its own vertices
    const nonIndexedGeometry = geometry.index ? geometry.toNonIndexed() : geometry;
    geometry.attributes = nonIndexedGeometry.attributes;
    geometry.index = null;

    const uvAttribute = geometry.attributes.uv;
    const uvArray = uvAttribute.array as Float32Array;

    // Define UV layout in a grid that matches the template generation
    let cols, rows;
    if (faceCount === 4) {
        // D4: 2x2 grid to match template
        cols = 2;
        rows = 2;
    } else if (faceCount === 8) {
        // D8: 3x3 grid to match template
        cols = 3;
        rows = 3;
    } else if (faceCount === 12) {
        // D12: 4x3 grid to match template
        cols = 4;
        rows = 3;
    } else if (faceCount === 20) {
        // D20: 5x4 grid to match template
        cols = 5;
        rows = 4;
    } else {
        // Fallback: square-ish grid
        cols = Math.ceil(Math.sqrt(faceCount));
        rows = Math.ceil(faceCount / cols);
    }

    const cellWidth = 1.0 / cols;
    const cellHeight = 1.0 / rows;
    const padding = 0.02; // Small padding between triangles

    for (let faceIndex = 0; faceIndex < faceCount; faceIndex++) {
        // Calculate grid position
        const col = faceIndex % cols;
        const row = Math.floor(faceIndex / cols);

        // Calculate cell bounds with padding
        const cellLeft = col * cellWidth + padding;
        const cellRight = (col + 1) * cellWidth - padding;
        const cellTop = row * cellHeight + padding;
        const cellBottom = (row + 1) * cellHeight - padding;

        // Calculate cell center and size
        const cellCenterX = (cellLeft + cellRight) / 2;
        const cellW = cellRight - cellLeft;
        const cellH = cellBottom - cellTop;

        // Create equilateral triangle that fits within the cell
        const triangleHeight = Math.min(cellH, cellW * Math.sqrt(3) / 2);
        const triangleWidth = triangleHeight * 2 / Math.sqrt(3);

        // All triangles point up for consistency
        const v1 = {
            x: cellCenterX,
            y: cellTop
        };

        const v2 = {
            x: cellCenterX - triangleWidth / 2,
            y: cellTop + triangleHeight
        };

        const v3 = {
            x: cellCenterX + triangleWidth / 2,
            y: cellTop + triangleHeight
        };

        // Ensure triangles don't exceed cell boundaries
        const vertices = [v1, v2, v3];
        vertices.forEach(v => {
            v.x = Math.max(cellLeft, Math.min(cellRight, v.x));
            v.y = Math.max(cellTop, Math.min(cellBottom, v.y));
        });

        // Set UV coordinates for the three vertices of this face
        const vertexOffset = faceIndex * 3;

        // First vertex UVs (RESTORE D20 Y-FLIP)
        uvArray[(vertexOffset * 2)] = v1.x;
        uvArray[(vertexOffset * 2) + 1] = 1.0 - v1.y;

        // Second vertex UVs (RESTORE D20 Y-FLIP)
        uvArray[(vertexOffset * 2) + 2] = v2.x;
        uvArray[(vertexOffset * 2) + 3] = 1.0 - v2.y;

        // Third vertex UVs (RESTORE D20 Y-FLIP)
        uvArray[(vertexOffset * 2) + 4] = v3.x;
        uvArray[(vertexOffset * 2) + 5] = 1.0 - v3.y;
    }

    // Mark UV attribute as needing update
    uvAttribute.needsUpdate = true;

}

function applySquareUVMapping(geometry: THREE.BufferGeometry): void {
    // BoxGeometry has 6 faces, each with 2 triangles (12 triangles total)
    const uvAttribute = geometry.attributes.uv;
    const uvArray = uvAttribute.array as Float32Array;


    // Define UV layout in a 3x2 grid for 6 faces to match template
    const cols = 3;
    const rows = 2;
    const cellWidth = 1.0 / cols;
    const cellHeight = 1.0 / rows;
    const padding = 0.02;

    // BoxGeometry face order: right, left, top, bottom, front, back
    // Template grid layout:
    // Row 0: [0-right, 1-left, 2-top]
    // Row 1: [3-bottom, 4-front, 5-back]

    for (let faceIndex = 0; faceIndex < 6; faceIndex++) {
        const col = faceIndex % cols;
        const row = Math.floor(faceIndex / cols);

        const cellLeft = col * cellWidth + padding;
        const cellRight = (col + 1) * cellWidth - padding;
        const cellTop = row * cellHeight + padding;
        const cellBottom = (row + 1) * cellHeight - padding;

        // Each face has 2 triangles with 3 vertices each = 6 vertices
        // BoxGeometry uses 4 unique vertices per face with shared vertices for triangles
        const faceVertexStart = faceIndex * 4;

        // For each face, set UV coordinates for the 4 vertices
        // Fix mirroring by using correct orientation
        const uvCoords = [
            [cellLeft, cellBottom],     // Bottom-left
            [cellRight, cellBottom],    // Bottom-right
            [cellLeft, cellTop],        // Top-left
            [cellRight, cellTop]        // Top-right
        ];

        // Apply UV coordinates to each vertex of this face
        for (let vertexIndex = 0; vertexIndex < 4; vertexIndex++) {
            const uvIndex = (faceVertexStart + vertexIndex) * 2;
            uvArray[uvIndex] = uvCoords[vertexIndex][0];     // U coordinate
            uvArray[uvIndex + 1] = uvCoords[vertexIndex][1]; // V coordinate
        }
    }

    uvAttribute.needsUpdate = true;
}

function applyD12PentagonUVMapping(geometry: THREE.BufferGeometry): void {
    // Convert to non-indexed geometry so each triangle has its own vertices
    const nonIndexedGeometry = geometry.index ? geometry.toNonIndexed() : geometry;
    geometry.attributes = nonIndexedGeometry.attributes;
    geometry.index = null;

    const uvAttribute = geometry.attributes.uv;
    const uvArray = uvAttribute.array as Float32Array;


    const totalTriangles = uvAttribute.count / 3;

    // 4x3 grid for 12 pentagon faces on 1024x1024 image
    const cols = 4;
    const rows = 3;
    const cellWidth = 1.0 / cols;
    const cellHeight = 1.0 / rows;
    const padding = 0.02;

    // DodecahedronGeometry creates 60 triangles (5 per face for center-based triangulation)
    const trianglesPerFace = totalTriangles / 12;

    // Process each pentagon face
    for (let faceIndex = 0; faceIndex < 12; faceIndex++) {
        // Calculate grid position
        const col = faceIndex % cols;
        const row = Math.floor(faceIndex / cols);

        // Calculate cell bounds with padding
        const cellLeft = col * cellWidth + padding;
        const cellRight = (col + 1) * cellWidth - padding;
        const cellTop = row * cellHeight + padding;
        const cellBottom = (row + 1) * cellHeight - padding;

        const cellCenterX = (cellLeft + cellRight) / 2;
        const cellCenterY = (cellTop + cellBottom) / 2;
        const cellW = cellRight - cellLeft;
        const cellH = cellBottom - cellTop;
        const pentagonRadius = Math.min(cellW, cellH) * 0.4;

        // Generate pentagon vertices: v1 at top, then clockwise v2, v3, v4, v5
        const pentagonVertices: Array<{ x: number; y: number }> = [];
        for (let i = 0; i < 5; i++) {
            // Start from top (-90°) and go clockwise
            const angle = (i * 2 * Math.PI) / 5 - Math.PI / 2 + (Math.PI / 5);
            pentagonVertices.push({
                x: cellCenterX + Math.cos(angle) * pentagonRadius,
                y: cellCenterY + Math.sin(angle) * pentagonRadius
            });
        }

        // Now pentagonVertices[0] = v1 (top)
        // pentagonVertices[1] = v2 (clockwise from v1)
        // pentagonVertices[2] = v3 (clockwise from v2)
        // pentagonVertices[3] = v4 (clockwise from v3)
        // pentagonVertices[4] = v5 (clockwise from v4)

        // Map triangles for this face
        const baseTriangle = Math.floor(faceIndex * trianglesPerFace);
        const endTriangle = Math.floor((faceIndex + 1) * trianglesPerFace);

        for (let triangleIdx = baseTriangle; triangleIdx < endTriangle && triangleIdx < totalTriangles; triangleIdx++) {
            const localTriangle = triangleIdx - baseTriangle;
            const vertexOffset = triangleIdx * 3;
            const uvIndex = vertexOffset * 2;

            if (trianglesPerFace === 5) {
                // 5 triangles per face: fan from center
                // Each triangle goes from center to two consecutive vertices
                const v1 = { x: cellCenterX, y: cellCenterY }; // Center
                const v2 = pentagonVertices[localTriangle % 5];
                const v3 = pentagonVertices[(localTriangle + 1) % 5];

                uvArray[uvIndex] = v1.x;
                uvArray[uvIndex + 1] = v1.y;
                uvArray[uvIndex + 2] = v2.x;
                uvArray[uvIndex + 3] = v2.y;
                uvArray[uvIndex + 4] = v3.x;
                uvArray[uvIndex + 5] = v3.y;
            } else if (trianglesPerFace === 3) {
                // 3 triangles per face: fan from v1 (top vertex)
                if (localTriangle === 0) {
                    // Third triangle: v1, v4, v5
                    uvArray[uvIndex] = pentagonVertices[4].x;     // v1 (top)
                    uvArray[uvIndex + 1] = pentagonVertices[4].y;
                    uvArray[uvIndex + 2] = pentagonVertices[0].x; // v4
                    uvArray[uvIndex + 3] = pentagonVertices[0].y;
                    uvArray[uvIndex + 4] = pentagonVertices[3].x; // v5
                    uvArray[uvIndex + 5] = pentagonVertices[3].y;
                } else if (localTriangle === 1) {
                    // Second triangle: v1, v3, v4
                    uvArray[uvIndex] = pentagonVertices[2].x;     // v1 (top)
                    uvArray[uvIndex + 1] = pentagonVertices[2].y;
                    uvArray[uvIndex + 2] = pentagonVertices[3].x; // v3
                    uvArray[uvIndex + 3] = pentagonVertices[3].y;
                    uvArray[uvIndex + 4] = pentagonVertices[0].x; // v4
                    uvArray[uvIndex + 5] = pentagonVertices[0].y;
                } else if (localTriangle === 2) {
                    // First triangle: v1, v2, v3
                    uvArray[uvIndex] = pentagonVertices[0].x;     // v1 (top)
                    uvArray[uvIndex + 1] = pentagonVertices[0].y;
                    uvArray[uvIndex + 2] = pentagonVertices[1].x; // v2 (clockwise from v1)
                    uvArray[uvIndex + 3] = pentagonVertices[1].y;
                    uvArray[uvIndex + 4] = pentagonVertices[2].x; // v3 (clockwise from v2)
                    uvArray[uvIndex + 5] = pentagonVertices[2].y;
                    
                }
            } else {
                // Fallback: distribute triangles around pentagon
                const angle = (localTriangle / trianglesPerFace) * Math.PI * 2;
                const nextAngle = ((localTriangle + 1) / trianglesPerFace) * Math.PI * 2;

                uvArray[uvIndex] = cellCenterX;
                uvArray[uvIndex + 1] = cellCenterY;
                uvArray[uvIndex + 2] = cellCenterX + Math.cos(angle) * pentagonRadius;
                uvArray[uvIndex + 3] = cellCenterY + Math.sin(angle) * pentagonRadius;
                uvArray[uvIndex + 4] = cellCenterX + Math.cos(nextAngle) * pentagonRadius;
                uvArray[uvIndex + 5] = cellCenterY + Math.sin(nextAngle) * pentagonRadius;
            }
        }
    }

    uvAttribute.needsUpdate = true;
}

/**
 * Round the rim off, without a single extra vertex.
 *
 * A chamfer built the obvious way is a ring of flat facets, and flat facets
 * read as exactly that: the edge stops being sharp and starts being a
 * bevel, which is a different hard edge. Real dice do not have either - the
 * light slides round the corner.
 *
 * Nothing here changes the shape. Every rim vertex sits on top of vertices
 * belonging to its neighbours - the facets either side of it, and the
 * numbered face it runs alongside - so averaging the normals that meet at a
 * point and pointing all of them the same way makes the light travel
 * continuously across the rim and off onto the face. The silhouette stays
 * faceted, but at a tenth of a die nobody is reading the silhouette.
 *
 * Numbered faces are left alone. They are the part being read, they are
 * meant to be flat, and bending their normals would shade the digit
 * unevenly. Only the rim gets it, so the join is one-sided: the rim leans
 * towards the face it meets and the face does not lean back.
 */
function softenRim(geometry: THREE.BufferGeometry, rimStart: number, smooth: number): void {
    if (smooth <= 0) return;
    const position = geometry.attributes.position;
    const normal = geometry.attributes.normal;

    // Normals meeting at each point, from the whole die - the numbered faces
    // included, which is what lets the rim blend into them.
    const points: THREE.Vector3[] = [];
    const summed: THREE.Vector3[] = [];
    const at: number[] = [];
    const point = new THREE.Vector3();
    for (let v = 0; v < position.count; v++) {
        point.fromBufferAttribute(position, v);
        let found = points.findIndex((p) => p.distanceToSquared(point) < 1e-8);
        if (found < 0) {
            found = points.push(point.clone()) - 1;
            summed.push(new THREE.Vector3());
        }
        at.push(found);
        summed[found].add(new THREE.Vector3().fromBufferAttribute(normal, v));
    }

    const flat = new THREE.Vector3();
    for (let v = rimStart; v < position.count; v++) {
        const shared = summed[at[v]];
        if (shared.lengthSq() < 1e-12) continue;
        flat.fromBufferAttribute(normal, v);
        flat.lerp(shared.clone().normalize(), smooth).normalize();
        normal.setXYZ(v, flat.x, flat.y, flat.z);
    }
    normal.needsUpdate = true;
}

/**
 * Take the edges off a die.
 *
 * Real dice are not sharp, and under this tray's orthographic camera - which
 * looks straight down - a sharp solid loses most of what says it is solid: a
 * cube projects to a plain square and reads as a paper tile. The rim strips
 * face partly sideways, so they take the key light at their own angle and
 * draw a lit border around whatever number is up.
 *
 * Every face is pulled in towards its own centre, which leaves it flat, in
 * the same plane, and the same shape - so the atlas still lands on it
 * exactly as before. The gap that opens along each edge is bridged by a
 * strip, and the gap at each corner by a cap. Those come after the numbered
 * faces in the buffer, so anything walking faces by index has to be told
 * where they stop; that is what faceVertexCount is for.
 *
 * Shrinking towards the centre is a true chamfer only for a regular face.
 * The d10's kites are not regular and come out very slightly uneven, which
 * at the width of a rim is not a thing anyone can see.
 *
 * Physics keeps the full sharp hull. A tenth of a face is not worth a second
 * collision shape, and a die that looks a hair smaller than it collides is
 * the error nobody notices.
 */
function chamferGeometry(
    source: THREE.BufferGeometry,
    faceCount: number,
    bevel: number,
    rimUV: [number, number],
    smooth: number
): THREE.BufferGeometry {
    const geometry = source.index ? source.toNonIndexed() : source;
    if (geometry !== source) source.dispose();

    const pos = geometry.attributes.position;
    const uvAttribute = geometry.attributes.uv;
    const perFace = pos.count / faceCount;
    if (!Number.isInteger(perFace) || perFace < 3) return geometry;

    // Which of the die's corners each buffer vertex sits on. Faces share
    // corners, and the strips and caps are built out of that sharing.
    const corners: THREE.Vector3[] = [];
    const cornerOf: number[] = [];
    for (let v = 0; v < pos.count; v++) {
        const point = new THREE.Vector3().fromBufferAttribute(pos, v);
        let at = corners.findIndex((c) => c.distanceToSquared(point) < 1e-8);
        if (at < 0) at = corners.push(point) - 1;
        cornerOf.push(at);
    }

    const positions = Array.from(pos.array as Float32Array);
    const uvs = uvAttribute ? Array.from(uvAttribute.array as Float32Array) : [];
    const indices: number[] = [];
    for (let i = 0; i < pos.count; i += 3) indices.push(i, i + 1, i + 2);

    // Where each corner of each face ends up once the face is pulled in.
    const pulled: Array<Map<number, THREE.Vector3>> = [];
    const ring: number[][] = [];

    for (let face = 0; face < faceCount; face++) {
        const base = face * perFace;
        const own: number[] = [];
        for (let v = 0; v < perFace; v++) {
            const at = cornerOf[base + v];
            if (!own.includes(at)) own.push(at);
        }

        const centre = own
            .reduce((sum, at) => sum.add(corners[at].clone()), new THREE.Vector3())
            .divideScalar(own.length);
        const span = own.reduce((most, at) => Math.max(most, corners[at].distanceTo(centre)), 0);
        const keep = span > 1e-6 ? Math.max(0, 1 - bevel / span) : 1;

        const moved = new Map<number, THREE.Vector3>();
        for (const at of own) {
            moved.set(at, centre.clone().lerp(corners[at], keep));
        }
        pulled.push(moved);

        for (let v = 0; v < perFace; v++) {
            const to = moved.get(cornerOf[base + v])!;
            positions[(base + v) * 3] = to.x;
            positions[(base + v) * 3 + 1] = to.y;
            positions[(base + v) * 3 + 2] = to.z;
        }

        // Corners walked round the face, so a strip knows which pairs are
        // edges and a cap knows which faces sit either side of it.
        const normal = new THREE.Vector3().crossVectors(
            corners[own[1]].clone().sub(corners[own[0]]),
            corners[own[2]].clone().sub(corners[own[0]])
        ).normalize();
        const across = corners[own[0]].clone().sub(centre).normalize();
        const along = new THREE.Vector3().crossVectors(normal, across);
        ring.push(own.slice().sort((a, b) => {
            const oa = corners[a].clone().sub(centre);
            const ob = corners[b].clone().sub(centre);
            return Math.atan2(oa.dot(along), oa.dot(across)) - Math.atan2(ob.dot(along), ob.dot(across));
        }));
    }

    /** Add one outward-facing patch, winding it away from the middle. */
    const patch = (points: THREE.Vector3[]) => {
        const first = positions.length / 3;
        const centre = points
            .reduce((sum, p) => sum.add(p.clone()), new THREE.Vector3())
            .divideScalar(points.length);
        const facing = new THREE.Vector3()
            .crossVectors(points[1].clone().sub(points[0]), points[2].clone().sub(points[0]));
        const ordered = facing.dot(centre) > 0 ? points : points.slice().reverse();

        for (const p of ordered) {
            positions.push(p.x, p.y, p.z);
            if (uvAttribute) uvs.push(rimUV[0], rimUV[1]);
        }
        for (let i = 1; i + 1 < ordered.length; i++) {
            indices.push(first, first + i, first + i + 1);
        }
    };

    // One strip per edge. An edge belongs to exactly two faces on a closed
    // solid, and anything else is not a die.
    const edges = new Map<string, Array<{ face: number; from: number; to: number }>>();
    for (let face = 0; face < faceCount; face++) {
        const round = ring[face];
        for (let i = 0; i < round.length; i++) {
            const from = round[i];
            const to = round[(i + 1) % round.length];
            const key = from < to ? `${from}:${to}` : `${to}:${from}`;
            if (!edges.has(key)) edges.set(key, []);
            edges.get(key)!.push({ face, from, to });
        }
    }
    for (const [, sides] of edges) {
        if (sides.length !== 2) continue;
        const [a, b] = sides;
        patch([
            pulled[a.face].get(a.from)!,
            pulled[a.face].get(a.to)!,
            pulled[b.face].get(a.to)!,
            pulled[b.face].get(a.from)!
        ]);
    }

    // One cap per corner, closing the hole the strips leave around it.
    for (let at = 0; at < corners.length; at++) {
        const meeting = pulled
            .map((moved, face) => ({ face, point: moved.get(at) }))
            .filter((entry) => entry.point) as Array<{ face: number; point: THREE.Vector3 }>;
        if (meeting.length < 3) continue;

        const out = corners[at].clone().normalize();
        const across = meeting[0].point.clone()
            .sub(corners[at]).sub(out.clone().multiplyScalar(meeting[0].point.clone().sub(corners[at]).dot(out)))
            .normalize();
        const along = new THREE.Vector3().crossVectors(out, across);
        meeting.sort((x, y) => {
            const ox = x.point.clone().sub(corners[at]);
            const oy = y.point.clone().sub(corners[at]);
            return Math.atan2(ox.dot(along), ox.dot(across)) - Math.atan2(oy.dot(along), oy.dot(across));
        });
        patch(meeting.map((entry) => entry.point));
    }

    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    if (uvAttribute) out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    out.setIndex(indices);
    // Safe to derive: no numbered face shares a vertex with a strip or a
    // cap, so averaging leaves every one of them flat.
    out.computeVertexNormals();
    softenRim(out, faceCount * perFace, smooth);
    out.userData.faceVertexCount = perFace;
    // Which corner of the die each numbered vertex used to sit on. Pulling
    // the faces apart is what makes room for the rim, and it also means they
    // no longer share vertices - so the corner a face omits, which is the
    // whole of how a d4 is read, cannot be recovered from the result. Keep
    // the answer from before the faces moved.
    out.userData.cornerOf = cornerOf.slice(0, faceCount * perFace);
    geometry.dispose();
    return out;
}

function createGeometryForDiceType(diceType: string, baseSize: number, pack: DicePack): THREE.BufferGeometry {
    const scale = dieScale(diceType, pack);
    const size = baseSize * scale;

    let geometry: THREE.BufferGeometry;
    switch (dieSolid(diceType, pack)) {
        case 'd4':
            geometry = new THREE.TetrahedronGeometry(size, 0);
            break;
        case 'd6':
            geometry = new THREE.BoxGeometry(size * 2, size * 2, size * 2);
            break;
        case 'd8':
            geometry = new THREE.OctahedronGeometry(size, 0);
            break;
        case 'd10':
            geometry = createD10PolyhedronGeometry(size);
            break;
        case 'd12':
            geometry = new THREE.DodecahedronGeometry(size, 0);
            break;
        case 'd20':
        default:
            geometry = new THREE.IcosahedronGeometry(size, 0);
            break;
    }

    const bevel = pack.bevel || BEVEL_FALLBACK;
    if (bevel.enabled === false) return geometry;
    return chamferGeometry(
        geometry,
        dieFaceCount(diceType, pack),
        size * (bevel.depth ?? BEVEL_FALLBACK.depth),
        packDie(diceType, pack).rimUV || PACK_FALLBACK.rimUV,
        Math.min(1, Math.max(0, bevel.smooth ?? BEVEL_FALLBACK.smooth))
    );
}

/**
 * Lay a die's faces onto the cells of its atlas.
 *
 * Each face keeps the geometry's own unit-square UVs and has them mapped
 * into the cell printed with that face's number, rotated as the cell
 * demands. Working from the geometry's own UVs rather than writing corners
 * by hand means the face comes out the way three.js intended it to, mirrored
 * the same way and wound the same way.
 */
function applyQuadAtlasUV(geometry: THREE.BufferGeometry, diceType: string, pack: DicePack): boolean {
    const atlas = packDie(diceType, pack).grid;
    const numbers = numbersFor(diceType, pack);
    if (!atlas || !numbers) return false;

    const uv = geometry.attributes.uv;
    if (!uv) return false;

    // A chamfered die parks its rim vertices after the numbered faces, so
    // the buffer no longer divides evenly into them; it says how long a face
    // is. Everything else is still a plain slice.
    const verticesPerFace = (geometry.userData.faceVertexCount as number)
        || uv.count / numbers.length;

    for (let face = 0; face < numbers.length; face++) {
        const cell = atlas.cells.find((c) => c.number === numbers[face]);
        if (!cell) continue;

        for (let v = 0; v < verticesPerFace; v++) {
            const at = face * verticesPerFace + v;
            let u0 = uv.getX(at);
            let v0 = uv.getY(at);

            for (let turn = 0; turn < cell.rotation; turn++) {
                const spun = u0;
                u0 = v0;
                v0 = 1 - spun;
            }

            // Rows count downwards in the image, upwards in UV space.
            uv.setXY(
                at,
                (cell.col + u0) / atlas.cols,
                (atlas.rows - 1 - cell.row + v0) / atlas.rows
            );
        }
    }

    uv.needsUpdate = true;
    return true;
}

/**
 * Lay a die's faces onto the cells of a net that is not a grid.
 *
 * Unlike the quad atlas there are no per-face UVs worth keeping: three.js
 * gives a polyhedron a spherical projection, which has nothing to do with
 * where the art is. So each corner of a face is assigned a corner of its
 * cell outright, `turn` choosing where the run starts and `mirror` which way
 * it goes round.
 */
function applyPolyAtlasUV(geometry: THREE.BufferGeometry, diceType: string, pack: DicePack): boolean {
    const die = packDie(diceType, pack);
    const atlas = die.faces && die.sheetSize ? { size: die.sheetSize, faces: die.faces } : null;
    const numbers = numbersFor(diceType, pack);
    if (!atlas || !numbers) return false;

    const uv = geometry.attributes.uv;
    if (!uv) return false;

    // A bevelled die parks its rim after the numbered faces, so the buffer
    // no longer divides evenly into them; it says how long a face is.
    const verticesPerFace = (geometry.userData.faceVertexCount as number)
        || uv.count / numbers.length;
    if (!Number.isInteger(verticesPerFace)) return false;
    const position = geometry.attributes.position;

    for (let face = 0; face < numbers.length; face++) {
        const cell = atlas.faces.find((f) => f.number === numbers[face]);
        if (!cell) continue;

        // Read the cell backwards.
        //
        // A net is drawn to be looked at from outside the folded die - that
        // is what makes it a net - so walking a cell's corners as the image
        // draws them goes round the face the opposite way from walking the
        // face's own corners, which are wound outward. Taking them in the
        // order given turns every face into its own mirror image: the digits
        // still land in the right places, still upright, still on the right
        // faces, and every one of them back to front.
        //
        // It survived a long time because nothing compares a die with
        // anything outside itself. Faces agreeing with each other says only
        // that they are all wrong the same way, and a mirrored polygon has
        // exactly the edge lengths of an unmirrored one. What catches it is
        // posing a face at the camera and asking whether the walk turns the
        // same way on screen as it does in the image.
        //
        // The d6 does not come through here and is not affected: its net
        // lies on a grid, so it keeps three.js's own face UVs and only has
        // them moved onto the right cell.
        const wound = cell.corners.slice().reverse();
        const sides = wound.length;
        const base = face * verticesPerFace;

        if (cell.vertices) {
            // Corner-read art names its corners rather than walking them, so
            // reversing the corners alone is what flips it - the names stay
            // where they are and now describe the mirrored positions.
            const owners = cornerNumbersForFace(geometry, face, verticesPerFace, numbers.length);
            for (let v = 0; v < verticesPerFace; v++) {
                const at = cell.vertices.indexOf(owners[v]);
                if (at < 0) continue;
                const corner = wound[at];
                uv.setXY(base + v, corner[0] / atlas.size, 1 - corner[1] / atlas.size);
            }
            continue;
        }
        // A triangle arrives as three vertices in order and needs no work.
        // A pentagon does not: three.js hands a dodecahedron's face over as
        // nine vertices - three triangles cut off a strip, not a fan - so
        // they repeat, and the order they repeat in says nothing about the
        // way round the pentagon goes. Walking them by angle does.
        const ring = verticesPerFace === sides ? null : ringOrderForFace(position, base, verticesPerFace);
        // The cell has to be anchored by the same rule the face was, or the
        // two agree on where the walk starts only by luck.
        const anchor = ring ? anchorCorner(wound) : -1;
        const corners = anchor < 0
            ? wound
            : wound.slice(anchor).concat(wound.slice(0, anchor));

        for (let v = 0; v < verticesPerFace; v++) {
            const seat = ring ? ring[v] : v;
            const step = cell.mirror ? -seat : seat;
            const corner = corners[(((step + cell.turn) % sides) + sides) % sides];
            // Rows count downwards in the image, upwards in UV space.
            uv.setXY(base + v, corner[0] / atlas.size, 1 - corner[1] / atlas.size);
        }
    }

    uv.needsUpdate = true;
    return true;
}

/**
 * Seat each of a face's vertices at a corner of its polygon.
 *
 * Repeated vertices are collapsed by position, the survivors are sorted by
 * their angle about the face centre, and every vertex is given the seat its
 * position earned. Sorting about the face's own normal rather than about
 * anything in world space keeps the direction of travel the same for all
 * faces, which is what stops half a die coming out mirrored.
 */
/**
 * The corner a lopsided shape can be lined up by, or -1 if it has none.
 *
 * Walking a face's corners in order fixes the direction of travel but not
 * where the walk starts, and where it starts is decided by whichever vertex
 * three.js happened to write first. For a triangle or a pentagon that costs
 * nothing - every corner is like every other, so a different start is only a
 * rotation, and these faces land at whatever angle they land at anyway.
 *
 * A kite has no such symmetry. Start one corner out and its long diagonal is
 * laid along the sheet's short one: the digit still appears, stretched, so
 * it survives being looked at. Eight of the d10's ten faces were seated that
 * way and only the diagonals gave it away. So a shape with one corner
 * plainly further from the middle than the rest is anchored there, at both
 * ends of the mapping, and a shape without one is left alone.
 */
function anchorCorner(points: Array<[number, number] | THREE.Vector3>): number {
    const at = (p: [number, number] | THREE.Vector3) =>
        Array.isArray(p) ? new THREE.Vector3(p[0], p[1], 0) : p;
    const centre = points
        .reduce<THREE.Vector3>((sum, p) => sum.add(at(p).clone()), new THREE.Vector3())
        .divideScalar(points.length);
    const spans = points.map((p) => at(p).distanceTo(centre));
    const sorted = spans.slice().sort((a, b) => b - a);
    if (sorted[0] < sorted[1] * 1.02) return -1;
    return spans.indexOf(sorted[0]);
}

function ringOrderForFace(
    position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    base: number,
    count: number
): number[] {
    const points: THREE.Vector3[] = [];
    for (let v = 0; v < count; v++) {
        points.push(new THREE.Vector3().fromBufferAttribute(position, base + v));
    }

    const corners: THREE.Vector3[] = [];
    const seatOf = points.map((p) => {
        let at = corners.findIndex((c) => c.distanceToSquared(p) < 1e-8);
        if (at < 0) at = corners.push(p) - 1;
        return at;
    });

    const centre = corners
        .reduce((sum, c) => sum.add(c), new THREE.Vector3())
        .divideScalar(corners.length);
    const normal = new THREE.Vector3()
        .crossVectors(
            points[1].clone().sub(points[0]),
            points[2].clone().sub(points[0])
        )
        .normalize();
    // Point it outward before using it. Taken from the first three vertices
    // as they happen to be written, this normal points whichever way that
    // triangle is wound, and the two halves of a d10 are not wound the same
    // way. An inward normal reverses the walk, which mirrors the face - and
    // a mirrored kite has exactly the edge lengths of an unmirrored one, so
    // it survives every check that measures the shape. Five of the ten faces
    // came out back to front.
    if (normal.dot(centre) < 0) normal.negate();
    const across = corners[0].clone().sub(centre).normalize();
    const along = new THREE.Vector3().crossVectors(normal, across);

    const order = corners
        .map((c, at) => {
            const offset = c.clone().sub(centre);
            return { at, angle: Math.atan2(offset.dot(along), offset.dot(across)) };
        })
        .sort((a, b) => a.angle - b.angle)
        .map((entry) => entry.at);

    const anchor = anchorCorner(corners);
    const from = anchor < 0 ? 0 : order.indexOf(anchor);
    const anchored = order.slice(from).concat(order.slice(0, from));

    const seatFor = new Array<number>(corners.length);
    anchored.forEach((corner, seat) => { seatFor[corner] = seat; });
    return seatOf.map((corner) => seatFor[corner]);
}

/**
 * Number every corner of a face, for corner-read art.
 *
 * A tetrahedron's face leaves exactly one of the die's four corners out, and
 * that is the corner you read when the die rests on that face - so the
 * corner a face omits carries that face's own number. Numbering the corners
 * that way costs nothing to derive and leaves no choice to make: each
 * corner's number falls out of which face does not touch it.
 */
function cornerNumbersForFace(
    geometry: THREE.BufferGeometry,
    face: number,
    verticesPerFace: number,
    faceCount: number
): number[] {
    const position = geometry.attributes.position;
    const numbered = faceCount * verticesPerFace;

    // A bevelled die has had its faces pulled apart to make room for the
    // rim, so they no longer share vertices and which corner is which cannot
    // be read back off the positions - every face would look like it had
    // three corners of its own, nothing would be omitted, and the d4 lost
    // its digits entirely. The chamfer keeps the answer from before it moved
    // them.
    const kept = geometry.userData.cornerOf as number[] | undefined;
    const cornerOf: number[] = kept ? kept.slice(0, numbered) : [];
    if (!kept) {
        const corners: THREE.Vector3[] = [];
        for (let v = 0; v < numbered; v++) {
            const point = new THREE.Vector3().fromBufferAttribute(position, v);
            let at = corners.findIndex((c) => c.distanceToSquared(point) < 1e-8);
            if (at < 0) at = corners.push(point) - 1;
            cornerOf.push(at);
        }
    }
    const cornerCount = Math.max(...cornerOf) + 1;

    const numberOfCorner = new Array<number>(cornerCount).fill(0);
    for (let f = 0; f < faceCount; f++) {
        const touched = new Set(cornerOf.slice(f * verticesPerFace, (f + 1) * verticesPerFace));
        for (let c = 0; c < cornerCount; c++) {
            if (!touched.has(c)) numberOfCorner[c] = f + 1;
        }
    }

    const out: number[] = [];
    for (let v = 0; v < verticesPerFace; v++) {
        out.push(numberOfCorner[cornerOf[face * verticesPerFace + v]]);
    }
    return out;
}

function applyUVMappingForDiceType(geometry: THREE.BufferGeometry, diceType: string, pack: DicePack): void {
    // A type with an atlas is laid out from it; the rest keep the old
    // hand-built grids until their sheets are mapped too.
    if (applyQuadAtlasUV(geometry, diceType, pack)) return;
    if (applyPolyAtlasUV(geometry, diceType, pack)) return;

    switch (dieSolid(diceType, pack)) {
        case 'd4':
            applyTriangleUVMapping(geometry, 4);
            break;
        case 'd6':
            applySquareUVMapping(geometry);
            break;
        case 'd8':
            applyTriangleUVMapping(geometry, 8);
            break;
        case 'd10':
            applyD10UVMapping(geometry);
            break;
        case 'd12':
            applyD12PentagonUVMapping(geometry);
            break;
        case 'd20':
        default:
            applyTriangleUVMapping(geometry, 20);
            break;
    }
}

/** How the set is finished. */
export function packFinish(pack: DicePack): { shininess: number; specular: string; transparent: boolean; opacity: number } {
    const finish = pack.material || {};
    return {
        shininess: finish.shininess ?? 100,
        specular: finish.specular ?? '#222222',
        transparent: finish.transparent ?? false,
        opacity: finish.opacity ?? 1
    };
}

/**
 * Face normals taken from the geometry, in the geometry's own face order.
 *
 * The hand-written tables below list the right normals in the wrong order:
 * three.js builds an octahedron's faces as +++, +-+, +--, ++-, -+-, ---,
 * --+, -++, and the table walks them round the equator instead. That is
 * invisible while the number is only a lookup - any permutation still gives
 * a number - but the atlas addresses faces by their geometry index, so the
 * two disagreed and every d8 showed a digit belonging to a different face.
 *
 * Anything with a polygon atlas therefore reads its normals from the same
 * buffer the UVs came from, which is the only way the two orders cannot
 * drift apart again.
 */
function deriveFaceNormalsFromGeometry(geometry: THREE.BufferGeometry, atlasFaces: number): THREE.Vector3[] {
    const pos = geometry.attributes.position;
    // A dodecahedron's face is nine vertices, not three, so the stride has
    // to come from how many faces the atlas says there are.
    const perFace = (geometry.userData.faceVertexCount as number) || pos.count / atlasFaces;
    const normals: THREE.Vector3[] = [];
    // Numbered faces only. A bevelled die's rim sits behind them in the same
    // buffer, and walking the whole thing hands back a normal per rim facet
    // too: a d8 came back with thirty-two faces, and the result check duly
    // found a rim strip pointing more upward than any face and reported the
    // number belonging to whatever came first.
    const numbered = atlasFaces * perFace;

    for (let base = 0; base + 2 < numbered; base += perFace) {
        const a = new THREE.Vector3().fromBufferAttribute(pos, base);
        const b = new THREE.Vector3().fromBufferAttribute(pos, base + 1);
        const c = new THREE.Vector3().fromBufferAttribute(pos, base + 2);
        normals.push(new THREE.Vector3()
            .crossVectors(b.clone().sub(a), c.clone().sub(a))
            .normalize());
    }

    return normals;
}

function computeFaceNormalsForDiceType(diceType: string, geometry: THREE.BufferGeometry): THREE.Vector3[] {
    // Set by dieGeometry when the pack lays this die out as a polygon atlas.
    const atlasFaces = geometry.userData.atlasFaces as number | null | undefined;
    if (atlasFaces != null) return deriveFaceNormalsFromGeometry(geometry, atlasFaces);

    switch (diceType) {
        case 'd6':
            // Box/Cube face normals
            return [
                new THREE.Vector3(1, 0, 0),   // Right
                new THREE.Vector3(-1, 0, 0),  // Left
                new THREE.Vector3(0, 1, 0),   // Top
                new THREE.Vector3(0, -1, 0),  // Bottom
                new THREE.Vector3(0, 0, 1),   // Front
                new THREE.Vector3(0, 0, -1)   // Back
            ];

        case 'd4':
        case 'd8':
        case 'd10':
        case 'd12':
            // Read from the geometry itself, in the order its faces (and the
            // fallback art laid onto them) come in the buffer. The fixed
            // tables these used to return walked the faces in their own
            // order, which is not three.js's: a d4, d8 or d12 with no atlas
            // reported the number of a different face, and a d10's kites
            // tilted upward to match no face at all.
            return deriveFaceNormalsFromGeometry(geometry, dieFaceCountOfSolid(diceType));

        case 'd20': {
            // Icosahedron face normals (20 triangular faces)
            const t = (1 + Math.sqrt(5)) / 2;
            const vertices = [
                [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
                [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
                [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]
            ];

            const faces = [
                [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
                [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
                [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
                [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]
            ];

            return faces.map(face => {
                const v1 = new THREE.Vector3(...vertices[face[0]]);
                const v2 = new THREE.Vector3(...vertices[face[1]]);
                const v3 = new THREE.Vector3(...vertices[face[2]]);

                const edge1 = v2.clone().sub(v1);
                const edge2 = v3.clone().sub(v1);
                return edge1.cross(edge2).normalize();
            });
        }

        default:
            return [new THREE.Vector3(0, 1, 0)];
    }
}

/**
 * The number on a face, from the same table that placed the art.
 *
 * Looked up rather than computed, so the two cannot drift: whatever face
 * comes up, the number reported is the one printed on it. A pack that says
 * nothing falls back to counting from one - except the d10, which counts
 * from zero, and really does have a face reading zero, and the percentile die,
 * which counts tens from 00.
 */
function mapFaceIndexToNumber(faceIndex: number, diceType: string, numbers: number[] | null): number {
    if (numbers) {
        const number = numbers[faceIndex];
        if (number !== undefined) return number;
    }
    if (diceType === 'd100') return faceIndex * 10;
    return diceType === 'd10' ? faceIndex : faceIndex + 1;
}

function createConvexPolyhedronFromGeometry(geometry: THREE.BufferGeometry): CANNON.ConvexPolyhedron {
    const workingGeometry = geometry.index ? geometry.toNonIndexed() : geometry;
    const positionAttribute = workingGeometry.attributes.position;

    const ownsWorkingCopy = workingGeometry !== geometry;

    if (!positionAttribute) {
        if (ownsWorkingCopy) workingGeometry.dispose();
        throw new Error('Cannot create convex polyhedron: missing position attribute');
    }

    const vertices: CANNON.Vec3[] = [];
    const faces: number[][] = [];
    const vertexMap = new Map<string, number>();

    const addVertex = (vertex: THREE.Vector3): number => {
        const key = `${vertex.x.toFixed(5)}|${vertex.y.toFixed(5)}|${vertex.z.toFixed(5)}`;
        let index = vertexMap.get(key);
        if (index === undefined) {
            index = vertices.length;
            vertices.push(new CANNON.Vec3(vertex.x, vertex.y, vertex.z));
            vertexMap.set(key, index);
        }
        return index;
    };

    for (let i = 0; i < positionAttribute.count; i += 3) {
        const face: number[] = [];
        for (let j = 0; j < 3; j++) {
            const vertex = new THREE.Vector3().fromBufferAttribute(positionAttribute, i + j);
            face.push(addVertex(vertex));
        }
        faces.push(face);
    }

    if (ownsWorkingCopy) workingGeometry.dispose();

    const shape = new CANNON.ConvexPolyhedron({ vertices, faces });
    shape.computeNormals();
    shape.updateBoundingSphereRadius();
    return shape;
}

/**
 * A die as the tray builds it: its solid at `size` times the pack's scale for
 * it, bevelled as the pack says, with the pack's art laid onto its faces.
 *
 * What dieFaceNormals needs from the pack travels on `userData`, so the
 * geometry alone is enough to read the die later.
 */
export function dieGeometry(type: DieType, size: number, pack: DicePack): THREE.BufferGeometry {
    const geometry = createGeometryForDiceType(type, size, pack);
    applyUVMappingForDiceType(geometry, type, pack);
    const faces = packDie(type, pack).faces;
    geometry.userData.atlasFaces = faces ? faces.length : null;
    geometry.userData.faceNumbers = numbersFor(type, pack);
    geometry.userData.solid = dieSolid(type, pack);
    return geometry;
}

/** The number on each of a die's first `count` faces, in geometry face order. */
export function dieFaceNumbers(type: DieType, pack: DicePack, count: number): number[] {
    const numbers = numbersFor(type, pack);
    return Array.from({ length: count }, (_, i) => mapFaceIndexToNumber(i, type, numbers));
}

/** Which way each numbered face points, and the number printed on it, index-aligned. */
export function dieFaceNormals(type: DieType, geometry: THREE.BufferGeometry): { normals: Vec3[]; numbers: number[] } {
    const packNumbers = (geometry.userData.faceNumbers as number[] | null | undefined) ?? null;
    const solid = (geometry.userData.solid as string | undefined) ?? type;
    const normals = computeFaceNormalsForDiceType(solid, geometry).map((n) => ({ x: n.x, y: n.y, z: n.z }));
    const numbers = normals.map((_, i) => mapFaceIndexToNumber(i, type, packNumbers));
    return { normals, numbers };
}

/**
 * The die's collision hull, from the same buffer it is drawn from.
 *
 * Every die type gets a hull, including the d6; the tray itself still
 * collides its d6 as a plain box.
 */
export function diePhysicsShape(_type: DieType, geometry: THREE.BufferGeometry): CANNON.ConvexPolyhedron {
    return createConvexPolyhedronFromGeometry(geometry);
}

/**
 * The die's finish. Loading the art is the caller's: a face sheet arrives
 * already composited over the die's colour, so a textured die is left white
 * rather than tinted a second time.
 */
export function dieMaterial(
    type: DieType,
    pack: DicePack,
    textures: { map?: THREE.Texture; normalMap?: THREE.Texture },
    color: string | null
): THREE.MeshPhongMaterial {
    // A die added in a colour of its own wears it in place of the pack's.
    const materialProps: THREE.MeshPhongMaterialParameters = {
        color: color ?? dieColor(type, pack),
        ...packFinish(pack)
    };

    if (textures.map) {
        materialProps.map = textures.map;
        // The die colour is already painted into the texture. Leaving it
        // here too would multiply it in a second time and put back the
        // dark, low-contrast face the composite exists to fix.
        materialProps.color = 0xffffff;
    }

    if (textures.normalMap) {
        materialProps.normalMap = textures.normalMap;
    }

    return new THREE.MeshPhongMaterial(materialProps);
}
