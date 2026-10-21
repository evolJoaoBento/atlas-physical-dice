// Which face of a die points up. Plain objects only, so the kit works with any three.
export type DieType = 'd4' | 'd6' | 'd8' | 'd10' | 'd100' | 'd12' | 'd20';

export const DIE_TYPES: readonly DieType[] = ['d4', 'd6', 'd8', 'd10', 'd100', 'd12', 'd20'];

// The percentile die itself reads tens, but a d100 roll spans 100 values.
export const DIE_FACES: Record<DieType, number> = { d4: 4, d6: 6, d8: 8, d10: 10, d100: 100, d12: 12, d20: 20 };

export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }

export interface FaceReading {
    caught: boolean;
    face: number | null;
    confidence: number;
}

// Rotates v by the unit quaternion q.
function rotate(v: Vec3, q: Quat): Vec3 {
    const ix = q.w * v.x + q.y * v.z - q.z * v.y;
    const iy = q.w * v.y + q.z * v.x - q.x * v.z;
    const iz = q.w * v.z + q.x * v.y - q.y * v.x;
    const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
    return {
        x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
        y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
        z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
    };
}

// Up is +y; the d4 reads the face pointing down. Caught when no face is within tolerance.
export function readFace(type: DieType, normals: readonly Vec3[], numbers: readonly number[], q: Quat, tolerance: number): FaceReading {
    const sign = type === 'd4' ? -1 : 1;
    let best = -Infinity;
    let bestIndex = 0;
    for (let i = 0; i < normals.length; i++) {
        const dot = rotate(normals[i], q).y * sign;
        if (dot > best) {
            best = dot;
            bestIndex = i;
        }
    }
    if (best < 1 - tolerance) return { caught: true, face: null, confidence: best };
    return { caught: false, face: numbers[bestIndex] ?? null, confidence: best };
}
