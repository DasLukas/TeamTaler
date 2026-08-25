import type { DocumentFilter } from './types';

/** Minimal mutable pixel surface accepted by the scanner enhancement pipeline. */
export interface DocumentPixelSurface {
  /** Interleaved RGBA bytes. */
  data: Uint8ClampedArray;
  /** Surface height in pixels. */
  height: number;
  /** Surface width in pixels. */
  width: number;
}

const LUMINANCE_RED = 0.2126;
const LUMINANCE_GREEN = 0.7152;
const LUMINANCE_BLUE = 0.0722;

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function luminance(red: number, green: number, blue: number): number {
  return red * LUMINANCE_RED + green * LUMINANCE_GREEN + blue * LUMINANCE_BLUE;
}

function percentile(histogram: Uint32Array, total: number, fraction: number): number {
  const target = Math.max(0, Math.min(total - 1, Math.floor(total * fraction)));
  let accumulated = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    accumulated += histogram[value];
    if (accumulated > target) return value;
  }
  return 255;
}

function stretchedLuminance(value: number, low: number, high: number, strength: number): number {
  if (high - low < 24) return value;
  const normalized = Math.max(0, Math.min(1, (value - low) / (high - low)));
  const stretched = Math.pow(normalized, 0.94) * 255;
  return value * (1 - strength) + stretched * strength;
}

function sharpen(surface: DocumentPixelSurface, amount: number): void {
  if (surface.width < 3 || surface.height < 3 || amount <= 0) return;
  const source = new Uint8ClampedArray(surface.data);
  const { data, width, height } = surface;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const offset = (y * width + x) * 4;
      if (source[offset + 3] === 0) continue;
      const left = offset - 4;
      const right = offset + 4;
      const top = offset - width * 4;
      const bottom = offset + width * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const neighbors = source[left + channel] + source[right + channel] + source[top + channel] + source[bottom + channel];
        data[offset + channel] = clampByte(source[offset + channel] * (1 + amount * 4) - neighbors * amount);
      }
    }
  }
}

/**
 * Applies a deterministic scanner enhancement directly to RGBA pixels.
 *
 * The implementation avoids `CanvasRenderingContext2D.filter`, whose support
 * and output can differ between embedded and mobile browsers. Color mode uses
 * bounded gray-world balancing, percentile contrast normalization, restrained
 * saturation, and light sharpening. Grayscale mode uses luminance-based tonal
 * normalization and guarantees equal RGB channels. Original mode is a no-op.
 *
 * @param surface - Mutable RGBA pixel surface whose byte length must equal width × height × four.
 * @param filter - Scanner enhancement mode to apply.
 * @returns Nothing; pixels are updated in place.
 * @throws {Error} When the supplied dimensions and RGBA byte length disagree.
 *
 * @example
 * applyDocumentFilter({ data: imageData.data, width: imageData.width, height: imageData.height }, 'grayscale');
 */
export function applyDocumentFilter(surface: DocumentPixelSurface, filter: DocumentFilter): void {
  if (surface.width < 0 || surface.height < 0 || surface.data.length !== surface.width * surface.height * 4) {
    throw new Error('Document filter pixels do not match the supplied dimensions.');
  }
  if (filter === 'original' || surface.data.length === 0) return;

  const { data } = surface;
  let opaquePixels = 0;
  let redTotal = 0;
  let greenTotal = 0;
  let blueTotal = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] === 0) continue;
    opaquePixels += 1;
    redTotal += data[offset];
    greenTotal += data[offset + 1];
    blueTotal += data[offset + 2];
  }
  if (opaquePixels === 0) return;

  const histogram = new Uint32Array(256);
  if (filter === 'grayscale') {
    for (let offset = 0; offset < data.length; offset += 4) {
      if (data[offset + 3] === 0) continue;
      histogram[clampByte(luminance(data[offset], data[offset + 1], data[offset + 2]))] += 1;
    }
    const low = percentile(histogram, opaquePixels, 0.015);
    const high = percentile(histogram, opaquePixels, 0.985);
    for (let offset = 0; offset < data.length; offset += 4) {
      if (data[offset + 3] === 0) continue;
      const gray = clampByte(stretchedLuminance(luminance(data[offset], data[offset + 1], data[offset + 2]), low, high, 0.88));
      data[offset] = gray;
      data[offset + 1] = gray;
      data[offset + 2] = gray;
    }
    sharpen(surface, 0.1);
    return;
  }

  const redMean = redTotal / opaquePixels;
  const greenMean = greenTotal / opaquePixels;
  const blueMean = blueTotal / opaquePixels;
  const neutralMean = (redMean + greenMean + blueMean) / 3;
  const gains = [redMean, greenMean, blueMean].map((mean) => Math.max(0.72, Math.min(1.28, neutralMean / Math.max(1, mean))));
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] === 0) continue;
    const red = clampByte(data[offset] * gains[0]);
    const green = clampByte(data[offset + 1] * gains[1]);
    const blue = clampByte(data[offset + 2] * gains[2]);
    histogram[clampByte(luminance(red, green, blue))] += 1;
  }
  const low = percentile(histogram, opaquePixels, 0.015);
  const high = percentile(histogram, opaquePixels, 0.985);
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] === 0) continue;
    const balancedRed = data[offset] * gains[0];
    const balancedGreen = data[offset + 1] * gains[1];
    const balancedBlue = data[offset + 2] * gains[2];
    const sourceLuminance = luminance(balancedRed, balancedGreen, balancedBlue);
    const targetLuminance = stretchedLuminance(sourceLuminance, low, high, 0.72);
    const luminanceScale = targetLuminance / Math.max(1, sourceLuminance);
    const scaledRed = balancedRed * luminanceScale;
    const scaledGreen = balancedGreen * luminanceScale;
    const scaledBlue = balancedBlue * luminanceScale;
    const scaledLuminance = luminance(scaledRed, scaledGreen, scaledBlue);
    data[offset] = clampByte(scaledLuminance + (scaledRed - scaledLuminance) * 0.9);
    data[offset + 1] = clampByte(scaledLuminance + (scaledGreen - scaledLuminance) * 0.9);
    data[offset + 2] = clampByte(scaledLuminance + (scaledBlue - scaledLuminance) * 0.9);
  }
  sharpen(surface, 0.08);
}
