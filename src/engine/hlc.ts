import { assertValidNodeId, SafetyViolationError } from './safety';
import type { ParsedHLC } from './types';

export const DEFAULT_MAX_DRIFT_MS = 60 * 60 * 1000; // 1 hour max future clock skew
const MAX_COUNTER = 0xffff;
const MAX_WALL_TIME_MS = 999_999_999_999_999; // 15 digits max

export function formatHlc(parsed: ParsedHLC): string {
  assertValidNodeId(parsed.nodeId);
  if (
    !Number.isSafeInteger(parsed.wallTimeMs) ||
    parsed.wallTimeMs < 0 ||
    parsed.wallTimeMs > MAX_WALL_TIME_MS
  ) {
    throw new SafetyViolationError(
      'INVALID_HLC_TIMESTAMP',
      `Invalid HLC wallTimeMs: ${String(parsed.wallTimeMs)}`
    );
  }
  if (
    !Number.isSafeInteger(parsed.counter) ||
    parsed.counter < 0 ||
    parsed.counter > MAX_COUNTER
  ) {
    throw new SafetyViolationError(
      'INVALID_HLC_COUNTER',
      `Invalid HLC counter: ${String(parsed.counter)}`
    );
  }

  const timePart = String(parsed.wallTimeMs).padStart(15, '0');
  const counterPart = parsed.counter.toString(16).toUpperCase().padStart(4, '0');
  return `${timePart}:${counterPart}:${parsed.nodeId}`;
}

export function parseHlc(hlc: string): ParsedHLC {
  if (typeof hlc !== 'string') {
    throw new SafetyViolationError('INVALID_HLC_FORMAT', 'HLC must be a string.');
  }
  const firstColon = hlc.indexOf(':');
  const secondColon = firstColon === -1 ? -1 : hlc.indexOf(':', firstColon + 1);
  if (firstColon !== 15 || secondColon !== 20) {
    throw new SafetyViolationError(
      'INVALID_HLC_FORMAT',
      `Malformed HLC string "${hlc}". Expected "<15-digit-ms>:<4-hex-counter>:<nodeId>".`
    );
  }

  const timeStr = hlc.slice(0, 15);
  const counterStr = hlc.slice(16, 20);
  const nodeId = hlc.slice(21);

  if (!/^\d{15}$/.test(timeStr)) {
    throw new SafetyViolationError(
      'INVALID_HLC_TIMESTAMP',
      `HLC timestamp segment "${timeStr}" must be 15 decimal digits.`
    );
  }
  if (!/^[0-9A-Fa-f]{4}$/.test(counterStr)) {
    throw new SafetyViolationError(
      'INVALID_HLC_COUNTER',
      `HLC counter segment "${counterStr}" must be 4 hexadecimal characters.`
    );
  }
  assertValidNodeId(nodeId);

  return {
    wallTimeMs: Number.parseInt(timeStr, 10),
    counter: Number.parseInt(counterStr, 16),
    nodeId,
  };
}

export function compareHlc(a: string, b: string): number {
  const parsedA = parseHlc(a);
  const parsedB = parseHlc(b);

  if (parsedA.wallTimeMs !== parsedB.wallTimeMs) {
    return parsedA.wallTimeMs < parsedB.wallTimeMs ? -1 : 1;
  }
  if (parsedA.counter !== parsedB.counter) {
    return parsedA.counter < parsedB.counter ? -1 : 1;
  }
  if (parsedA.nodeId === parsedB.nodeId) {
    return 0;
  }
  return parsedA.nodeId < parsedB.nodeId ? -1 : 1;
}

export class HybridLogicalClock {
  private readonly nodeId: string;
  private readonly maxDriftMs: number;
  private lastWallTimeMs: number;
  private lastCounter: number;

  constructor(nodeId: string, initialWallTimeMs = 0, maxDriftMs = DEFAULT_MAX_DRIFT_MS) {
    this.nodeId = assertValidNodeId(nodeId);
    if (!Number.isSafeInteger(maxDriftMs) || maxDriftMs <= 0) {
      throw new SafetyViolationError('INVALID_DRIFT_CONFIG', 'maxDriftMs must be a positive integer.');
    }
    this.maxDriftMs = maxDriftMs;
    this.lastWallTimeMs = Math.max(0, Math.trunc(initialWallTimeMs));
    this.lastCounter = 0;
  }

