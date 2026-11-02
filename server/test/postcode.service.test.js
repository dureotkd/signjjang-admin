const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  mapPostcodeDocuments,
  parsePostcodeResults,
  searchPostcodes,
} = require('../src/services/postcode.service');

const documents = [{
  address: { address_name: '경기도 성남시 분당구 백현동 532' },
  address_name: '경기도 성남시 분당구 판교역로 166',
  road_address: {
    address_name: '경기도 성남시 분당구 판교역로 166',
    building_name: '카카오 판교 아지트',
    zone_no: '13529',
  },
}];

test('postcode results include selectable road and jibun addresses', () => {
  assert.deepEqual(mapPostcodeDocuments(documents), [{
    buildingName: '카카오 판교 아지트',
    jibunAddress: '경기도 성남시 분당구 백현동 532',
    roadAddress: '경기도 성남시 분당구 판교역로 166',
    zonecode: '13529',
  }]);
});

test('postcode result mapper removes duplicate addresses', () => {
  assert.equal(mapPostcodeDocuments([...documents, ...documents]).length, 1);
});

test('public postcode fallback parses a road address result', async () => {
  const html = `<li class="list_post_item" data-zonecode="13529" data-addr_type="R"
    data-addr="경기도 성남시 분당구 판교역로 166" data-building_name="카카오 판교 아지트">
    <span class="txt_address" data-addr_type="R"
      data-addr="경기도 성남시 분당구 판교역로 166" data-building_name="카카오 판교 아지트"></span>
    <span class="txt_address" data-addr_type="J"
      data-addr="경기도 성남시 분당구 백현동 532"></span>
  </li>`;

  assert.deepEqual(parsePostcodeResults(html), [{
    buildingName: '카카오 판교 아지트',
    jibunAddress: '경기도 성남시 분당구 백현동 532',
    roadAddress: '경기도 성남시 분당구 판교역로 166',
    zonecode: '13529',
  }]);
});

test('postcode search uses the configured Kakao REST API', async () => {
  let requestedUrl;
  let requestedOptions;
  const results = await searchPostcodes('판교역로 166', {
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      requestedOptions = options;
      return { json: async () => ({ documents }), ok: true, status: 200 };
    },
  });

  assert.equal(requestedUrl.searchParams.get('query'), '판교역로 166');
  assert.equal(requestedUrl.searchParams.get('size'), '30');
  assert.equal(requestedOptions.headers.authorization, 'KakaoAK test-key');
  assert.equal(results[0].zonecode, '13529');
});
