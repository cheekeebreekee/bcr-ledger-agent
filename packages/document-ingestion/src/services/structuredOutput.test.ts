import { CLASSIFICATION_OUTPUT_SCHEMA } from './claudeClassifier';
import { NL_SEARCH_SCHEMA } from './searchInterpreter';
import { STRUCTURED_OUTPUT_MAX_UNION_PARAMETERS, unionParameterCount } from './structuredOutput';

describe('unionParameterCount', () => {
  it('counts anyOf and type arrays at any depth, once each', () => {
    expect(
      unionParameterCount({
        type: 'object',
        properties: {
          a: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          b: { type: ['integer', 'null'] },
          c: {
            type: 'object',
            properties: { d: { anyOf: [{ type: 'object', properties: {} }, { type: 'null' }] } },
          },
          e: { type: 'string', enum: ['x'] },
        },
      }),
    ).toBe(3);
    expect(unionParameterCount(null)).toBe(0);
  });
});

describe('the schemas we send stay within the API limits', () => {
  // Over the limit, the API refuses every call (400) and the feature is dead:
  // client search was, until its local evaluation on 28 September 2026 (18 unions).
  it.each([
    ['client search (NL_SEARCH_SCHEMA)', NL_SEARCH_SCHEMA],
    ['classification (CLASSIFICATION_OUTPUT_SCHEMA)', CLASSIFICATION_OUTPUT_SCHEMA],
  ])('%s has at most 16 union-typed parameters', (_name, schema) => {
    expect(unionParameterCount(schema)).toBeLessThanOrEqual(STRUCTURED_OUTPUT_MAX_UNION_PARAMETERS);
  });
});
