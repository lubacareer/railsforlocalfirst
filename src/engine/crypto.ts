import { compareHlc, parseHlc } from './hlc';
import {
  assertValidNodeId,
  assertValidSqlIdentifier,
  assertValidStorageKey,
  MAX_BATCH_OPERATIONS,
  MAX_PAYLOAD_BYTES,
  safeJsonParse,
  SafetyViolationError,
} from './safety';
import type {
  CrdtChangeOperation,
  EncryptedSyncEnvelope,
  SyncPlaintextPayload,
} from './types';

export const DEFAULT_KDF_ITERATIONS = 210_000;
export const MIN_KDF_ITERATIONS = 100_000;
export const MAX_KDF_ITERATIONS = 2_000_000;
const SALT_BYTE_LENGTH = 16;
const IV_BYTE_LENGTH = 12;
const AES_TAG_BITS = 128;
const MIN_PASSPHRASE_LENGTH = 12;

function getWebCrypto(): Crypto {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    return globalThis.crypto;
  }
  throw new SafetyViolationError(
    'WEBCRYPTO_UNAVAILABLE',
    'WebCrypto API (crypto.subtle) is required for E2EE operations.'
  );
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof b64 !== 'string' || b64.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new SafetyViolationError('INVALID_BASE64', 'Invalid base64 string encoding.');
  }
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const webCrypto = getWebCrypto();
  const digest = await webCrypto.subtle.digest('SHA-256', data as BufferSource);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function buildCanonicalAadBytes(params: {
  readonly protocolVersion: number;
  readonly envelopeId: string;
  readonly nodeId: string;
  readonly table: string;
  readonly schemaVersion: number;
  readonly minHlc: string;
  readonly maxHlc: string;
  readonly operationCount: number;
  readonly payloadSha256: string;
}): Uint8Array {
  const canonical = JSON.stringify([
    params.protocolVersion,
    params.envelopeId,
    params.nodeId,
    params.table,
    params.schemaVersion,
    params.minHlc,
    params.maxHlc,
    params.operationCount,
    params.payloadSha256,
  ]);
  return new TextEncoder().encode(canonical);
}

async function deriveAesGcmKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
  usage: readonly KeyUsage[]
): Promise<CryptoKey> {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new SafetyViolationError(
      'WEAK_PASSPHRASE',
      `Encryption passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`
    );
  }
  if (
    !Number.isSafeInteger(iterations) ||
    iterations < MIN_KDF_ITERATIONS ||
    iterations > MAX_KDF_ITERATIONS
  ) {
    throw new SafetyViolationError(
      'INVALID_KDF_ITERATIONS',
      `PBKDF2 iterations must be between ${MIN_KDF_ITERATIONS} and ${MAX_KDF_ITERATIONS}.`
    );
  }

  const webCrypto = getWebCrypto();
  const keyMaterial = await webCrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return webCrypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    {
      name: 'AES-GCM',
      length: 256,
    },
    false,
    [...usage]
  );
}

export async function encryptSyncOperations(params: {
  readonly envelopeId: string;
  readonly nodeId: string;
  readonly table: string;
  readonly schemaVersion: number;
  readonly operations: readonly CrdtChangeOperation[];
  readonly passphrase: string;
  readonly kdfIterations?: number;
}): Promise<EncryptedSyncEnvelope> {
  assertValidStorageKey(params.envelopeId);
  assertValidNodeId(params.nodeId);
  assertValidSqlIdentifier(params.table, 'table');

  if (!Number.isSafeInteger(params.schemaVersion) || params.schemaVersion < 1) {
    throw new SafetyViolationError('INVALID_SCHEMA_VERSION', 'Schema version must be >= 1.');
  }
  if (params.operations.length === 0) {
    throw new SafetyViolationError('EMPTY_SYNC_BATCH', 'Cannot encrypt an empty operation batch.');
  }
  if (params.operations.length > MAX_BATCH_OPERATIONS) {
    throw new SafetyViolationError(
      'BATCH_SIZE_EXCEEDED',
      `Operation count (${params.operations.length}) exceeds maximum (${MAX_BATCH_OPERATIONS}).`
    );
  }

  let minHlc = params.operations[0]!.hlc;
  let maxHlc = params.operations[0]!.hlc;
  for (const op of params.operations) {
    parseHlc(op.hlc);
    if (compareHlc(op.hlc, minHlc) < 0) {
      minHlc = op.hlc;
    }
    if (compareHlc(op.hlc, maxHlc) > 0) {
      maxHlc = op.hlc;
    }
  }

  const plaintextPayload: SyncPlaintextPayload = {
    protocolVersion: 1,
    envelopeId: params.envelopeId,
    nodeId: params.nodeId,
    table: params.table,
    schemaVersion: params.schemaVersion,
    minHlc,
    maxHlc,
    operations: params.operations,
  };

  const plaintextBytes = new TextEncoder().encode(JSON.stringify(plaintextPayload));
  if (plaintextBytes.byteLength > MAX_PAYLOAD_BYTES) {
    throw new SafetyViolationError(
      'PAYLOAD_TOO_LARGE',
      `Serialized sync batch (${plaintextBytes.byteLength} bytes) exceeds maximum (${MAX_PAYLOAD_BYTES} bytes).`
    );
  }

  const payloadSha256 = await sha256Hex(plaintextBytes);
  const webCrypto = getWebCrypto();
  const salt = webCrypto.getRandomValues(new Uint8Array(SALT_BYTE_LENGTH));
  const iv = webCrypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
  const iterations = params.kdfIterations ?? DEFAULT_KDF_ITERATIONS;

  const key = await deriveAesGcmKey(params.passphrase, salt, iterations, ['encrypt']);
  const aad = buildCanonicalAadBytes({
    protocolVersion: 1,
    envelopeId: params.envelopeId,
    nodeId: params.nodeId,
    table: params.table,
    schemaVersion: params.schemaVersion,
    minHlc,
    maxHlc,
    operationCount: params.operations.length,
    payloadSha256,
  });

  const ciphertextBuffer = await webCrypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as BufferSource,
      additionalData: aad as BufferSource,
      tagLength: AES_TAG_BITS,
    },
    key,
    plaintextBytes as BufferSource
  );

  return Object.freeze({
    envelopeId: params.envelopeId,
    protocolVersion: 1,
    nodeId: params.nodeId,
    table: params.table,
    schemaVersion: params.schemaVersion,
    minHlc,
    maxHlc,
    operationCount: params.operations.length,
    payloadSha256,
    kdfSaltBase64: bytesToBase64(salt),
    kdfIterations: iterations,
    ivBase64: bytesToBase64(iv),
    ciphertextBase64: bytesToBase64(new Uint8Array(ciphertextBuffer)),
    createdAtIso: new Date().toISOString(),
  });
}

