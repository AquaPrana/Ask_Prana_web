export const MAX_CYCLE_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_CYCLE_IMPORT_FILES = 10;

const HEIC_EXTENSIONS = /\.(heic|heif)$/i;

export function isUnsupportedRecordType(
  mimeType?: string | null,
  fileName?: string | null,
) {
  return HEIC_EXTENSIONS.test(fileName ?? "") || /heic|heif/i.test(mimeType ?? "");
}

export function isSupportedRecordType(
  mimeType?: string | null,
  fileName?: string | null,
) {
  return !isUnsupportedRecordType(mimeType, fileName);
}

export function sniffRecordMimeFromBytes(
  _bytes: Uint8Array,
  fallbackMime?: string | null,
) {
  return fallbackMime ?? "application/octet-stream";
}