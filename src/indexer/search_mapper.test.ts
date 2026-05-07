import { describe, expect, it } from 'vitest';
import { propertyMapper } from './search_mapper.ts';

describe('search_mapper location', () => {
  // Regression: maps a Place with geo.asWKT into the indexed location array
  it('extracts location[] from geo.asWKT — public Rapid Community Data Lab crates use this shape', () => {
    const properties: Record<string, unknown> = {};
    const value = {
      '@id': 'http://example.org/places/1',
      geo: [{ asWKT: ['POINT(150.63825488091 -33.773081221375)'] }],
    };
    const ret = propertyMapper.contentLocation!(value, { properties });
    expect(properties.location).toEqual(['POINT(150.63825488091 -33.773081221375)']);
    expect(ret).toEqual({ '@id': 'http://example.org/places/1' });
  });

  // Regression: maps a Place with literal latitude/longitude into a GeoJSON point
  it('extracts location[] from literal latitude/longitude', () => {
    const properties: Record<string, unknown> = {};
    propertyMapper.spatialCoverage!({ latitude: -33.86, longitude: 151.21 }, { properties });
    expect(properties.location).toEqual([{ type: 'point', coordinates: [151.21, -33.86] }]);
  });

  // Regression: does not set location when no geo data is present
  it('does not set properties.location when no geo data is present', () => {
    const properties: Record<string, unknown> = {};
    propertyMapper.contentLocation!({ '@id': 'x' }, { properties });
    expect(properties.location).toBeUndefined();
  });
});

