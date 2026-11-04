import {
  assertValidSqlIdentifier,
  assertValidStorageKey,
  SafetyViolationError,
} from './safety';
import type { EncryptedSyncEnvelope, StorageAdapter } from './types';

export type ByoProviderKind = 's3-compatible' | 'icloud-drive' | 'google-drive' | 'memory';

export interface ByoStorageConfig {
  readonly provider: ByoProviderKind;
  readonly bucketOrFolderName: string;
  readonly endpointUrl?: string;
}

const PRIVATE_OR_METADATA_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^169\.254\./, // Cloud metadata endpoint SSRF vector
  /^0\./,
  /^\[?::1\]?$/,
  /^\[?fe80:/i,
  /^\[?fc00:/i,
  /^\[?fd00:/i,
];

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
    for (const pattern of PRIVATE_OR_METADATA_HOST_PATTERNS) {
      if (pattern.test(hostname)) {
        throw new SafetyViolationError(
          'SSRF_PRIVATE_HOST_BLOCKED',
          `Endpoint hostname "${hostname}" resolves to a restricted local/private/metadata address.`
        );
      }
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
      if (a.minHlc !== b.minHlc) {
        return a.minHlc < b.minHlc ? -1 : 1;
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

