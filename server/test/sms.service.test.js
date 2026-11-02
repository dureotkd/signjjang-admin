const assert = require('node:assert/strict');
const { test } = require('node:test');

const { SmsService } = require('../src/services/sms.service');

test('explicit SMS development mode returns the test code without sending or logging it', async (t) => {
  const logs = [];
  t.mock.method(console, 'info', (...args) => logs.push(args));
  t.mock.method(global, 'fetch', async () => { throw new Error('Development mode must not contact Aligo'); });
  const service = new SmsService({
    aligoApiKey: 'configured-but-unused',
    aligoUserId: 'configured-but-unused',
    aligoSender: '01012345678',
    devMode: true,
    solapiApiKey: 'configured-but-unused',
    solapiApiSecret: 'configured-but-unused',
    solapiSender: '01012345678',
  });
  service.client.send = async () => {
    throw new Error('Solapi must not be called in development mode');
  };

  const result = await service.sendVerificationCode('01098765432', '123456');
  assert.deepEqual(result, { devCode: '123456', providerMessageId: null });
  assert.deepEqual(logs, []);
});

const verificationConfig = {
  aligoApiKey: 'test-aligo-key',
  aligoUserId: 'test-signjjang',
  aligoSender: '01012345678',
  devMode: false,
};
const acceptedVerification = { result_code: 1, success_cnt: 1, error_cnt: 0, msg_id: 123456789 };

test('real verification SMS prefers Aligo and sends one short SMS with the configured expiry', async (t) => {
  let sent;
  const service = new SmsService({
    ...verificationConfig,
    codeTtlSeconds: 120,
    solapiApiKey: 'configured-but-unused',
    solapiApiSecret: 'configured-but-unused',
    solapiSender: '01012345678',
  });
  let solapiCalls = 0;
  service.client.send = async () => { solapiCalls += 1; return { groupId: 'unused' }; };
  t.mock.method(global, 'fetch', async (url, options) => {
    sent = { url, options };
    return Response.json(acceptedVerification);
  });

  const result = await service.sendVerificationCode('01098765432', '123456');
  assert.deepEqual(result, { providerMessageId: '123456789' });
  assert.equal(Object.hasOwn(result, 'devCode'), false);
  assert.equal(solapiCalls, 0);
  assert.equal(sent.url, 'https://apis.aligo.in/send/');
  assert.equal(sent.options.method, 'POST');
  assert.ok(sent.options.body instanceof URLSearchParams);
  assert.ok(sent.options.signal instanceof AbortSignal);
  const form = sent.options.body;
  assert.equal(form.get('key'), verificationConfig.aligoApiKey);
  assert.equal(form.get('user_id'), verificationConfig.aligoUserId);
  assert.equal(form.get('sender'), verificationConfig.aligoSender);
  assert.equal(form.get('receiver'), '01098765432');
  assert.equal(form.get('msg_type'), 'SMS');
  assert.equal(form.get('msg'), '[싸인짱] 인증번호 123456 (2분 이내 입력)');
  assert.ok(Buffer.byteLength(form.get('msg'), 'utf8') <= 90);
  assert.equal(form.has('testmode_yn'), false);
  assert.deepEqual([...form.keys()].sort(), ['key', 'msg', 'msg_type', 'receiver', 'sender', 'user_id']);
});

test('verification SMS defaults to three minutes and handles non-minute TTLs', async (t) => {
  const messages = [];
  t.mock.method(global, 'fetch', async (_url, options) => {
    messages.push(options.body.get('msg'));
    return Response.json({ result_code: '1', success_cnt: '1', error_cnt: '0', msg_id: 'message-id' });
  });
  await new SmsService(verificationConfig).sendVerificationCode('01098765432', '123456');
  await new SmsService({ ...verificationConfig, codeTtlSeconds: 90 }).sendVerificationCode('01098765432', '123456');
  assert.match(messages[0], /3분 이내/);
  assert.match(messages[1], /90초 이내/);
});

