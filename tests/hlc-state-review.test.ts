import { describe, expect, it } from 'vitest';
import { compareHlc, formatHlc, HybridLogicalClock, parseHlc } from '../src/engine';

const maxWall = 999_999_999_999_999;
const remote = (wallTimeMs: number, counter = 0) => formatHlc({ wallTimeMs, counter, nodeId: 'remote' });

describe('HLC state validation and boundaries', () => {
  it.each([NaN, Infinity, -Infinity, -1, 0.5, maxWall + 1])('rejects initial timestamp %s', initial => {
    expect(() => new HybridLogicalClock('local', initial)).toThrow(/INVALID_HLC_TIMESTAMP/);
  });

  it('accepts both representable initial timestamp endpoints', () => {
    expect(new HybridLogicalClock('local', 0).getState()).toEqual({ wallTimeMs: 0, counter: 0 });
    expect(new HybridLogicalClock('local', maxWall).getState()).toEqual({ wallTimeMs: maxWall, counter: 0 });
  });

  it.each([NaN, Infinity, -Infinity, -1, 0.5, maxWall + 1])('rejects restored timestamp %s without changing state', wallTimeMs => {
    const clock = new HybridLogicalClock('local', 1000);
    clock.now(1000);
    const before = clock.getState();
    expect(() => clock.restoreState({ wallTimeMs, counter: 0 })).toThrow(/INVALID_HLC_TIMESTAMP/);
    expect(clock.getState()).toEqual(before);
  });

  it.each([NaN, Infinity, -1, 0.5, 0x10000])('rejects restored counter %s without changing either state field', counter => {
    const clock = new HybridLogicalClock('local', 1000);
    const before = clock.getState();
    expect(() => clock.restoreState({ wallTimeMs: 2000, counter })).toThrow(/INVALID_HLC_COUNTER/);
    expect(clock.getState()).toEqual(before);
  });

  it.each([NaN, Infinity, -Infinity, -1, maxWall + 1])('rejects physical timestamp %s before changing state', physical => {
    const clock = new HybridLogicalClock('local', 1000);
    const before = clock.getState();
    expect(() => clock.now(physical)).toThrow(/INVALID_PHYSICAL_TIME/);
    expect(clock.getState()).toEqual(before);
    expect(() => clock.receive(remote(1000), physical)).toThrow(/INVALID_PHYSICAL_TIME/);
    expect(clock.getState()).toEqual(before);
  });

  it('retains truncation of finite fractional physical readings', () => {
    const clock = new HybridLogicalClock('local');
    expect(parseHlc(clock.now(1000.9))).toMatchObject({ wallTimeMs: 1000, counter: 0 });
    expect(parseHlc(clock.receive(remote(800), 1001.9))).toMatchObject({ wallTimeMs: 1001, counter: 0 });
  });

  it('accepts the exact remote drift limit but rejects one millisecond beyond it atomically', () => {
    const clock = new HybridLogicalClock('local', 1000, 60);
    expect(parseHlc(clock.receive(remote(1060), 1000))).toMatchObject({ wallTimeMs: 1060, counter: 1 });
    const before = clock.getState();
    expect(() => clock.receive(remote(1061), 1000)).toThrow(/HLC_CLOCK_DRIFT_EXCEEDED/);
    expect(clock.getState()).toEqual(before);
  });

  it('uses the maximum counter before advancing the wall time with bounded overflow', () => {
    const clock = new HybridLogicalClock('local', 1000, 1);
    clock.restoreState({ wallTimeMs: 1000, counter: 0xfffe });
    const lastCounter = clock.now(1000);
    expect(parseHlc(lastCounter)).toMatchObject({ wallTimeMs: 1000, counter: 0xffff });
    const overflow = clock.now(1000);
    expect(parseHlc(overflow)).toMatchObject({ wallTimeMs: 1001, counter: 0 });
    expect(compareHlc(lastCounter, overflow)).toBeLessThan(0);
  });

  it('retains state when a local counter overflow would exceed the drift limit', () => {
    const clock = new HybridLogicalClock('local', 1060, 60);
    clock.restoreState({ wallTimeMs: 1060, counter: 0xffff });
    const before = clock.getState();
    expect(() => clock.now(1000)).toThrow(/HLC_COUNTER_OVERFLOW/);
    expect(clock.getState()).toEqual(before);
    expect(() => clock.receive(remote(1060), 1000)).toThrow(/HLC_COUNTER_OVERFLOW/);
    expect(clock.getState()).toEqual(before);
  });

  it('retains state when accepting a remote maximum counter would overflow the drift bound', () => {
    const clock = new HybridLogicalClock('local', 1000, 60);
    const before = clock.getState();
    expect(() => clock.receive(remote(1060, 0xffff), 1000)).toThrow(/HLC_COUNTER_OVERFLOW/);
    expect(clock.getState()).toEqual(before);
  });

  it('does not overflow the maximum representable wall time', () => {
    const clock = new HybridLogicalClock('local', maxWall);
    clock.restoreState({ wallTimeMs: maxWall, counter: 0xffff });
    const before = clock.getState();
    expect(() => clock.now(maxWall)).toThrow(/HLC_COUNTER_OVERFLOW/);
    expect(clock.getState()).toEqual(before);
    expect(() => clock.receive(remote(maxWall, 0xffff), maxWall)).toThrow(/HLC_COUNTER_OVERFLOW/);
    expect(clock.getState()).toEqual(before);
  });
});