  public getNodeId(): string {
    return this.nodeId;
  }

  public getState(): { readonly wallTimeMs: number; readonly counter: number } {
    return {
      wallTimeMs: this.lastWallTimeMs,
      counter: this.lastCounter,
    };
  }

  public restoreState(state: { readonly wallTimeMs: number; readonly counter: number }): void {
    this.lastWallTimeMs = state.wallTimeMs;
    this.lastCounter = state.counter;
  }

  public now(physicalTimeMs = Date.now()): string {
    const safePhysical = this.validatePhysicalTime(physicalTimeMs);
    if (safePhysical > this.lastWallTimeMs) {
      this.lastWallTimeMs = safePhysical;
      this.lastCounter = 0;
    } else {
      this.incrementCounter(safePhysical);
    }

    return formatHlc({
      wallTimeMs: this.lastWallTimeMs,
      counter: this.lastCounter,
      nodeId: this.nodeId,
    });
  }

  /** Validate a remote timestamp without advancing the clock. */
  public validateRemoteHlc(remoteHlcString: string, physicalTimeMs = Date.now()): ParsedHLC {
    const safePhysical = this.validatePhysicalTime(physicalTimeMs);
    const remote = parseHlc(remoteHlcString);
    if (remote.wallTimeMs - safePhysical > this.maxDriftMs) {
      throw new SafetyViolationError(
        'HLC_CLOCK_DRIFT_EXCEEDED',
        `Remote HLC (${remote.wallTimeMs}) exceeds local physical time (${safePhysical}) by more than maxDriftMs (${this.maxDriftMs}ms). Rejecting to prevent LWW clock-poisoning attack.`
      );
    }
    return remote;
  }

  public receive(remoteHlcString: string, physicalTimeMs = Date.now()): string {
    const safePhysical = this.validatePhysicalTime(physicalTimeMs);
    const remote = this.validateRemoteHlc(remoteHlcString, safePhysical);

    if (safePhysical > this.lastWallTimeMs && safePhysical > remote.wallTimeMs) {
      this.lastWallTimeMs = safePhysical;
      this.lastCounter = 0;
    } else if (this.lastWallTimeMs === remote.wallTimeMs) {
      this.lastCounter = Math.max(this.lastCounter, remote.counter) + 1;
      this.handleOverflowIfNeeded(safePhysical);
    } else if (this.lastWallTimeMs > remote.wallTimeMs) {
      this.incrementCounter(safePhysical);
    } else {
      this.lastWallTimeMs = remote.wallTimeMs;
      this.lastCounter = remote.counter + 1;
      this.handleOverflowIfNeeded(safePhysical);
    }

    return formatHlc({
      wallTimeMs: this.lastWallTimeMs,
      counter: this.lastCounter,
      nodeId: this.nodeId,
    });
  }

  private incrementCounter(physicalTimeMs: number): void {
    this.lastCounter += 1;
    this.handleOverflowIfNeeded(physicalTimeMs);
  }

  private handleOverflowIfNeeded(physicalTimeMs: number): void {
    if (this.lastCounter > MAX_COUNTER) {
      const nextWall = this.lastWallTimeMs + 1;
      if (nextWall - physicalTimeMs > this.maxDriftMs) {
        throw new SafetyViolationError(
          'HLC_COUNTER_OVERFLOW',
          'HLC logical counter overflowed and advancing wallTimeMs would exceed maxDriftMs.'
        );
      }
      this.lastWallTimeMs = nextWall;
      this.lastCounter = 0;
    }
  }

  private validatePhysicalTime(physicalTimeMs: number): number {
    if (
      typeof physicalTimeMs !== 'number' ||
      !Number.isFinite(physicalTimeMs) ||
      physicalTimeMs < 0
    ) {
      throw new SafetyViolationError(
        'INVALID_PHYSICAL_TIME',
        `Physical clock reading must be a non-negative finite number, got ${String(physicalTimeMs)}.`
      );
    }
    return Math.trunc(physicalTimeMs);
  }
}
