const assert = require('node:assert/strict');
const { test } = require('node:test');

const { AppService } = require('../src/services/app.service');
const { AppRepository } = require('../src/repositories/app.repository');

test('failed SMS does not create a successful delivery', async () => {
  let saved = false;
  const service = new AppService({
    async getContract() { return { id: '11', signatureDone: true, signatureDataUrl: 'data:image/png;base64,c2ln' }; },
    async createContractDelivery() { saved = true; },
  }, {
    async sendContractMms() { throw new Error('provider unavailable'); },
  });
  await assert.rejects(service.createContractDelivery(7, 11, {
    image: { buffer: Buffer.from('image') }, recipientPhone: '01000009999', recipientType: '확인자',
  }), /provider unavailable/);
  assert.equal(saved, false);
});

test('contract list, detail and delivery response expose server-owned SMS history', async () => {
  let sentAt = null;
  const row = { id: 11, user_id: 7, status: 'completed', progress: 'scheduled', fee: 500000,
    start_date: '2026-09-13', updated_at: '2026-09-13T10:00:00Z', type: '건설기계사용확인서',
    payload: JSON.stringify({ smsSentAt: 'forged-client-value', siteAddress: '서울시 중구' }) };
  const repository = new AppRepository({
    async execute(sql, params) {
      if (sql.includes('INSERT INTO contract_deliveries')) {
        assert.equal(params[5], 'sent');
        sentAt = '2026-09-13T11:00:00Z';
        return [{ insertId: 31 }];
      }
      assert.match(sql, /d\.contract_id = contracts\.id/);
      assert.match(sql, /d\.user_id = contracts\.user_id/);
      assert.match(sql, /d\.status = 'sent'/);
      return [[{ ...row, sms_sent_at: sentAt }]];
    },
  });
  assert.equal((await repository.getContract(7, 11)).smsSentAt, null);
  assert.equal((await repository.listContracts(7))[0].smsSentAt, null);
  const delivery = await repository.createContractDelivery(7, 11, {
    recipientPhone: '01000009999', recipientType: '확인자', status: 'sent', providerMessageId: 'simulated-1',
  });
  assert.equal(delivery.contract.smsSentAt, '2026-09-13T11:00:00.000Z');
  assert.equal(delivery.contract.progress, 'scheduled');
  assert.equal((await repository.listContracts(7))[0].smsSentAt, delivery.contract.smsSentAt);
});

test('contract delivery requires an actual written confirmer signature', async () => {
  let smsCalled = false;
  const service = new AppService(
    {
      async getContract() {
        return { id: '11', signatureDataUrl: '', signatureDone: true };
      },
    },
    {
      async sendContractMms() {
        smsCalled = true;
        return { providerMessageId: 'must-not-send' };
      },
    },
  );

  await assert.rejects(
    service.createContractDelivery(7, 11, {
      image: { buffer: Buffer.from('contract-image'), mimetype: 'image/png', originalname: 'contract.png' },
      recipientName: '홍길동',
      recipientPhone: '01098765432',
      recipientType: '확인자',
    }),
    (error) => error?.code === 'CONTRACT_SIGNATURE_REQUIRED' && error?.status === 400,
  );
  assert.equal(smsCalled, false);
});

test('contract delivery preserves a lossless PNG after a written signature', async () => {
  let savedDelivery;
  let sentImage;
  const service = new AppService(
    {
      async createContractDelivery(_userId, _contractId, delivery) {
        savedDelivery = delivery;
        return { id: '31', status: delivery.status };
      },
      async getContract() {
        return {
          id: '11',
          signatureDataUrl: 'data:image/png;base64,c2lnbmF0dXJl',
          signatureDone: true,
        };
      },
    },
    {
      async sendContractMms({ image }) {
        sentImage = image;
        return { providerMessageId: 'aligo-message-1' };
      },
    },
  );
  const image = {
    buffer: Buffer.from('contract-image'),
    mimetype: 'image/png',
    originalname: 'contract.png',
  };

  const result = await service.createContractDelivery(7, 11, {
    image,
    recipientName: '홍길동',
    recipientPhone: '01098765432',
    recipientType: '확인자',
  });

  assert.equal(sentImage, image);
  assert.equal(savedDelivery.status, 'sent');
  assert.equal(savedDelivery.providerMessageId, 'aligo-message-1');
  assert.deepEqual(result, { id: '31', status: 'sent' });
});
