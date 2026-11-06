import { describe, expect, it } from 'vitest';
import { productionCsp } from '../vite.config';

function parsePolicy(policy: string): Map<string, string[]> {
  const entries = policy.split(';').map(part => part.trim().split(/\s+/))
    .filter(parts => parts[0]).map(([name, ...values]) => [name!, values] as const);
  const names = entries.map(([name]) => name.toLowerCase());
  expect(new Set(names).size, 'CSP directive names must be unique').toBe(names.length);
  return new Map(entries);
}

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
    const directives = parsePolicy(result[0]!.attrs.content!);
    expect(directives).toEqual(new Map([
      ['default-src', ["'self'"]],
      ['script-src', ["'self'"]],
      ['style-src', ["'self'", "'unsafe-inline'"]],
      ['img-src', ["'self'", 'data:']],
      ['connect-src', ["'self'"]],
      ['object-src', ["'none'"]],
      ['base-uri', ["'self'"]],
    ]));
  });

  it.each(['script-src', 'SCRIPT-SRC'])('rejects duplicate %s directives before Map overwrites them', name => {
    expect(() => parsePolicy(`script-src *; ${name} 'self';`)).toThrow(/CSP directive names must be unique/);
  });
});
