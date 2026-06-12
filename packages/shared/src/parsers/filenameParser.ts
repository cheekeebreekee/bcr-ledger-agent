import type { FilenamePattern } from './patternRegistry';
import { defaultPatterns } from './patternRegistry';

/**
 * Result of parsing a filename against the pattern registry.
 */
export interface FilenameParseResult {
  readonly matched: boolean;
  readonly pattern?: FilenamePattern;
  readonly documentType?: string;
  readonly folderPath?: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly confidence: number;
}

/**
 * Mutable registry of filename patterns. Defaults to {@link defaultPatterns}
 * but accepts custom patterns at construction time so different tenants can
 * have their own naming conventions without redeploying.
 */
export class PatternRegistry {
  private readonly patterns: FilenamePattern[];

  constructor(patterns: readonly FilenamePattern[] = defaultPatterns) {
    this.patterns = [...patterns];
  }

  /** Add a pattern, evaluated *after* the existing ones. */
  register(pattern: FilenamePattern): void {
    this.patterns.push(pattern);
  }

  /** Snapshot of the current pattern list. Mainly useful for tests/diagnostics. */
  list(): readonly FilenamePattern[] {
    return Object.freeze([...this.patterns]);
  }

  /**
   * Try every pattern in registration order and return the first match.
   */
  parse(filename: string): FilenameParseResult {
    const trimmed = stripExtension(filename);

    for (const pattern of this.patterns) {
      const match = pattern.regex.exec(trimmed);
      if (!match || !match.groups) continue;

      const normalised = normaliseGroups(match.groups);
      return {
        matched: true,
        pattern,
        documentType: pattern.documentType,
        folderPath: pattern.buildPath(normalised),
        fields: normalised,
        confidence: pattern.confidence ?? 0.95,
      };
    }

    return { matched: false, fields: {}, confidence: 0 };
  }
}

/** Singleton parser that uses the default pattern set. */
export const defaultFilenameParser = new PatternRegistry();

// ---------------------------------------------------------------------------

/**
 * Strip the file extension so patterns can ignore it. Multi-dot filenames
 * (`Invoice_03_2026.signed.pdf`) drop only the last segment.
 */
export function stripExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  return lastDot > 0 ? filename.slice(0, lastDot) : filename;
}

/**
 * Pad month/day to two digits and year to four. Pass-through for everything
 * else so callers can also use the registry for non-date fields like
 * `counterparty` or `account`.
 */
export function normaliseGroups(
  groups: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(groups)) {
    if (rawValue === undefined) continue;
    const value = rawValue.trim();
    switch (key) {
      case 'month':
      case 'day':
        out[key] = value.padStart(2, '0');
        break;
      case 'year':
        out[key] = value.padStart(4, '0');
        break;
      default:
        out[key] = value;
    }
  }
  return Object.freeze(out);
}
