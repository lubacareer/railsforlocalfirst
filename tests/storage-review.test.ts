import { describe, expect, it } from 'vitest';
import { validateByoStorageConfig } from '../src/engine/storage';
import { SafetyViolationError } from '../src/engine/safety';

function endpoint(hostname: string): void {
  validateByoStorageConfig({
    provider: 's3-compatible',
    bucketOrFolderName: 'sync-bucket',
    endpointUrl: `https://${hostname}/`,
  });
}

describe('storage endpoint literal hostname validation', () => {
  it.each([
    'localhost.', 'sub.localhost', 'metadata.google.internal.',
    '0.0.0.0', '127.0.0.1', '127.1', '0x7f000001', '10.0.0.1',
    '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '100.127.255.255',
    '[::]', '[::1]', '[fc01::1]', '[fdff::1]', '[fe80::1]', '[febf::1]',
    '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]', '[::ffff:a9fe:a9fe]',
    '[::ffff:100.64.0.1]',
  ])('rejects restricted address or hostname %s', (hostname) => {
    try {
      endpoint(hostname);
      expect.fail(`Expected ${hostname} to be rejected`);
    } catch (error) {
      expect(error).toBeInstanceOf(SafetyViolationError);
      expect((error as SafetyViolationError).code).toBe('SSRF_PRIVATE_HOST_BLOCKED');
    }
  });

  it.each([
    'example.com', 'my-localhost.example', 'metadata.google.internal.example',
    '8.8.8.8', '100.63.255.255', '100.128.0.1', '172.15.1.1', '172.32.1.1',
    '[2606:4700:4700::1111]', '[::ffff:8.8.8.8]', '[fec0::1]',
  ])('allows public address or hostname %s', (hostname) => {
    expect(() => endpoint(hostname)).not.toThrow();
  });
});
