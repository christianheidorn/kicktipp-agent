import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadUrlModule(baseUrl?: string) {
  vi.resetModules();
  if (baseUrl) process.env.KICKTIPP_BASE_URL = baseUrl;
  else delete process.env.KICKTIPP_BASE_URL;
  return import('../src/url.js');
}

afterEach(() => {
  delete process.env.KICKTIPP_BASE_URL;
});

describe('getPredictUrl', () => {
  it('uses German routes by default', async () => {
    const { getPredictUrl } = await loadUrlModule();
    expect(getPredictUrl('mycomm')).toBe(
      'https://www.kicktipp.de/mycomm/tippabgabe',
    );
  });

  it('uses English routes for kicktipp.com', async () => {
    const { getPredictUrl } = await loadUrlModule('https://www.kicktipp.com');
    expect(getPredictUrl('mycomm', 5)).toBe(
      'https://www.kicktipp.com/mycomm/predict?spieltagIndex=5',
    );
  });

  it('throws on invalid matchday', async () => {
    const { getPredictUrl } = await loadUrlModule();
    expect(() => getPredictUrl('mycomm', 42)).toThrow();
    expect(() => getPredictUrl('mycomm', 0)).toThrow();
  });
});

describe('getLeaderboardUrl', () => {
  it('uses the current German tippuebersicht route by default', async () => {
    const { getLeaderboardUrl } = await loadUrlModule();
    expect(getLeaderboardUrl('mycomm')).toBe(
      'https://www.kicktipp.de/mycomm/tippuebersicht',
    );
  });

  it('combines bonus and matchday params on English routes', async () => {
    const { getLeaderboardUrl } = await loadUrlModule('https://www.kicktipp.com');
    expect(getLeaderboardUrl('mycomm', 2, true)).toBe(
      'https://www.kicktipp.com/mycomm/leaderboard?bonus=true&spieltagIndex=2',
    );
  });
});

describe('getAlternateUrls', () => {
  it('offers German and English aliases across both Kicktipp hosts', async () => {
    const { getAlternateUrls } = await loadUrlModule('https://www.kicktipp.com');
    expect(getAlternateUrls('https://www.kicktipp.com/mycomm/predict?spieltagIndex=1')).toEqual([
      'https://www.kicktipp.com/mycomm/tippabgabe?spieltagIndex=1',
      'https://www.kicktipp.de/mycomm/tippabgabe?spieltagIndex=1',
      'https://www.kicktipp.de/mycomm/predict?spieltagIndex=1',
    ]);
  });
});

describe('getScheduleUrl', () => {
  it('uses German and English schedule slugs', async () => {
    const de = await loadUrlModule();
    expect(de.getScheduleUrl('mycomm', 3)).toBe(
      'https://www.kicktipp.de/mycomm/tippspielplan?spieltagIndex=3',
    );

    const en = await loadUrlModule('https://www.kicktipp.com');
    expect(en.getScheduleUrl('mycomm', 3)).toBe(
      'https://www.kicktipp.com/mycomm/schedule?spieltagIndex=3',
    );
  });
});

