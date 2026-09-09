const managedImageWidths = [128, 256, 384] as const;
const managedImagePathPattern = /^\/api\/v1\/(?:groups\/[^/]+\/images\/[0-9a-f]{64}\.png|users\/[^/]+\/avatar\/[0-9a-f]{64}\.png|system\/groups\/[^/]+\/logo)$/;

function variantUrl(source: string, width: number): string {
  const separator = source.includes('?') ? '&' : '?';
  return `${source}${separator}width=${width}`;
}

/**
 * Reports whether a URL addresses a protected managed image that supports
 * responsive server variants.
 *
 * @param source - Candidate image URL.
 * @returns Whether the URL belongs to a variant-capable API route.
 */
export function supportsManagedImageVariants(source: string): boolean {
  try {
    const parsed = new URL(source, window.location.origin);
    return parsed.origin === window.location.origin && managedImagePathPattern.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Builds the bounded responsive display sources for one managed image.
 *
 * @param source - Canonical protected PNG URL.
 * @returns A 384-pixel default source and width-descriptor source set.
 */
export function managedImageSources(source: string): { src: string; srcSet: string } {
  return {
    src: variantUrl(source, 384),
    srcSet: managedImageWidths.map((width) => `${variantUrl(source, width)} ${width}w`).join(', '),
  };
}
