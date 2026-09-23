import { describe, expect, it } from 'vitest';
import { runtimeConfig } from '../apps/server/src/config.js';

describe('explicit deployment modes', () => {
  const cloud = {
    ACORNARY_MODE: 'cloud',
    ACORNARY_ORIGIN: 'https://acornary.protium.top',
    BETTER_AUTH_SECRET: 'test-only-secret-with-more-than-32-characters',
    ACORNARY_TRUSTED_PROXY: '172.30.78.10',
  };
  it('keeps local mode separate and rejects unknown modes', () => {
    expect(runtimeConfig({})).toEqual({ mode: 'local' });
    expect(() => runtimeConfig({ ACORNARY_MODE: 'typo' })).toThrow();
  });
  it('never falls back from incomplete cloud configuration', () => {
    for (const key of Object.keys(cloud).filter((k) => k !== 'ACORNARY_MODE')) {
      expect(() => runtimeConfig({ ...cloud, [key]: '' })).toThrow();
    }
    for (const origin of [
      'http://example.com',
      'https://example.com/path',
      'https://user@example.com',
    ])
      expect(() => runtimeConfig({ ...cloud, ACORNARY_ORIGIN: origin })).toThrow();
    expect(() => runtimeConfig({ ...cloud, ACORNARY_TRUSTED_PROXY: 'true' })).toThrow();
    expect(runtimeConfig(cloud)).toMatchObject({ resource: 'https://acornary.protium.top/mcp' });
  });
});
