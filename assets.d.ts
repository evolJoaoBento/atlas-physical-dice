// esbuild's `binary` loader hands a PNG over as its bytes.
declare module '*.png' {
    const bytes: Uint8Array;
    export default bytes;
}
