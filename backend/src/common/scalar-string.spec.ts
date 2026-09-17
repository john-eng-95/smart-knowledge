import { scalarToString } from './scalar-string';

describe('scalarToString', () => {
  it('converts scalar values without stringifying objects', () => {
    expect(scalarToString('value')).toBe('value');
    expect(scalarToString(42)).toBe('42');
    expect(scalarToString(true)).toBe('true');
    expect(scalarToString({ value: 42 }, 'fallback')).toBe('fallback');
    expect(scalarToString(null)).toBe('');
  });
});
