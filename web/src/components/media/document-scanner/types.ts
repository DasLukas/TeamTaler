/** A point expressed relative to an image's width and height. */
export interface NormalizedPoint {
  /** Horizontal position in the inclusive range from zero to one. */
  x: number;
  /** Vertical position in the inclusive range from zero to one. */
  y: number;
}

/** The four document corners ordered clockwise from the top-left corner. */
export type DocumentCorners = readonly [NormalizedPoint, NormalizedPoint, NormalizedPoint, NormalizedPoint];

/** Rotation supported by the scanner without resampling the source repeatedly. */
export type PageRotation = 0 | 90 | 180 | 270;

/** Available local document enhancement modes. */
export type DocumentFilter = 'color' | 'grayscale' | 'original';

/** One locally owned source page and its non-destructive edit state. */
export interface ScannerPage {
  /** Stable identifier used by list rendering and reordering. */
  id: string;
  /** Original image selected or captured by the user. */
  file: File;
  /** Original source height read from the bounded image header. */
  sourceHeight: number;
  /** Original source width read from the bounded image header. */
  sourceWidth: number;
  /** Component-owned object URL used exclusively for local previews. */
  previewUrl: string;
  /** Crop quadrilateral in original image coordinates. */
  corners: DocumentCorners;
  /** Clockwise page rotation applied to the generated PDF. */
  rotation: PageRotation;
  /** Enhancement applied while producing the final metadata-free image. */
  filter: DocumentFilter;
}

/** Result emitted by the asynchronous document detector. */
export interface DetectionResult {
  /** Correlation identifier copied from the detection request; zero identifies worker initialization. */
  requestId: number;
  /** Detector runtime state after attempting to process this frame. */
  status: 'ready' | 'unavailable';
  /** Validated quadrilateral ordered clockwise from top-left, when one was found. */
  corners?: DocumentCorners;
  /** Detector confidence from zero to one. */
  confidence: number;
}

/** Message that eagerly initializes the detector before camera frames are scheduled. */
export interface DetectionInitializeRequest {
  /** Discriminator for the worker readiness handshake. */
  type: 'initialize';
}

/** Message accepted by the document detection worker. */
export interface DetectionRequest {
  /** Discriminator used for safe worker-message parsing. */
  type: 'detect';
  /** Monotonically increasing request identifier. */
  requestId: number;
  /** Bounded RGBA camera preview copied into a transferable buffer. */
  imageData: ImageData;
}

/** Complete request protocol accepted by the document detection worker. */
export type DetectionWorkerRequest = DetectionInitializeRequest | DetectionRequest;