export async function decryptSyncEnvelope(
  envelope: EncryptedSyncEnvelope,
  passphrase: string
): Promise<SyncPlaintextPayload> {
  if (!envelope || envelope.protocolVersion !== 1) {
    throw new SafetyViolationError(
      'UNSUPPORTED_PROTOCOL_VERSION',
      `Unsupported envelope protocolVersion: ${String(envelope?.protocolVersion)}.`
    );
  }

  assertValidStorageKey(envelope.envelopeId);
  assertValidNodeId(envelope.nodeId);
  assertValidSqlIdentifier(envelope.table, 'table');
  parseHlc(envelope.minHlc);
  parseHlc(envelope.maxHlc);

  if (
    !Number.isSafeInteger(envelope.operationCount) ||
    envelope.operationCount <= 0 ||
    envelope.operationCount > MAX_BATCH_OPERATIONS
  ) {
    throw new SafetyViolationError(
      'INVALID_OPERATION_COUNT',
      `Invalid envelope operationCount: ${String(envelope.operationCount)}.`
    );
  }

  if (!/^[0-9a-f]{64}$/.test(envelope.payloadSha256)) {
    throw new SafetyViolationError('INVALID_PAYLOAD_HASH', 'Invalid SHA-256 hex digest format.');
  }

  const salt = base64ToBytes(envelope.kdfSaltBase64);
  const iv = base64ToBytes(envelope.ivBase64);
  const ciphertext = base64ToBytes(envelope.ciphertextBase64);

  if (salt.byteLength !== SALT_BYTE_LENGTH) {
    throw new SafetyViolationError('INVALID_SALT_LENGTH', 'KDF salt must be 16 bytes.');
  }
  if (iv.byteLength !== IV_BYTE_LENGTH) {
    throw new SafetyViolationError('INVALID_IV_LENGTH', 'AES-GCM IV must be 12 bytes.');
  }
  if (ciphertext.byteLength <= AES_TAG_BITS / 8) {
    throw new SafetyViolationError('INVALID_CIPHERTEXT', 'Ciphertext is truncated or empty.');
  }

  const key = await deriveAesGcmKey(passphrase, salt, envelope.kdfIterations, ['decrypt']);
  const aad = buildCanonicalAadBytes({
    protocolVersion: envelope.protocolVersion,
    envelopeId: envelope.envelopeId,
    nodeId: envelope.nodeId,
    table: envelope.table,
    schemaVersion: envelope.schemaVersion,
    minHlc: envelope.minHlc,
    maxHlc: envelope.maxHlc,
    operationCount: envelope.operationCount,
    payloadSha256: envelope.payloadSha256,
  });

  const webCrypto = getWebCrypto();
  let decryptedBuffer: ArrayBuffer;
  try {
    decryptedBuffer = await webCrypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv as BufferSource,
        additionalData: aad as BufferSource,
        tagLength: AES_TAG_BITS,
      },
      key,
      ciphertext as BufferSource
    );
  } catch {
    throw new SafetyViolationError(
      'CRYPTO_AUTHENTICATION_FAILED',
      'AES-256-GCM authentication failed: wrong passphrase, tampered ciphertext, or modified AAD headers.'
    );
  }

  const plaintextBytes = new Uint8Array(decryptedBuffer);
  const computedHash = await sha256Hex(plaintextBytes);
  if (!constantTimeEqualHex(computedHash, envelope.payloadSha256)) {
    throw new SafetyViolationError(
      'PAYLOAD_HASH_MISMATCH',
      'Decrypted payload SHA-256 digest does not match authenticated header.'
    );
  }

  const decodedText = new TextDecoder().decode(plaintextBytes);
  const payload = safeJsonParse<SyncPlaintextPayload>(decodedText);

  if (
    payload.protocolVersion !== 1 ||
    payload.envelopeId !== envelope.envelopeId ||
    payload.nodeId !== envelope.nodeId ||
    payload.table !== envelope.table ||
    payload.schemaVersion !== envelope.schemaVersion ||
    payload.minHlc !== envelope.minHlc ||
    payload.maxHlc !== envelope.maxHlc ||
    !Array.isArray(payload.operations) ||
    payload.operations.length !== envelope.operationCount
  ) {
    throw new SafetyViolationError(
      'ENVELOPE_HEADER_MISMATCH',
      'Inner authenticated payload headers do not match outer envelope metadata.'
    );
  }

  return payload;
}

