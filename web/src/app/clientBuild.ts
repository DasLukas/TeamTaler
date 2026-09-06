const developmentBuildId = 'dev@unknown';

/** Immutable identifier embedded into the currently loaded web-client build. */
export const clientBuildId = import.meta.env.VITE_BUILD_ID?.trim() || developmentBuildId;

/**
 * Extracts a normalized user-facing version from a client build identifier.
 *
 * @param buildId - Embedded identifier in `version@revision` format.
 * @returns The semantic version without a release-tag prefix or commit revision.
 */
export function clientVersionFromBuildId(buildId: string): string {
  return buildId.split('@', 1)[0].replace(/^v(?=\d)/, '');
}

/** User-facing semantic version derived from the loaded client build identifier. */
export const clientVersion = clientVersionFromBuildId(clientBuildId);
