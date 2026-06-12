/**
 * Typed error classes shared across the bot and ingestion functions.
 * Carrying explicit error codes lets the bot translate failures into
 * user-facing adaptive-card messages without sniffing message strings.
 */

/** Base class so callers can do `err instanceof LedgerAgentError`. */
export class LedgerAgentError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;
  public readonly cause?: unknown;

  constructor(code: string, message: string, httpStatus = 500, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.cause = cause;
  }
}

export class ValidationError extends LedgerAgentError {
  constructor(message: string, cause?: unknown) {
    super('ValidationError', message, 400, cause);
  }
}

export class UnauthorizedError extends LedgerAgentError {
  constructor(message = 'Unauthorized', cause?: unknown) {
    super('Unauthorized', message, 401, cause);
  }
}

export class ForbiddenError extends LedgerAgentError {
  constructor(message = 'Forbidden', cause?: unknown) {
    super('Forbidden', message, 403, cause);
  }
}

export class ClassificationError extends LedgerAgentError {
  constructor(message: string, cause?: unknown) {
    super('ClassificationError', message, 422, cause);
  }
}

export class SharePointError extends LedgerAgentError {
  constructor(message: string, httpStatus = 502, cause?: unknown) {
    super('SharePointError', message, httpStatus, cause);
  }
}
