import {
  assertValidSqlIdentifier,
  assertValidStorageKey,
  SafetyViolationError,
} from './safety';
import type { EncryptedSyncEnvelope, StorageAdapter } from './types';
import { compareHlc, parseHlc } from './hlc';

export type ByoProviderKind = 's3-compatible' | 'icloud-drive' | 'google-drive' | 'memory';

export interface ByoStorageConfig {
  readonly provider: ByoProviderKind;
  readonly bucketOrFolderName: string;
  readonly endpointUrl?: string;
}

function isRestrictedIpv4(octets: readonly number[]): boolean {
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b !== undefined && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a !== undefined && a >= 224);
}

// URL.hostname canonicalizes IP literals, including IPv4-mapped IPv6, to hex.
function parseIpv6(hostname: string): readonly number[] {
  const [left = '', right = ''] = hostname.split('::');
  const leftGroups = left ? left.split(':').map((part) => Number.parseInt(part, 16)) : [];
  const rightGroups = right ? right.split(':').map((part) => Number.parseInt(part, 16)) : [];
  return hostname.includes('::')
    ? [...leftGroups, ...Array<number>(8 - leftGroups.length - rightGroups.length).fill(0), ...rightGroups]
    : leftGroups;
}

function isRestrictedHost(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/\.+$/, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'metadata.google.internal') {
    return true;
  }
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const groups = parseIpv6(hostname.slice(1, -1));
    const first = groups[0]!;
    const allZeroPrefix = groups.slice(0, 7).every((group) => group === 0);
    if ((allZeroPrefix && (groups[7] === 0 || groups[7] === 1)) ||
        (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 ||
        groups.slice(0, 6).every((group) => group === 0) || // IPv4-compatible IPv6
        (first === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) ||
        first === 0x2002 || // 6to4
        (first === 0x2001 && groups[1] === 0)) { // Teredo
      return true;
    }
    if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
      const high = groups[6]!;
      const low = groups[7]!;
      return isRestrictedIpv4([high >> 8, high & 255, low >> 8, low & 255]);
    }
    return false;
  }
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(hostname)
    ? hostname.split('.').map(Number)
    : null;
  return ipv4 !== null && isRestrictedIpv4(ipv4);
}

export function validateByoStorageConfig(config: ByoStorageConfig): ByoStorageConfig {
  assertValidStorageKey(config.bucketOrFolderName);

  if (config.provider === 's3-compatible') {
    if (!config.endpointUrl) {
      throw new SafetyViolationError(
        'MISSING_S3_ENDPOINT',
        'S3-compatible provider requires an HTTPS endpointUrl.'
      );
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(config.endpointUrl);
    } catch {
      throw new SafetyViolationError(
        'INVALID_S3_ENDPOINT_URL',
        `Malformed endpoint URL: "${config.endpointUrl}".`
      );
    }

    if (parsedUrl.protocol !== 'https:') {
      throw new SafetyViolationError(
        'INSECURE_STORAGE_ENDPOINT',
        `BYO-Storage endpoint must use HTTPS, got "${parsedUrl.protocol}".`
      );
    }

    if (parsedUrl.username || parsedUrl.password) {
      throw new SafetyViolationError(
        'CREDENTIALS_IN_URL_FORBIDDEN',
        'Credentials must not be embedded in the endpoint URL.'
      );
    }

    const hostname = parsedUrl.hostname;
    if (isRestrictedHost(hostname)) {
      throw new SafetyViolationError(
        'SSRF_PRIVATE_HOST_BLOCKED',
        `Endpoint hostname "${hostname}" is a restricted local/private/metadata hostname or address.`
      );
    }
  }

  return Object.freeze({ ...config });
}

export class InMemoryByoStorageAdapter implements StorageAdapter {
  public readonly name: string;
  public readonly config: ByoStorageConfig;
  private readonly envelopes = new Map<string, EncryptedSyncEnvelope>();

  constructor(
    config: ByoStorageConfig = {
      provider: 'memory',
      bucketOrFolderName: 'localfirst-sync-vault',
    }
  ) {
    this.config = validateByoStorageConfig(config);
    this.name = `${config.provider}:${config.bucketOrFolderName}`;
  }

  public async putEnvelope(envelope: EncryptedSyncEnvelope): Promise<void> {
    assertValidStorageKey(envelope.envelopeId);
    assertValidSqlIdentifier(envelope.table, 'table');

    if (this.envelopes.has(envelope.envelopeId)) {
      throw new SafetyViolationError(
        'IMMUTABLE_ENVELOPE_CONFLICT',
        `Envelope "${envelope.envelopeId}" already exists in storage (content-addressed blobs are immutable).`
      );
    }

    this.envelopes.set(envelope.envelopeId, Object.freeze({ ...envelope }));
  }

  public async getEnvelope(envelopeId: string): Promise<EncryptedSyncEnvelope | null> {
    assertValidStorageKey(envelopeId);
    const found = this.envelopes.get(envelopeId);
    return found ? { ...found } : null;
  }

  public async listEnvelopeIds(table?: string): Promise<readonly string[]> {
    if (table !== undefined) {
      assertValidSqlIdentifier(table, 'table');
    }
    const matching: EncryptedSyncEnvelope[] = [];
    for (const env of this.envelopes.values()) {
      if (table === undefined || env.table === table) {
        matching.push(env);
      }
    }
    matching.sort((a, b) => {
      // Invalid untrusted headers must not make listing fail; sort them last.
      let aValid = true;
      let bValid = true;
      try { parseHlc(a.minHlc); } catch { aValid = false; }
      try { parseHlc(b.minHlc); } catch { bValid = false; }
      if (aValid !== bValid) return aValid ? -1 : 1;
      if (aValid && bValid) {
        const order = compareHlc(a.minHlc, b.minHlc);
        if (order !== 0) return order;
      }
      return a.envelopeId < b.envelopeId ? -1 : a.envelopeId > b.envelopeId ? 1 : 0;
    });
    return matching.map((e) => e.envelopeId);
  }

  public async deleteEnvelope(envelopeId: string): Promise<void> {
    assertValidStorageKey(envelopeId);
    this.envelopes.delete(envelopeId);
  }

  public inspectAllEnvelopes(): readonly EncryptedSyncEnvelope[] {
    return [...this.envelopes.values()].map((e) => ({ ...e }));
  }

  /**
   * Test/Diagnostic helper to simulate an untrusted cloud storage provider or
   * attacker mutating a stored envelope in-place (used to prove E2EE tamper rejection).
   */
  public unsafeOverwriteForTamperTest(
    envelopeId: string,
    tampered: EncryptedSyncEnvelope
  ): void {
    assertValidStorageKey(envelopeId);
    this.envelopes.set(envelopeId, Object.freeze({ ...tampered }));
  }
}