test('verification SMS rejects failed, partial, malformed and unconfirmed provider responses', async (t) => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  t.mock.method(console, 'info', (...args) => logs.push(args));
  const cases = [
    { payload: { ...acceptedVerification, result_code: -101, message: 'secret-test-aligo-key' } },
    { payload: { ...acceptedVerification, success_cnt: 0 } },
    { payload: { ...acceptedVerification, success_cnt: 2 } },
    { payload: { ...acceptedVerification, error_cnt: 1 } },
    { payload: { ...acceptedVerification, error_cnt: null } },
    { payload: { ...acceptedVerification, error_cnt: undefined } },
    { payload: { ...acceptedVerification, msg_id: '' } },
    { payload: { ...acceptedVerification, msg_id: ' ' } },
    { payload: { ...acceptedVerification, msg_id: null } },
    { payload: { ...acceptedVerification, msg_id: 0 } },
    { payload: { ...acceptedVerification, msg_id: {} } },
    { payload: null },
    { payload: [] },
    { payload: acceptedVerification, status: 503 },
    { raw: '<html>secret-test-aligo-key</html>' },
  ];
  let nextResponse;
  t.mock.method(global, 'fetch', async () => nextResponse);
  const service = new SmsService(verificationConfig);
  for (const item of cases) {
    nextResponse = item.raw
      ? new Response(item.raw)
      : Response.json(item.payload, { status: item.status ?? 200 });
    await assert.rejects(service.sendVerificationCode('01098765432', '123456'), (error) => {
      assert.equal(error.code, 'SMS_SEND_FAILED');
      assert.equal(error.status, 502);
      assert.doesNotMatch(error.message, /secret-test-aligo-key|123456/);
      return true;
    });
  }
  assert.deepEqual(logs, []);
});

test('verification SMS network errors and the bounded request timeout produce safe errors', async (t) => {
  const service = new SmsService(verificationConfig);
  t.mock.method(global, 'fetch', async () => { throw new Error('secret-test-aligo-key'); });
  await assert.rejects(service.sendVerificationCode('01098765432', '123456'), (error) => {
    assert.equal(error.code, 'SMS_UNAVAILABLE');
    assert.doesNotMatch(error.message, /secret-test-aligo-key|123456/);
    return true;
  });
  const timeoutSignal = AbortSignal.abort(new DOMException('Timeout', 'TimeoutError'));
  let timeoutMs;
  t.mock.method(AbortSignal, 'timeout', (value) => { timeoutMs = value; return timeoutSignal; });
  t.mock.method(global, 'fetch', async (_url, options) => {
    options.signal.throwIfAborted();
    throw new Error('Expected timeout');
  });
  await assert.rejects(service.sendVerificationCode('01098765432', '123456'), { code: 'SMS_UNAVAILABLE' });
  assert.equal(timeoutMs, 10_000);
});

test('verification SMS without any configured provider fails instead of simulating success', async () => {
  await assert.rejects(new SmsService({ devMode: false }).sendVerificationCode('01098765432', '123456'), {
    code: 'SMS_NOT_CONFIGURED', status: 503,
  });
});

test('Solapi remains the real verification fallback when Aligo is not configured', async (t) => {
  const service = new SmsService({
    devMode: false, codeTtlSeconds: 240,
    solapiApiKey: 'test-key', solapiApiSecret: 'test-secret', solapiSender: '01012345678',
  });
  t.mock.method(global, 'fetch', async () => { throw new Error('Aligo must not be contacted'); });
  let request;
  service.client.send = async (input) => { request = input; return { groupInfo: { groupId: 'solapi-message' } }; };
  const result = await service.sendVerificationCode('01098765432', '123456');
  assert.deepEqual(result, { providerMessageId: 'solapi-message' });
  assert.equal(Object.hasOwn(result, 'devCode'), false);
  assert.equal(request.from, '01012345678');
  assert.equal(request.to, '01098765432');
  assert.match(request.text, /4분 이내/);
  for (const response of [null, {}, { groupInfo: { groupId: '' } }]) {
    service.client.send = async () => response;
    await assert.rejects(service.sendVerificationCode('01098765432', '123456'), { code: 'SMS_SEND_FAILED' });
  }
  service.client.send = async () => { throw new Error('secret-solapi-key'); };
  await assert.rejects(service.sendVerificationCode('01098765432', '123456'), (error) => {
    assert.equal(error.code, 'SMS_SEND_FAILED');
    assert.doesNotMatch(error.message, /secret-solapi-key/);
    return true;
  });
});

