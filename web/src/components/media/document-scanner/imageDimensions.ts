const MAX_HEADER_BYTES = 256 * 1024;
const JPEG_START_OF_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Pixel dimensions read without decoding the complete image. */
export interface ImageDimensions {
  /** Source height in pixels. */
  height: number;
  /** Source width in pixels. */
  width: number;
}

function validDimensions(width: number, height: number): ImageDimensions | undefined {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    ? { height, width }
    : undefined;
}

function pngDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value) || ascii(bytes, 12, 4) !== 'IHDR') return undefined;
  return validDimensions(view.getUint32(16), view.getUint32(20));
}

function jpegDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0x01) continue;
    if (marker === 0xd9 || marker === 0xda || offset + 1 >= bytes.length) return undefined;
    const segmentLength = view.getUint16(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return undefined;
    if (JPEG_START_OF_FRAME_MARKERS.has(marker) && segmentLength >= 7) {
      return validDimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
    }
    offset += segmentLength;
  }
  return undefined;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function uint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function webpDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | undefined {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    if (type === 'VP8X' && length >= 10 && dataOffset + 10 <= bytes.length) {
      return validDimensions(uint24LittleEndian(bytes, dataOffset + 4) + 1, uint24LittleEndian(bytes, dataOffset + 7) + 1);
    }
    if (type === 'VP8L' && length >= 5 && dataOffset + 5 <= bytes.length && bytes[dataOffset] === 0x2f) {
      const width = 1 + (((bytes[dataOffset + 2] & 0x3f) << 8) | bytes[dataOffset + 1]);
      const height = 1 + ((bytes[dataOffset + 4] & 0x0f) << 10) + (bytes[dataOffset + 3] << 2) + ((bytes[dataOffset + 2] & 0xc0) >> 6);
      return validDimensions(width, height);
    }
    if (type === 'VP8 ' && length >= 10 && dataOffset + 10 <= bytes.length
      && bytes[dataOffset + 3] === 0x9d && bytes[dataOffset + 4] === 0x01 && bytes[dataOffset + 5] === 0x2a) {
      return validDimensions(view.getUint16(dataOffset + 6, true) & 0x3fff, view.getUint16(dataOffset + 8, true) & 0x3fff);
    }
    if (length > bytes.length - dataOffset) return undefined;
    offset = dataOffset + length + (length % 2);
  }
  return undefined;
}

/**
 * Reads JPEG, PNG, or WebP dimensions from a bounded prefix of a local file.
 *
 * @param file - Image selected or captured for the scanner.
 * @returns Valid positive source-image dimensions.
 * @throws {Error} When the image header is malformed, truncated, or unsupported.
 */
export async function readImageDimensions(file: File): Promise<ImageDimensions> {
  const header = await file.slice(0, Math.min(file.size, MAX_HEADER_BYTES)).arrayBuffer();
  const bytes = new Uint8Array(header);
  const view = new DataView(header);
  const dimensions = file.type === 'image/png'
    ? pngDimensions(bytes, view)
    : file.type === 'image/jpeg'
      ? jpegDimensions(bytes, view)
      : file.type === 'image/webp'
        ? webpDimensions(bytes, view)
        : undefined;
  if (!dimensions) throw new Error('The selected image has an invalid or unsupported header.');
  return dimensions;
}
