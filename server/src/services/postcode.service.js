const KAKAO_ADDRESS_SEARCH_URL = 'https://dapi.kakao.com/v2/local/search/address.json';
const KAKAO_POSTCODE_SEARCH_URL = 'https://postcode.map.kakao.com/search';

const decodeHtml = (value = '') => value
  .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
  .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

const parseAttributes = (tag) => {
  const attributes = {};
  for (const match of tag.matchAll(/([\w-]+)="([^"]*)"/g)) {
    attributes[match[1]] = decodeHtml(match[2]);
  }
  return attributes;
};

const parsePostcodeResults = (html) => {
  const results = [];
  const seen = new Set();
  const itemPattern = /<li\b[^>]*class="[^"]*\blist_post_item\b[^"]*"[^>]*>[\s\S]*?<\/li>/gi;

  for (const itemMatch of html.matchAll(itemPattern)) {
    const itemHtml = itemMatch[0];
    const itemTag = itemHtml.match(/^<li\b[^>]*>/i)?.[0] ?? '';
    const item = parseAttributes(itemTag);
    const addresses = [...itemHtml.matchAll(/<span\b[^>]*class="[^"]*\btxt_address\b[^"]*"[^>]*>/gi)]
      .map((match) => parseAttributes(match[0]));
    const road = addresses.find((address) => address['data-addr_type'] === 'R');
    const jibun = addresses.find((address) => address['data-addr_type'] === 'J');
    const itemAddress = item['data-addr'] ?? '';
    const roadAddress = road?.['data-addr']
      ?? (item['data-addr_type'] === 'R' ? itemAddress : '');
    const jibunAddress = jibun?.['data-addr']
      ?? (item['data-addr_type'] === 'J' ? itemAddress : '');
    const buildingName = road?.['data-building_name'] ?? item['data-building_name'] ?? '';
    const zonecode = item['data-zonecode'] ?? '';
    const key = `${roadAddress}|${jibunAddress}`;

    if ((!roadAddress && !jibunAddress) || seen.has(key)) continue;
    seen.add(key);
    results.push({ buildingName, jibunAddress, roadAddress, zonecode });
    if (results.length >= 30) break;
  }

  return results;
};

const mapPostcodeDocuments = (documents = []) => {
  const results = [];
  const seen = new Set();

  for (const document of documents) {
    const roadAddress = String(document?.road_address?.address_name || '');
    const jibunAddress = String(document?.address?.address_name || document?.address_name || '');
    const buildingName = String(document?.road_address?.building_name || '');
    const zonecode = String(document?.road_address?.zone_no || '');
    const key = `${roadAddress}|${jibunAddress}`;

    if ((!roadAddress && !jibunAddress) || seen.has(key)) continue;
    seen.add(key);
    results.push({ buildingName, jibunAddress, roadAddress, zonecode });
  }

  return results;
};

const fetchPublicPostcodes = async (query, { fetchImpl, timeoutMs }) => {
  const url = new URL(KAKAO_POSTCODE_SEARCH_URL);
  const searchParameters = {
    cpage: '1',
    cq: query,
    CWinWidth: '480',
    isgj: 'N',
    isgr: 'N',
    isp: 'N',
    mode: 'transmit',
    origin: 'https://postcode.map.kakao.com',
    region_name: query,
    vt: 'popup',
    zn: 'Y',
  };
  Object.entries(searchParameters).forEach(([key, value]) => url.searchParams.set(key, value));

  const response = await fetchImpl(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'ko-KR,ko;q=0.9',
      'user-agent': 'Mozilla/5.0 SignJjang/1.0',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Kakao postcode request failed: ${response.status}`);
  return parsePostcodeResults(await response.text());
};

const searchPostcodes = async (query, {
  apiKey,
  baseUrl = KAKAO_ADDRESS_SEARCH_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
} = {}) => {
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is not available.');
  if (!String(apiKey || '').trim()) {
    return fetchPublicPostcodes(query, { fetchImpl, timeoutMs });
  }

  const url = new URL(baseUrl);
  url.searchParams.set('query', query);
  url.searchParams.set('analyze_type', 'similar');
  url.searchParams.set('size', '30');

  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
      authorization: `KakaoAK ${String(apiKey).trim()}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Kakao address request failed: ${response.status}`);
  const payload = await response.json();
  return mapPostcodeDocuments(Array.isArray(payload?.documents) ? payload.documents : []);
};

module.exports = {
  mapPostcodeDocuments,
  parsePostcodeResults,
  searchPostcodes,
};