for (const devMode of [false, true]) {
test(`contract MMS uses Aligo with the captured contract image when verification devMode=${devMode}`, async () => {
  const originalFetch = global.fetch;
  const service = new SmsService({
    aligoApiKey: 'aligo-key',
    aligoSender: '01012345678',
    aligoUserId: 'signjjang',
    devMode,
    solapiApiKey: '',
    solapiApiSecret: '',
    solapiSender: '',
  });
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://apis.aligo.in/send/');
    assert.equal(options.method, 'POST');
    const request = new Request(url, { body: options.body, method: 'POST' });
    const form = await request.formData();
    assert.equal(form.get('key'), 'aligo-key');
    assert.equal(form.get('user_id'), 'signjjang');
    assert.equal(form.get('sender'), '01012345678');
    assert.equal(form.get('receiver'), '01098765432');
    assert.equal(form.get('msg_type'), 'MMS');
    assert.equal(form.get('msg'), '');
    assert.equal(form.has('title'), false);
    assert.deepEqual([...form.keys()].sort(), ['image', 'key', 'msg', 'msg_type', 'receiver', 'sender', 'user_id']);
    assert.equal(form.get('image').type, 'image/png');
    assert.equal(await form.get('image').text(), 'contract-image');
    assert.equal(form.has('testmode_yn'), false);
    return new Response(JSON.stringify({ msg_id: 'aligo-message-1', result_code: 1 }), { status: 200 });
  };

  try {
    const result = await service.sendContractMms({
      contract: {
        endDate: '2026-08-20',
        equipment: '카고크레인',
        fee: 420000,
        orderer: '대한건설',
        siteName: '서울 현장',
        startDate: '2026-08-20',
        type: '건설기계사용확인서',
        vehicleNo: '서울01가1234',
      },
      image: { buffer: Buffer.from('contract-image'), mimetype: 'image/png', originalname: 'contract.png' },
      recipientName: '홍길동',
      recipientPhone: '01098765432',
    });
    assert.deepEqual(result, { providerMessageId: 'aligo-message-1' });
  } finally {
    global.fetch = originalFetch;
  }
});
}

test('contract MMS without Aligo configuration fails instead of reporting a simulated send', async () => {
  for (const devMode of [false, true]) {
    const service = new SmsService({ devMode });
    await assert.rejects(
      service.sendContractMms({ contract: { type: '건설기계사용확인서' } }),
      { code: 'ALIGO_NOT_CONFIGURED', status: 503 },
    );
  }
});

test('document MMS attaches up to three files with the supported Aligo field names', async () => {
  const originalFetch = global.fetch;
  const service = new SmsService({ aligoApiKey: 'test', aligoUserId: 'test', aligoSender: '01012345678' });
  global.fetch = async (_url, options) => {
    const form = await new Request('https://example.test', { method: 'POST', body: options.body }).formData();
    assert.equal(form.get('receiver'), '01098765432');
    assert.equal(form.get('msg_type'), 'MMS');
    assert.match(form.get('msg'), /서류/);
    assert.equal(form.has('image1'), false);
    assert.equal(await form.get('image').text(), 'one');
    assert.equal(await form.get('image2').text(), 'two');
    assert.equal(await form.get('image3').text(), 'three');
    return Response.json({ result_code: 1, msg_id: 'document-message' });
  };
  try {
    assert.deepEqual(await service.sendDocumentMms({
      images: ['one', 'two', 'three'].map((value) => ({ buffer: Buffer.from(value), mimetype: 'image/png', originalname: `${value}.png` })),
      recipientPhone: '01098765432',
    }), { providerMessageId: 'document-message' });
    await assert.rejects(service.sendDocumentMms({ images: [] }), { code: 'DOCUMENT_IMAGES_REQUIRED' });
    await assert.rejects(service.sendDocumentMms({ images: [1, 2, 3, 4] }), { code: 'DOCUMENT_IMAGES_REQUIRED' });
  } finally { global.fetch = originalFetch; }
});
