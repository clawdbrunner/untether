/**
 * Image hash interface -- implementations for Node (sharp) and Workers (pure JS).
 */
export interface ImageHasher {
    /** Resize image to width x height grayscale, return raw pixel data. */
    resizeGrayscale(imageData: ArrayBuffer, width: number, height: number): Promise<Uint8Array>;
}

let _hasher: ImageHasher | null = null;

export function setImageHasher(hasher: ImageHasher): void {
    _hasher = hasher;
}

export function getImageHasher(): ImageHasher {
    if (_hasher) return _hasher;

    // Auto-detect: use sharp if available, else pure JS fallback
    try {
        // Dynamic import won't work in Workers -- the bundler will handle this
        const { SharpHasher } = require('./sharp-hasher.js');
        _hasher = new SharpHasher();
    } catch {
        const { PureHasher } = require('./pure-hasher.js');
        _hasher = new PureHasher();
    }
    return _hasher!;
}
