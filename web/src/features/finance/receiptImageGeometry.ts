/** Pixel dimensions used by the receipt-image viewport. */
export interface ImageSize { width: number; height: number }

/**
 * Calculates a fitted image and scrollable frame that account for quarter-turn rotation.
 *
 * @param image - Natural image dimensions.
 * @param viewport - Available preview dimensions.
 * @param zoom - Zoom percentage relative to the fitted image.
 * @param rotation - Clockwise rotation in degrees.
 * @returns Pixel dimensions for the image and its oriented scroll frame, or null before measurement.
 */
export function imagePreviewGeometry(image: ImageSize, viewport: ImageSize, zoom: number, rotation: number) {
  if (image.width <= 0 || image.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return null;
  const quarterTurn = rotation % 180 !== 0;
  const orientedWidth = quarterTurn ? image.height : image.width;
  const orientedHeight = quarterTurn ? image.width : image.height;
  const fit = Math.min(1, Math.max(1, viewport.width - 32) / orientedWidth, Math.max(1, viewport.height - 32) / orientedHeight);
  const scale = fit * zoom / 100;
  return {
    imageWidth: image.width * scale,
    imageHeight: image.height * scale,
    frameWidth: orientedWidth * scale,
    frameHeight: orientedHeight * scale,
  };
}
