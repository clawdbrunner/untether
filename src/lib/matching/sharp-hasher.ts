import type { ImageHasher } from './image-hash.js';
import sharp from 'sharp';

export class SharpHasher implements ImageHasher {
    async resizeGrayscale(imageData: ArrayBuffer, width: number, height: number): Promise<Uint8Array> {
        const buffer = Buffer.from(imageData);
        const pixels = await sharp(buffer)
            .resize(width, height, { fit: 'fill' })
            .grayscale()
            .raw()
            .toBuffer();
        return new Uint8Array(pixels);
    }
}
