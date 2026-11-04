import { describe, expect, it } from 'vitest';
import { productionCsp } from '../vite.config';

describe('production CSP', () => {
  it('omits the meta policy from the dev server and injects it for production', () => {
    const hook = productionCsp().transformIndexHtml as unknown as (
      html: string,
      context: { server?: unknown }
    ) => Array<{ attrs: Record<string, string>; injectTo: string }>;
    expect(hook('', { server: {} })).toEqual([]);
    const result = hook('', {});
    expect(result).toHaveLength(1);
    expect(result[0]?.attrs['http-equiv']).toBe('Content-Security-Policy');
    expect(result[0]?.injectTo).toBe('head-prepend');
    expect(result[0]?.attrs.content).toContain("default-src 'self'");
    expect(result[0]?.attrs.content).not.toContain('frame-ancestors');
  });
});
