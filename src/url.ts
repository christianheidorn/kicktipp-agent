const DEFAULT_BASE_URL = 'https://www.kicktipp.de';

type RouteKey =
  | 'login'
  | 'communities'
  | 'predict'
  | 'leaderboard'
  | 'overview'
  | 'schedule'
  | 'table'
  | 'rules'
  | 'adminMembers'
  | 'adminTips';

const ROUTES: Record<RouteKey, { de: string; en: string }> = {
  login: { de: '/info/profil/login', en: '/info/profile/login' },
  communities: { de: '/info/profil/meinetipprunden', en: '/info/profile/prediction-games' },
  predict: { de: '/:community/tippabgabe', en: '/:community/predict' },
  leaderboard: { de: '/:community/tippuebersicht', en: '/:community/leaderboard' },
  overview: { de: '/:community/gesamtuebersicht', en: '/:community/overview' },
  schedule: { de: '/:community/tippspielplan', en: '/:community/schedule' },
  table: { de: '/:community/tabellen', en: '/:community/tables' },
  rules: { de: '/:community/spielregeln', en: '/:community/rules' },
  // Kicktipp does not currently expose stable English admin aliases for these
  // pages; keep the German Spielleiter paths and let domain fallback handle
  // hosts that redirect community pages differently.
  adminMembers: { de: '/:community/spielleiter/mitgliederliste', en: '/:community/spielleiter/mitgliederliste' },
  adminTips: { de: '/:community/spielleiter/tippsnachtragen', en: '/:community/spielleiter/tippsnachtragen' },
};

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function isEnglishBase(base: string): boolean {
  return new URL(base).hostname.endsWith('kicktipp.com');
}

function languageForBase(base: string): 'de' | 'en' {
  return isEnglishBase(base) ? 'en' : 'de';
}

function oppositeBase(base: string): string {
  const url = new URL(base);
  if (url.hostname.endsWith('kicktipp.com')) url.hostname = url.hostname.replace(/kicktipp\.com$/, 'kicktipp.de');
  else if (url.hostname.endsWith('kicktipp.de')) url.hostname = url.hostname.replace(/kicktipp\.de$/, 'kicktipp.com');
  return normalizeBaseUrl(url.toString());
}

export const URL_BASE = normalizeBaseUrl(process.env.KICKTIPP_BASE_URL || DEFAULT_BASE_URL);
export const URL_LOGIN = buildUrl('login');

function routePath(route: RouteKey, community?: string, base = URL_BASE): string {
  const lang = languageForBase(base);
  const template = ROUTES[route][lang];
  if (template.includes(':community')) {
    if (!community) throw new Error(`Community is required for route ${route}.`);
    return template.replace(':community', encodeURIComponent(community));
  }
  return template;
}

function buildUrl(route: RouteKey, community?: string, params?: URLSearchParams, base = URL_BASE): string {
  const url = new URL(routePath(route, community, base), base);
  if (params) {
    for (const [key, value] of params) url.searchParams.append(key, value);
  }
  return url.toString();
}

function assertMatchday(matchday: number): void {
  if (matchday < 1 || matchday > 34) {
    throw new RangeError(
      `The matchday '${matchday}' is not valid, use only 1 to 34!`,
    );
  }
}

export function getCommunitiesUrl(): string {
  return buildUrl('communities');
}

export function getPredictUrl(
  community: string,
  matchday?: number,
): string {
  const params = new URLSearchParams();
  if (matchday !== undefined) {
    assertMatchday(matchday);
    params.set('spieltagIndex', String(matchday));
  }
  return buildUrl('predict', community, params);
}

export function getBonusPredictUrl(community: string): string {
  const params = new URLSearchParams({ bonus: 'true' });
  return buildUrl('predict', community, params);
}

export function getLeaderboardUrl(
  community: string,
  matchday?: number,
  bonus = false,
): string {
  const params = new URLSearchParams();
  if (bonus) params.set('bonus', 'true');
  if (matchday !== undefined) {
    assertMatchday(matchday);
    params.set('spieltagIndex', String(matchday));
  }
  return buildUrl('leaderboard', community, params);
}

export function getScheduleUrl(community: string, matchday?: number): string {
  const params = new URLSearchParams();
  if (matchday !== undefined) {
    assertMatchday(matchday);
    params.set('spieltagIndex', String(matchday));
  }
  return buildUrl('schedule', community, params);
}

export function getOverviewUrl(community: string, ansicht: string): string {
  return buildUrl('overview', community, new URLSearchParams({ ansicht }));
}

export function getTableUrl(community: string, option?: 'home' | 'away'): string {
  const params = new URLSearchParams();
  if (option === 'home') params.set('option', 'heim');
  else if (option === 'away') params.set('option', 'gast');
  return buildUrl('table', community, params);
}

export function getRulesUrl(community: string): string {
  return buildUrl('rules', community);
}

export function getAdminMembersUrl(community: string): string {
  return buildUrl('adminMembers', community);
}

export function getAdminTipsUrl(
  community: string,
  tipperId: string,
  tippsaisonId: string,
  matchday?: number,
  bonus = false,
): string {
  const params = new URLSearchParams({
    tipperId,
    tippsaisonId,
  });
  if (bonus) params.set('bonus', 'true');
  if (matchday !== undefined) {
    assertMatchday(matchday);
    params.set('spieltagIndex', String(matchday));
  }
  return buildUrl('adminTips', community, params);
}

function routeVariantsForPath(pathname: string): string[] {
  const parts = pathname.split('/').filter(Boolean);

  if (parts.length >= 3 && parts[0] === 'info') {
    const key = parts.slice(0, 3).join('/');
    if (key === 'info/profil/login' || key === 'info/profile/login') {
      return [ROUTES.login.de, ROUTES.login.en];
    }
    if (key === 'info/profil/meinetipprunden' || key === 'info/profile/prediction-games') {
      return [ROUTES.communities.de, ROUTES.communities.en];
    }
    return [pathname];
  }

  if (!parts.length) return [pathname];
  const community = parts[0];
  const rest = parts.slice(1).join('/');
  const variants: string[] = [];

  for (const route of Object.values(ROUTES)) {
    const de = route.de.replace(':community', community).replace(/^\//, '');
    const en = route.en.replace(':community', community).replace(/^\//, '');
    if (rest === de.split('/').slice(1).join('/') || rest === en.split('/').slice(1).join('/')) {
      variants.push(route.de.replace(':community', community));
      variants.push(route.en.replace(':community', community));
      break;
    }
  }

  return variants.length ? Array.from(new Set(variants)) : [pathname];
}

export function getAlternateUrls(rawUrl: string): string[] {
  const current = new URL(rawUrl);
  const bases = Array.from(new Set([
    normalizeBaseUrl(current.origin),
    oppositeBase(current.origin),
    URL_BASE,
    oppositeBase(URL_BASE),
  ]));
  const paths = routeVariantsForPath(current.pathname);
  const urls: string[] = [];

  for (const base of bases) {
    for (const path of paths) {
      const url = new URL(path, base);
      url.search = current.search;
      const next = url.toString();
      if (next !== rawUrl && !urls.includes(next)) urls.push(next);
    }
  }

  return urls;
}

