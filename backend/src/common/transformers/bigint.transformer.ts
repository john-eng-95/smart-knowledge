import { ValueTransformer } from 'typeorm';

export const bigintTransformer: ValueTransformer = {
  to: (value) => (value == null ? null : String(value)),
  from: (value) =>
    value === null || value === undefined
      ? (value as null | undefined)
      : String(value),
};
