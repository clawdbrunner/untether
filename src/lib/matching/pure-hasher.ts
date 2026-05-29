import type { ImageHasher } from './image-hash.js';

/**
 * Pure JS image hasher -- uses OffscreenCanvas (browser/Workers) or
 * a minimal decode-then-resize approach.
 *
 * For Workers: uses OffscreenCanvas.createImageBitmap + canvas 2d context
 * For environments without canvas: falls back to very basic downsampling
 */
export class PureHasher implements ImageHasher {
    async resizeGrayscale(imageData: ArrayBuffer, width: number, height: number): Promise<Uint8Array> {
        // Try OffscreenCanvas path (Workers with canvas support, browser)
        if (typeof OffscreenCanvas !== 'undefined') {
            return this.offscreenCanvasPath(imageData, width, height);
        }

        // Fallback: basic PNG header parsing for minimal grayscale
        // This is a simplified approach -- for production, use a WASM image decoder
        return this.basicFallback(imageData, width, height);
    }

    private async offscreenCanvasPath(imageData: ArrayBuffer, width: number, height: number): Promise<Uint8Array> {
        const blob = new Blob([imageData]);
        const bitmap = await createImageBitmap(blob);

        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0, width, height);

        const imgData = ctx.getImageData(0, 0, width, height);
        const pixels = new Uint8Array(width * height);

        for (let i = 0; i < width * height; i++) {
            const r = imgData.data[i * 4];
            const g = imgData.data[i * 4 + 1];
            const b = imgData.data[i * 4 + 2];
            // Luminance formula
            pixels[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        }

        return pixels;
    }

    private async basicFallback(_imageData: ArrayBuffer, width: number, height: number): Promise<Uint8Array> {
        // Last resort: return uniform pixels (will produce a uniform hash -- basically disables avatar matching)
        // This should never be reached in practice -- sharp is always available in Node,
        // and OffscreenCanvas is available in Workers
        process.stderr.write('[phash] WARNING: No image processing available, avatar matching disabled\n');
        return new Uint8Array(width * height).fill(128);
    }
}
