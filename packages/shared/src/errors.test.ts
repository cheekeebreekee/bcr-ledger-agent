import {
  ClassificationError,
  ForbiddenError,
  LedgerAgentError,
  SharePointError,
  UnauthorizedError,
  ValidationError,
} from './errors';

describe('error hierarchy', () => {
  it.each([
    [new ValidationError('v'), 'ValidationError', 400],
    [new UnauthorizedError(), 'Unauthorized', 401],
    [new ForbiddenError(), 'Forbidden', 403],
    [new ClassificationError('c'), 'ClassificationError', 422],
    [new SharePointError('s'), 'SharePointError', 502],
    [new SharePointError('s', 409), 'SharePointError', 409],
  ])('%s carries its code and HTTP status', (err, code, status) => {
    expect(err).toBeInstanceOf(LedgerAgentError);
    expect(err.code).toBe(code);
    expect(err.httpStatus).toBe(status);
    expect(err.name).toBe(err.constructor.name);
  });

  it('keeps the cause', () => {
    const cause = new Error('root');
    expect(new ForbiddenError('f', cause).cause).toBe(cause);
    expect(new LedgerAgentError('X', 'm').httpStatus).toBe(500);
  });
});
