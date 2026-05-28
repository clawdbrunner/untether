import sharp from 'sharp';

/**
 * Compute an average hash (aHash) of an image.
 * Resize to 8x8 grayscale, compare each pixel to the mean → 64-bit hash as hex.
 */
export async function computePHash(imageUrlOrBuffer: string | Buffer): Promise<string> {
  let buffer: Buffer;

  if (typeof imageUrlOrBuffer === 'string') {
    const resp = await fetch(imageUrlOrBuffer);
    if (!resp.ok) throw new Error(`Failed to fetch image: ${resp.status}`);
    buffer = Buffer.from(await resp.arrayBuffer());
  } else {
    buffer = imageUrlOrBuffer;
  }

  // Resize to 8x8 grayscale
  const pixels = await sharp(buffer)
    .resize(8, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer();

  // Compute mean pixel value
  let sum = 0;
  for (let i = 0; i < 64; i++) sum += pixels[i];
  const mean = sum / 64;

  // Build 64-bit hash: each bit = pixel > mean
  let hash = '';
  for (let i = 0; i < 64; i += 4) {
    let nibble = 0;
    for (let j = 0; j < 4 && i + j < 64; j++) {
      if (pixels[i + j] > mean) nibble |= (1 << (3 - j));
    }
    hash += nibble.toString(16);
  }

  return hash;
}

export function hammingDistance(hash1: string, hash2: string): number {
  if (hash1.length !== hash2.length) {
    throw new Error('Hashes must be the same length');
  }

  let distance = 0;
  for (let i = 0; i < hash1.length; i++) {
    const xor = parseInt(hash1[i], 16) ^ parseInt(hash2[i], 16);
    // Count bits in xor (4-bit nibble)
    distance += popcount4(xor);
  }
  return distance;
}

export function hashSimilarity(hash1: string, hash2: string): number {
  const dist = hammingDistance(hash1, hash2);
  return 1 - dist / 64;
}

/**
 * Detect default/letter avatars (low entropy).
 * Resize to 4x4, count unique pixel values.
 */
export async function isLowEntropyAvatar(imageUrl: string): Promise<boolean> {
  try {
    const resp = await fetch(imageUrl);
    if (!resp.ok) return true; // Assume low entropy on failure
    const buffer = Buffer.from(await resp.arrayBuffer());

    const pixels = await sharp(buffer)
      .resize(4, 4, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer();

    const uniqueValues = new Set<number>();
    for (let i = 0; i < pixels.length; i++) {
      uniqueValues.add(pixels[i]);
    }

    return uniqueValues.size < 4;
  } catch {
    return true;
  }
}

function popcount4(n: number): number {
  n = n & 0xf;
  n = n - ((n >> 1) & 0x5);
  n = (n & 0x3) + ((n >> 2) & 0x3);
  return n;
}
