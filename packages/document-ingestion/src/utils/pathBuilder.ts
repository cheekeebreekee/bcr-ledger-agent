import { ValidationError } from '@bcr/shared';

/**
 * Characters that SharePoint rejects in file or folder names.
 * Source: https://learn.microsoft.com/sharepoint/sites/forbidden-special-chars
 */
const FORBIDDEN_CHARS = /["*:<>?/\\|]/g;
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

const MAX_SEGMENT_LENGTH = 255;
const MAX_PATH_LENGTH = 400;

/**
 * Normalises a folder path so it's safe to send to Microsoft Graph:
 *   - removes leading/trailing slashes
 *   - collapses duplicate slashes
 *   - replaces forbidden characters with `_`
 *   - rejects `..` segments outright
 *   - rejects empty paths
 */
export function sanitizeFolderPath(input: string): string {
  if (!input || typeof input !== 'string') {
    throw new ValidationError('Folder path is required');
  }
  const segments = input.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) {
    throw new ValidationError('Folder path resolved to an empty string');
  }
  const safe = segments.map(sanitizeSegment);
  const joined = safe.join('/');
  if (joined.length > MAX_PATH_LENGTH) {
    throw new ValidationError(`Folder path exceeds ${MAX_PATH_LENGTH} chars`);
  }
  return joined;
}

/**
 * Normalises a single filename. Preserves the extension so MIME inference
 * still works on the SharePoint side.
 */
export function sanitizeFilename(input: string): string {
  if (!input || typeof input !== 'string') {
    throw new ValidationError('Filename is required');
  }
  const trimmed = input.trim();
  const lastDot = trimmed.lastIndexOf('.');
  const baseRaw = lastDot > 0 ? trimmed.slice(0, lastDot) : trimmed;
  const ext = lastDot > 0 ? trimmed.slice(lastDot).trim() : '';
  const base = sanitizeSegment(baseRaw);
  if (!base) throw new ValidationError(`Filename "${input}" is empty after sanitisation`);
  const safeExt = ext.replace(FORBIDDEN_CHARS, '');
  const candidate = `${base}${safeExt}`;
  if (candidate.length > MAX_SEGMENT_LENGTH) {
    throw new ValidationError(`Filename exceeds ${MAX_SEGMENT_LENGTH} chars`);
  }
  return candidate;
}

/**
 * Safely joins a (possibly-undefined) root with a relative path.
 * Useful when a tenant prefixes every upload with e.g. `Ledger/`.
 */
export function joinFolderPath(root: string | undefined, relative: string): string {
  if (!root) return relative;
  return `${root.replace(/\/+$/, '')}/${relative.replace(/^\/+/, '')}`;
}

/**
 * Encode an already-sanitised, `/`-separated path for use inside a Graph URL
 * (`/drives/{id}/root:/{path}:/content`). Each segment is percent-encoded on
 * its own so `#`, `%`, `?` and spaces — "Dokumenty księgowe" has one — can't
 * truncate or redirect the request, while the separators stay separators.
 *
 * Always call this AFTER {@link sanitizeFolderPath} / {@link sanitizeFilename};
 * encoding is not sanitising.
 */
export function encodeGraphPath(sanitisedPath: string): string {
  return sanitisedPath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function sanitizeSegment(segment: string): string {
  const trimmed = segment.trim();
  if (trimmed === '..' || trimmed === '.') {
    throw new ValidationError(`Folder traversal not allowed: "${segment}"`);
  }
  const cleaned = trimmed
    .replace(FORBIDDEN_CHARS, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '');
  if (!cleaned) {
    throw new ValidationError(`Folder segment is empty after sanitising "${segment}"`);
  }
  if (RESERVED_NAMES.has(cleaned.toUpperCase().split('.')[0] ?? '')) {
    throw new ValidationError(`Folder segment "${cleaned}" is a reserved name`);
  }
  if (cleaned.length > MAX_SEGMENT_LENGTH) {
    throw new ValidationError(`Folder segment exceeds ${MAX_SEGMENT_LENGTH} chars`);
  }
  return cleaned;
}
