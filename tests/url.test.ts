import { describe, it, expect } from 'vitest';
import { getPredictUrl } from '../src/url.js';

describe('getPredictUrl', () => {
  it('without matchday', () => {
    expect(getPredictUrl('mycomm')).toBe(
      'https://www.kicktipp.de/mycomm/tippabgabe',
    );
  });

  it('with matchday', () => {
    expect(getPredictUrl('mycomm', 5)).toBe(
      'https://www.kicktipp.de/mycomm/tippabgabe?spieltagIndex=5',
    );
  });

  it('throws on invalid matchday', () => {
    expect(() => getPredictUrl('mycomm', 42)).toThrow();
    expect(() => getPredictUrl('mycomm', 0)).toThrow();
  });
});
