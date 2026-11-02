const { AppError } = require('../errors');

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const KMA_FORECAST_BASE_HOURS = [2, 5, 8, 11, 14, 17, 20, 23];
const KMA_GRID_BOUNDS = { maxX: 149, maxY: 253, minX: 1, minY: 1 };

const pad2 = (value) => String(value).padStart(2, '0');

const validDate = (value) => value instanceof Date && !Number.isNaN(value.getTime());

const kstParts = (value) => {
  const date = validDate(value) ? value : new Date(value);
  if (!validDate(date)) throw new TypeError('A valid date is required.');

  // Korea does not observe daylight saving time, so shifting then reading UTC
  // fields gives stable Asia/Seoul clock values without a locale dependency.
  const kst = new Date(date.getTime() + KST_OFFSET_MS);
  return {
    date: `${kst.getUTCFullYear()}${pad2(kst.getUTCMonth() + 1)}${pad2(kst.getUTCDate())}`,
    hour: kst.getUTCHours(),
    minute: kst.getUTCMinutes(),
  };
};

const kstDateAfter = (value, days) => kstParts(new Date(value.getTime() + (days * DAY_MS))).date;

const toKstTimestamp = (date, time) => (
  `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:00+09:00`
);

const toIsoDate = (date) => `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;

const numericValue = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const rounded = (value) => {
  const number = numericValue(value);
  return number === null ? null : Math.round(number * 10) / 10;
};

const forecastTimeInMinutes = (time) => {
  if (!/^\d{4}$/.test(String(time))) return Number.POSITIVE_INFINITY;
  return (Number(time.slice(0, 2)) * 60) + Number(time.slice(2, 4));
};

function latLonToKmaGrid(latitude, longitude) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new AppError(400, 'INVALID_WEATHER_COORDINATES', '위치 좌표를 확인해 주세요.');
  }

  // KMA's Lambert conformal conic grid conversion, as documented for the
  // village forecast APIs. The resulting grid covers South Korea only.
  const re = 6371.00877 / 5.0;
  const slat1 = 30.0 * Math.PI / 180.0;
  const slat2 = 60.0 * Math.PI / 180.0;
  const olon = 126.0 * Math.PI / 180.0;
  const olat = 38.0 * Math.PI / 180.0;
  const xo = 43;
  const yo = 136;
  const sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) /
    Math.log(Math.tan((Math.PI * 0.25) + (slat2 * 0.5)) / Math.tan((Math.PI * 0.25) + (slat1 * 0.5)));
  const sf = (Math.tan((Math.PI * 0.25) + (slat1 * 0.5)) ** sn) * Math.cos(slat1) / sn;
  const ro = (re * sf) / (Math.tan((Math.PI * 0.25) + (olat * 0.5)) ** sn);
  const ra = (re * sf) / (Math.tan((Math.PI * 0.25) + ((lat * Math.PI / 180.0) * 0.5)) ** sn);
  let theta = (lon * Math.PI / 180.0) - olon;

  if (theta > Math.PI) theta -= 2.0 * Math.PI;
  if (theta < -Math.PI) theta += 2.0 * Math.PI;
  theta *= sn;

  const x = Math.floor((ra * Math.sin(theta)) + xo + 0.5);
  const y = Math.floor(ro - (ra * Math.cos(theta)) + yo + 0.5);
  if (x < KMA_GRID_BOUNDS.minX || x > KMA_GRID_BOUNDS.maxX || y < KMA_GRID_BOUNDS.minY || y > KMA_GRID_BOUNDS.maxY) {
    throw new AppError(422, 'WEATHER_UNSUPPORTED_LOCATION', '대한민국 내 위치에서만 날씨를 조회할 수 있습니다.');
  }

  return { x, y };
}

function getUltraSrtNcstBase(now) {
  // Observations are published shortly after each hour. Querying the previous
  // complete hour avoids an intermittent empty response around publication.
  const delayed = new Date(now.getTime() - (40 * 60 * 1000));
  const { date, hour } = kstParts(delayed);
  return { baseDate: date, baseTime: `${pad2(hour)}00` };
}

function getVilageFcstBase(now) {
  // The short forecast is published eight times daily. Allow a small buffer
  // after publication before asking KMA for the new issue.
  let delayed = new Date(now.getTime() - (15 * 60 * 1000));
  let parts = kstParts(delayed);
  let hour = KMA_FORECAST_BASE_HOURS.filter((candidate) => candidate <= parts.hour).at(-1);

  if (hour === undefined) {
    delayed = new Date(delayed.getTime() - DAY_MS);
    parts = kstParts(delayed);
    hour = KMA_FORECAST_BASE_HOURS.at(-1);
  }

  return { baseDate: parts.date, baseTime: `${pad2(hour)}00` };
}

function weatherCondition({ precipitationType, sky }) {
  const pty = numericValue(precipitationType) ?? 0;
  if (pty === 1) return { code: 'rain', condition: '비', emoji: '🌧️', label: '비' };
  if (pty === 2) return { code: 'rainSnow', condition: '비/눈', emoji: '🌨️', label: '비/눈' };
  if (pty === 3) return { code: 'snow', condition: '눈', emoji: '❄️', label: '눈' };
  if (pty === 4) return { code: 'shower', condition: '소나기', emoji: '🌦️', label: '소나기' };

  const skyValue = numericValue(sky);
  if (skyValue === 3) return { code: 'partlyCloudy', condition: '구름 조금', emoji: '⛅', label: '구름 조금' };
  if (skyValue === 4) return { code: 'cloudy', condition: '흐림', emoji: '☁️', label: '흐림' };
  if (skyValue === 1) return { code: 'clear', condition: '맑음', emoji: '☀️', label: '맑음' };
  return { code: 'unknown', condition: '날씨 정보', emoji: '🌤️', label: '날씨 정보' };
}

function categoryMap(items, valueKey) {
  return new Map(items.map((item) => [String(item.category), item[valueKey]]));
}

function forecastGroups(items, date) {
  const groups = new Map();
  for (const item of items) {
    if (String(item.fcstDate) !== date || !item.fcstTime || !item.category) continue;
    const time = String(item.fcstTime).padStart(4, '0');
    const group = groups.get(time) ?? new Map();
    group.set(String(item.category), item.fcstValue);
    groups.set(time, group);
  }
  return groups;
}

function closestForecastGroup(groups, targetMinutes) {
  let closest = null;
  for (const [time, values] of groups.entries()) {
    const difference = Math.abs(forecastTimeInMinutes(time) - targetMinutes);
    if (!closest || difference < closest.difference) closest = { difference, time, values };
  }
  return closest;
}

function maxCategory(groups, category) {
  const values = [...groups.values()]
    .map((group) => numericValue(group.get(category)))
    .filter((value) => value !== null);
  return values.length ? Math.max(...values) : null;
}

function minCategory(groups, category) {
  const values = [...groups.values()]
    .map((group) => numericValue(group.get(category)))
    .filter((value) => value !== null);
  return values.length ? Math.min(...values) : null;
}

function exactCategory(items, date, category) {
  const values = items
    .filter((item) => String(item.fcstDate) === date && String(item.category) === category)
    .map((item) => numericValue(item.fcstValue))
    .filter((value) => value !== null);
  return values.length ? values.at(-1) : null;
}

class KmaWeatherProvider {
  constructor({
    apiKey,
    baseUrl = 'https://apihub.kma.go.kr/api/typ02/openApi/VilageFcstInfoService_2.0/',
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    timeoutMs = 8_000,
  } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.baseUrl = `${String(baseUrl).replace(/\/+$/, '')}/`;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
  }

  getCacheKey({ lat, lon }) {
    const grid = latLonToKmaGrid(lat, lon);
    return `kma:${grid.x}:${grid.y}`;
  }

  async getWeather({ lat, lon }, { now = this.now() } = {}) {
    if (!this.apiKey) {
      throw new AppError(503, 'WEATHER_NOT_CONFIGURED', '날씨 서비스 설정이 아직 완료되지 않았습니다.');
    }
    if (typeof this.fetchImpl !== 'function') {
      throw new AppError(503, 'WEATHER_PROVIDER_UNAVAILABLE', '날씨 정보를 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.');
    }

    const observedAt = validDate(now) ? now : new Date(now);
    if (!validDate(observedAt)) throw new TypeError('A valid clock value is required.');

    const grid = latLonToKmaGrid(lat, lon);
    const currentBase = getUltraSrtNcstBase(observedAt);
    const forecastBase = getVilageFcstBase(observedAt);
    const today = kstParts(observedAt).date;
    const tomorrow = kstDateAfter(observedAt, 1);

    const [observedResult, forecastResult] = await Promise.allSettled([
      this.requestItems('getUltraSrtNcst', { ...currentBase, nx: grid.x, ny: grid.y }),
      this.requestItems('getVilageFcst', { ...forecastBase, nx: grid.x, ny: grid.y }),
    ]);
    if (observedResult.status === 'rejected') throw observedResult.reason;

    const observedItems = observedResult.value;
    const forecastItems = forecastResult.status === 'fulfilled' ? forecastResult.value : [];
    if (forecastResult.status === 'rejected') {
      console.warn('[weather] KMA tomorrow forecast unavailable', forecastResult.reason?.code ?? forecastResult.reason?.message);
    }

    const observations = categoryMap(observedItems, 'obsrValue');
    const currentForecast = closestForecastGroup(
      forecastGroups(forecastItems, today),
      (kstParts(observedAt).hour * 60) + kstParts(observedAt).minute,
    );
    const currentForecastValues = currentForecast?.values ?? new Map();
    const currentTemperature = rounded(observations.get('T1H') ?? currentForecastValues.get('TMP'));
    if (currentTemperature === null) {
      throw new AppError(503, 'WEATHER_DATA_UNAVAILABLE', '현재 날씨 자료가 아직 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.');
    }

    const currentPty = observations.get('PTY') ?? currentForecastValues.get('PTY') ?? '0';
    const currentCondition = weatherCondition({
      precipitationType: currentPty,
      sky: observations.get('SKY') ?? currentForecastValues.get('SKY'),
    });

    const tomorrowGroups = forecastGroups(forecastItems, tomorrow);
    let tomorrowSummary = null;
    if (tomorrowGroups.size) {
      const tomorrowRepresentative = closestForecastGroup(tomorrowGroups, 12 * 60)?.values ?? new Map();
      const tomorrowMin = exactCategory(forecastItems, tomorrow, 'TMN') ?? minCategory(tomorrowGroups, 'TMP');
      const tomorrowMax = exactCategory(forecastItems, tomorrow, 'TMX') ?? maxCategory(tomorrowGroups, 'TMP');
      if (tomorrowMin !== null && tomorrowMax !== null) {
        const tomorrowCondition = weatherCondition({
          precipitationType: tomorrowRepresentative.get('PTY'),
          sky: tomorrowRepresentative.get('SKY'),
        });
        tomorrowSummary = {
          ...tomorrowCondition,
          date: toIsoDate(tomorrow),
          maxTemperature: rounded(tomorrowMax),
          minTemperature: rounded(tomorrowMin),
          precipitationProbability: rounded(maxCategory(tomorrowGroups, 'POP')),
        };
      }
    }

    return {
      current: {
        ...currentCondition,
        humidity: rounded(observations.get('REH')),
        observedAt: toKstTimestamp(currentBase.baseDate, currentBase.baseTime),
        precipitationAmount: String(observations.get('RN1') ?? ''),
        temperature: currentTemperature,
        windSpeed: rounded(observations.get('WSD')),
      },
      location: {
        grid,
      },
      provider: 'kma',
      tomorrow: tomorrowSummary,
      updatedAt: new Date(observedAt.getTime()).toISOString(),
    };
  }

  async requestItems(endpoint, { baseDate, baseTime, nx, ny }) {
    const url = new URL(endpoint, this.baseUrl);
    url.search = new URLSearchParams({
      authKey: this.apiKey,
      base_date: baseDate,
      base_time: baseTime,
      dataType: 'JSON',
      nx: String(nx),
      ny: String(ny),
      numOfRows: '1000',
      pageNo: '1',
    }).toString();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    let payload;
    try {
      response = await this.fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      payload = await response.json();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'WEATHER_PROVIDER_UNAVAILABLE', '기상청 날씨 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      clearTimeout(timeout);
    }

    const root = payload?.response ?? payload;
    const header = root?.header ?? payload?.header ?? {};
    const code = String(header.resultCode ?? '');
    if (!response?.ok || (code && code !== '00' && code !== '0')) {
      throw new AppError(502, 'WEATHER_PROVIDER_UNAVAILABLE', '기상청 날씨 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }

    const rawItems = root?.body?.items?.item ?? [];
    const items = Array.isArray(rawItems) ? rawItems : [rawItems];
    if (!items.length || !items[0]) {
      throw new AppError(503, 'WEATHER_DATA_UNAVAILABLE', '날씨 자료가 아직 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.');
    }
    return items;
  }
}

class WeatherService {
  constructor({
    cacheTtlMs = 5 * 60 * 1000,
    maxCacheEntries = 512,
    now = () => new Date(),
    provider,
    staleTtlMs = 30 * 60 * 1000,
  } = {}) {
    if (!provider || typeof provider.getWeather !== 'function') throw new TypeError('A weather provider is required.');
    this.cacheTtlMs = cacheTtlMs;
    this.maxCacheEntries = maxCacheEntries;
    this.now = now;
    this.provider = provider;
    this.staleTtlMs = Math.max(staleTtlMs, cacheTtlMs);
    this.cache = new Map();
    this.inFlight = new Map();
  }

  async getWeather(coordinates) {
    const now = this.clockMs();
    const key = typeof this.provider.getCacheKey === 'function'
      ? this.provider.getCacheKey(coordinates)
      : `coordinates:${Number(coordinates.lat).toFixed(3)}:${Number(coordinates.lon).toFixed(3)}`;
    const cached = this.cache.get(key);
    if (cached && cached.freshUntil > now) {
      return this.withCacheState(cached, { cached: true, stale: false });
    }
    if (this.inFlight.has(key)) return this.inFlight.get(key);

    const operation = this.refresh(key, coordinates, cached, now);
    this.inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      this.inFlight.delete(key);
    }
  }

  async refresh(key, coordinates, cached, now) {
    try {
      const data = await this.provider.getWeather(coordinates, { now: new Date(now) });
      const stored = {
        data,
        freshUntil: now + this.cacheTtlMs,
        staleUntil: now + this.staleTtlMs,
      };
      this.cache.set(key, stored);
      this.prune(now);
      return this.withCacheState(stored, { cached: false, stale: false });
    } catch (error) {
      if (cached && cached.staleUntil > now && error?.code !== 'WEATHER_NOT_CONFIGURED' && error?.code !== 'WEATHER_UNSUPPORTED_LOCATION') {
        console.warn('[weather] serving stale KMA weather after provider failure', error?.code ?? error?.message);
        return this.withCacheState(cached, { cached: true, stale: true });
      }
      throw error;
    }
  }

  withCacheState(stored, { cached, stale }) {
    return {
      ...stored.data,
      cache: {
        cached,
        expiresAt: new Date(stored.freshUntil).toISOString(),
        stale,
      },
    };
  }

  clockMs() {
    const value = this.now();
    const date = validDate(value) ? value : new Date(value);
    if (!validDate(date)) throw new TypeError('A valid clock value is required.');
    return date.getTime();
  }

  prune(now) {
    for (const [key, value] of this.cache.entries()) {
      if (value.staleUntil <= now) this.cache.delete(key);
    }
    while (this.cache.size > this.maxCacheEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) break;
      this.cache.delete(oldestKey);
    }
  }
}

module.exports = {
  KmaWeatherProvider,
  WeatherService,
  getUltraSrtNcstBase,
  getVilageFcstBase,
  kstParts,
  latLonToKmaGrid,
  weatherCondition,
};
