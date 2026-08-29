import { describe, expect, it } from 'vitest';

import {
  Geometry,
  InvalidCoordinatesError,
  encodePoints,
  formatCoord,
  validatePoint,
} from '../src/index.js';

describe('validatePoint', () => {
  it('accepts a well-formed pair', () => {
    expect(() => validatePoint([103.8198, 1.3521])).not.toThrow();
  });

  it('rejects a point with the wrong length', () => {
    expect(() => validatePoint([103.8198])).toThrow(InvalidCoordinatesError);
    expect(() => validatePoint([103.8198, 1.3521, 5])).toThrow(
      'expected [longitude, latitude], got 3 value(s)',
    );
  });

  it('rejects non-finite values', () => {
    expect(() => validatePoint([NaN, 1])).toThrow('must be finite numbers');
    expect(() => validatePoint([103, Infinity])).toThrow('must be finite numbers');
  });

  it('rejects an out-of-range longitude', () => {
    expect(() => validatePoint([181, 0])).toThrow('longitude 181 is outside [-180, 180]');
    expect(() => validatePoint([-180.5, 0])).toThrow(InvalidCoordinatesError);
  });

  it('rejects an out-of-range latitude and hints at swapped coordinates', () => {
    expect(() => validatePoint([0, 91])).toThrow(
      'latitude 91 is outside [-90, 90] (coordinates are [longitude, latitude])',
    );
  });

  it('catches the common [lat, lon] mistake for Singapore', () => {
    expect(() => validatePoint([1.3521, 103.8198])).toThrow(
      'latitude 103.8198 is outside [-90, 90]',
    );
  });
});

describe('formatCoord', () => {
  it('round-trips typical coordinates', () => {
    expect(formatCoord(103.8198)).toBe('103.8198');
    expect(formatCoord(1.3521)).toBe('1.3521');
    expect(formatCoord(-6.1754)).toBe('-6.1754');
  });

  it('drops insignificant zeros', () => {
    expect(formatCoord(1.5)).toBe('1.5');
    expect(formatCoord(0)).toBe('0');
    expect(formatCoord(100)).toBe('100');
    expect(formatCoord(-0)).toBe('0');
  });

  it('converts scientific notation to fixed point', () => {
    expect(formatCoord(1e-7)).toBe('0.0000001');
    expect(formatCoord(1.2e-6)).toBe('0.0000012');
  });
});

describe('encodePoints', () => {
  it('joins points with semicolons', () => {
    expect(
      encodePoints([
        [103.8198, 1.3521],
        [103.9915, 1.3644],
      ]),
    ).toBe('103.8198,1.3521;103.9915,1.3644');
  });

  it('rejects an empty list', () => {
    expect(() => encodePoints([])).toThrow('at least one coordinate is required');
  });

  it('prefixes per-coordinate errors with the index', () => {
    expect(() => encodePoints([[0, 0], [1, 200], [0, 0]])).toThrow(
      'coordinate 1: justrouting: latitude 200 is outside',
    );
  });
});

describe('Geometry', () => {
  it('reports zero when the server omitted the geometry', () => {
    const g = new Geometry(null);
    expect(g.isZero()).toBe(true);
    expect(g.raw()).toBeNull();
    expect(() => g.polyline()).toThrow('geometry is empty');
    expect(() => g.geoJSON()).toThrow('geometry is empty');
  });

  it('preserves an encoded polyline string', () => {
    const g = new Geometry('q`kpA~dulLfC_C~AhB');
    expect(g.isZero()).toBe(false);
    expect(g.polyline()).toBe('q`kpA~dulLfC_C~AhB');
    expect(g.raw()).toBe('q`kpA~dulLfC_C~AhB');
    expect(() => g.geoJSON()).toThrow('geometry is not GeoJSON');
  });

  it('decodes a GeoJSON LineString', () => {
    const g = new Geometry({
      type: 'LineString',
      coordinates: [
        [103.8198, 1.3521],
        [103.9915, 1.3644],
      ],
    });
    const line = g.geoJSON();
    expect(line.type).toBe('LineString');
    expect(line.coordinates).toEqual([
      [103.8198, 1.3521],
      [103.9915, 1.3644],
    ]);
    expect(() => g.polyline()).toThrow('geometry is not an encoded polyline');
  });
});
