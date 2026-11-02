const { AppError } = require('../errors');
const { geocodingAddressQuery, normalizeSiteAddress, normalizeSiteCoordinates } = require('../site-location');

class KakaoAddressGeocoder {
  constructor({
    apiKey,
    baseUrl = 'https://dapi.kakao.com/v2/local/search/address.json',
    fetchImpl = globalThis.fetch,
    timeoutMs = 8_000,
  } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.baseUrl = String(baseUrl || '').trim();
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async geocode(address) {
    const originalAddress = normalizeSiteAddress(address);
    const query = geocodingAddressQuery(address);
    if (!query) throw new AppError(422, 'SITE_ADDRESS_REQUIRED', '현장 주소를 먼저 입력해 주세요.');
    if (!this.apiKey) {
      throw new AppError(503, 'SITE_GEOCODER_NOT_CONFIGURED', '현장 주소 위치 변환 설정이 아직 완료되지 않았습니다.');
    }
    if (!this.baseUrl || typeof this.fetchImpl !== 'function') {
      throw new AppError(503, 'SITE_GEOCODER_UNAVAILABLE', '현장 주소 위치를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.');
    }

    const exact = await this.search(query, 'exact');
    const exactDocuments = Array.isArray(exact?.documents) ? exact.documents : [];
    if (exactDocuments.length > 0) return this.toUnambiguousResult(exact, originalAddress);

    // Legacy road/lot addresses often differ slightly from Kakao's canonical
    // spelling. Fall back only when the similar search has exactly one result;
    // a first-match choice from an ambiguous response could attach weather to
    // the wrong construction site.
    const similar = await this.search(query, 'similar');
    return this.toUnambiguousResult(similar, originalAddress);
  }

  async search(query, analyzeType) {
    const url = new URL(this.baseUrl);
    url.searchParams.set('query', query);
    url.searchParams.set('analyze_type', analyzeType);
    url.searchParams.set('size', '2');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    let payload;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          accept: 'application/json',
          authorization: `KakaoAK ${this.apiKey}`,
        },
        signal: controller.signal,
      });
      payload = await response.json();
    } catch {
      throw new AppError(502, 'SITE_GEOCODER_UNAVAILABLE', '현장 주소 위치를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      clearTimeout(timeout);
    }

    if (!response?.ok) {
      throw new AppError(502, 'SITE_GEOCODER_UNAVAILABLE', '현장 주소 위치를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.');
    }

    return payload;
  }

  toUnambiguousResult(payload, originalAddress) {
    const documents = Array.isArray(payload?.documents) ? payload.documents : [];
    const totalCount = Number(payload?.meta?.total_count);
    if (documents.length !== 1 || (Number.isFinite(totalCount) && totalCount !== 1)) return null;

    const document = documents[0];

    const coordinates = normalizeSiteCoordinates({
      siteLatitude: document.y,
      siteLongitude: document.x,
    });
    if (!coordinates) {
      throw new AppError(502, 'SITE_GEOCODER_INVALID_RESPONSE', '현장 주소 위치 정보를 확인할 수 없습니다.');
    }

    return {
      ...coordinates,
      matchedAddress: String(document.address_name || originalAddress),
      provider: 'kakao',
    };
  }
}

module.exports = { KakaoAddressGeocoder };
