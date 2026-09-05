const developmentBuildId = 'dev@unknown';

/** Immutable identifier embedded into the currently loaded web-client build. */
export const clientBuildId = import.meta.env.VITE_BUILD_ID?.trim() || developmentBuildId;
