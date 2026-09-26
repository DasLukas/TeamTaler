/**
 * Rotates already cropped RGBA pixels without clipping or sampling outside the scan area.
 * @param frame - Opaque camera pixels, bounded to 720 pixels per side by the caller.
 * @param degrees - Counterclockwise angle used to align diagonal linear barcodes.
 * @returns A bilinearly sampled grayscale, white-padded image with the complete rotated source and no DOM dependency.
 * @throws {RangeError} If allocating the bounded destination fails.
 */
export function rotateFrame(frame: ImageData, degrees: number): ImageData {
  const radians = degrees * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const width = Math.ceil(Math.abs(cos) * frame.width + Math.abs(sin) * frame.height);
  const height = Math.ceil(Math.abs(sin) * frame.width + Math.abs(cos) * frame.height);
  const data = new Uint8ClampedArray(width * height * 4);
  const output = new Uint32Array(data.buffer);
  const luminance = new Uint8Array(frame.width * frame.height);
  for (let i = 0; i < luminance.length; i++) luminance[i] = (77 * frame.data[i * 4] + 150 * frame.data[i * 4 + 1] + 29 * frame.data[i * 4 + 2]) >>> 8;
  output.fill(0xffffffff);
  for (let y = 0; y < height; y++) {
    const dy = y + .5 - height / 2;
    for (let x = 0; x < width; x++) {
      const dx = x + .5 - width / 2;
      let sourceX = cos * dx - sin * dy + (frame.width - 1) / 2;
      let sourceY = sin * dx + cos * dy + (frame.height - 1) / 2;
      if (sourceX < -.5 || sourceY < -.5 || sourceX >= frame.width - .5 || sourceY >= frame.height - .5) continue;
      sourceX = Math.max(0, Math.min(frame.width - 1, sourceX));
      sourceY = Math.max(0, Math.min(frame.height - 1, sourceY));
      const x0 = Math.floor(sourceX);
      const y0 = Math.floor(sourceY);
      const fx = sourceX - x0;
      const fy = sourceY - y0;
      const row = y0 * frame.width + x0;
      const nextX = x0 < frame.width - 1 ? 1 : 0;
      const nextY = y0 < frame.height - 1 ? frame.width : 0;
      const top = luminance[row] * (1 - fx) + luminance[row + nextX] * fx;
      const bottom = luminance[row + nextY] * (1 - fx) + luminance[row + nextY + nextX] * fx;
      const gray = Math.round(top * (1 - fy) + bottom * fy);
      output[y * width + x] = (255 << 24) | (gray << 16) | (gray << 8) | gray;
    }
  }
  return { data, width, height, colorSpace: 'srgb' } as ImageData;
}
