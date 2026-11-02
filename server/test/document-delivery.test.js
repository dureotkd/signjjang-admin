const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AppService } = require('../src/services/app.service');
const { AppError } = require('../src/errors');
const { uploadDirectory } = require('../src/upload');

test('document delivery checks ownership before sending, batches files, and reports partial success', async () => {
  const files = [];
  const documents = [];
  const calls = [];
  let failBatch = 0;
  try {
    for (let id = 1; id <= 7; id += 1) {
      const filename = `document-delivery-test-${randomUUID()}.png`;
      const file = path.join(uploadDirectory, filename);
      files.push(file);
      await fs.writeFile(file, `image-${id}`);
      documents.push({ id, file_url: `/uploads/${filename}`, mime_type: 'image/png', original_name: `${id}.png` });
    }
    const repository = {
      async getDocumentFile(userId, id) {
        return userId === 7 ? documents.find((document) => String(document.id) === String(id)) : null;
      },
    };
    const service = new AppService(repository, {
      async sendDocumentMms(payload) {
        calls.push(payload);
        if (calls.length === failBatch) throw new AppError(502, 'ALIGO_SEND_FAILED', '발송 실패');
      },
    });
    await assert.rejects(service.sendDocuments(8, { documentIds: [1], recipientPhone: '01098765432' }), { code: 'DOCUMENT_NOT_FOUND' });
    await assert.rejects(service.sendDocuments(7, { documentIds: [1, 999], recipientPhone: '01098765432' }), { code: 'DOCUMENT_NOT_FOUND' });
    documents[1].mime_type = 'application/pdf';
    await assert.rejects(service.sendDocuments(7, { documentIds: [1, 2], recipientPhone: '01098765432' }), { code: 'DOCUMENT_MMS_FORMAT' });
    documents[1].mime_type = 'image/png';
    assert.equal(calls.length, 0);

    const result = await service.sendDocuments(7, { documentIds: [1, 2, 3, 4, 5, 6, 7], recipientPhone: '01098765432' });
    assert.deepEqual(result, { sentDocumentIds: ['1', '2', '3', '4', '5', '6', '7'], remainingDocumentIds: [] });
    assert.deepEqual(calls.map((call) => call.images.length), [3, 3, 1]);
    assert.equal(calls[0].images[0].buffer.toString(), 'image-1');
    assert.equal(calls[0].recipientPhone, '01098765432');

    calls.length = 0;
    failBatch = 2;
    const partial = await service.sendDocuments(7, { documentIds: [1, 2, 3, 4, 5, 6, 7], recipientPhone: '01098765432' });
    assert.deepEqual(partial.sentDocumentIds, ['1', '2', '3']);
    assert.deepEqual(partial.remainingDocumentIds, ['4', '5', '6', '7']);
    assert.equal(partial.error, '발송 실패');
    assert.equal(calls.length, 2);
  } finally {
    await Promise.all(files.map((file) => fs.unlink(file)));
  }
});
