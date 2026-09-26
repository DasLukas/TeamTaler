import type { ScanRectangle } from './types';

/**
 * Maps the visible scan box to source pixels for a centered object-fit: cover video.
 * @param source - Camera frame dimensions in pixels.
 * @param video - Displayed video rectangle in viewport coordinates.
 * @param region - Inner scan box in the same viewport coordinates.
 * @returns A source crop rounded inward, or null for an invalid/hidden scan box.
 * @throws Never; unusable geometry must not broaden the scanning area.
 */
export function getScanCrop(source: { width: number; height: number }, video: ScanRectangle, region: ScanRectangle): ScanRectangle | null {
  if ([source.width, source.height, video.width, video.height, region.width, region.height].some((value) => !Number.isFinite(value) || value <= 0)) return null;
  if ([video.x, video.y, region.x, region.y].some((value) => !Number.isFinite(value))) return null;
  const scale = Math.max(video.width / source.width, video.height / source.height);
  const offsetX = (source.width * scale - video.width) / 2;
  const offsetY = (source.height * scale - video.height) / 2;
  const left = Math.max(video.x, region.x);
  const top = Math.max(video.y, region.y);
  const right = Math.min(video.x + video.width, region.x + region.width);
  const bottom = Math.min(video.y + video.height, region.y + region.height);
  const x = Math.max(0, Math.ceil((left - video.x + offsetX) / scale));
  const y = Math.max(0, Math.ceil((top - video.y + offsetY) / scale));
  const width = Math.min(source.width, Math.floor((right - video.x + offsetX) / scale)) - x;
  const height = Math.min(source.height, Math.floor((bottom - video.y + offsetY) / scale)) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}
