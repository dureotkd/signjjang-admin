const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const jwt = require('jsonwebtoken');

const { createApp } = require('../src/app');
const { AppError } = require('../src/errors');
const { removeUploadedFile, uploadDirectory } = require('../src/upload');

const jwtSecret = 'profile-image-test-secret-that-is-at-least-thirty-two-characters';
const config = { jwt: { secret: jwtSecret } };
const authService = {};
const pool = { async execute() { return [[{ ok: 1 }]]; } };
const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4xQAAAABJRU5ErkJggg==',
  'base64',
);

const accessToken = () => jwt.sign({ type: 'access' }, jwtSecret, { subject: '7' });
const fileExists = async (filePath) => fs.access(filePath).then(() => true).catch(() => false);

const startTestServer = async (t, appService) => {
  const app = createApp({
    appService,
    authService,
    config,
    corsOrigins: [],
    pool,
  });
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1');
    listener.once('error', reject);
    listener.once('listening', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
};

const createProfileService = ({ documents = [], onCreateDocument, profileImageUrl = '' } = {}) => {
  const state = {
    createCalls: 0,
    deletedDocumentIds: [],
    documents: new Map(documents.map((document) => [Number(document.id), document])),
    profileImageUrl,
  };
  let nextDocumentId = Math.max(0, ...state.documents.keys()) + 1;

  return {
    service: {
      async createDocument(_userId, input) {
        state.createCalls += 1;
        if (onCreateDocument) return onCreateDocument(input, state);

        const id = nextDocumentId;
        nextDocumentId += 1;
        state.documents.set(id, {
          file_url: input.fileUrl,
          id: String(id),
          mime_type: input.mimeType,
          original_name: input.originalName,
        });
        return { fileUrl: `/api/documents/${id}/file`, id: String(id) };
      },
      async deleteDocument(_userId, documentId) {
        const id = Number(documentId);
        const document = state.documents.get(id);
        if (!document) throw new AppError(404, 'DOCUMENT_NOT_FOUND', '서류 파일을 찾을 수 없습니다.');
        state.documents.delete(id);
        state.deletedDocumentIds.push(id);
        return document;
      },
      async getDocumentFile(_userId, documentId) {
        const document = state.documents.get(Number(documentId));
        if (!document) throw new AppError(404, 'DOCUMENT_NOT_FOUND', '서류 파일을 찾을 수 없습니다.');
        return document;
      },
      async requireProfile() {
        return { id: '7', profileImageUrl: state.profileImageUrl };
      },
      async updateProfileImage(_userId, imageUrl) {
        state.profileImageUrl = imageUrl;
        return { id: '7', profileImageUrl: imageUrl };
      },
    },
    state,
  };
};

const imageForm = () => {
  const form = new FormData();
  form.append('file', new Blob([tinyPng], { type: 'image/png' }), 'profile.png');
  return form;
};

test('profile upload rejects SVG or PDF content disguised as a raster image before creating a document', async (t) => {
  const { service, state } = createProfileService();
  const baseUrl = await startTestServer(t, service);

  for (const [content, filename] of [['<svg/>', 'profile.jpg'], ['%PDF-1.7', 'profile.png']]) {
    const form = new FormData();
    form.append('file', new Blob([content], { type: filename.endsWith('.jpg') ? 'image/jpeg' : 'image/png' }), filename);

    const response = await fetch(`${baseUrl}/api/me/profile-image`, {
      body: form,
      headers: { authorization: `Bearer ${accessToken()}` },
      method: 'PUT',
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'UNSUPPORTED_PROFILE_IMAGE');
  }

  assert.equal(state.createCalls, 0);
});

test('failed profile document creation removes the staged upload', async (t) => {
  let stagedFileUrl = '';
  const { service } = createProfileService({
    onCreateDocument: async (input) => {
      stagedFileUrl = input.fileUrl;
      throw new AppError(503, 'DOCUMENT_CREATE_FAILED', '문서를 만들 수 없습니다.');
    },
  });
  const baseUrl = await startTestServer(t, service);

  const response = await fetch(`${baseUrl}/api/me/profile-image`, {
    body: imageForm(),
    headers: { authorization: `Bearer ${accessToken()}` },
    method: 'PUT',
  });
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.error.code, 'DOCUMENT_CREATE_FAILED');
  assert.notEqual(stagedFileUrl, '');
  assert.equal(await fileExists(path.join(uploadDirectory, path.basename(stagedFileUrl))), false);
});

test('replacing a profile image removes its prior document record and backing file', async (t) => {
  const oldFilename = `profile-image-test-${randomUUID()}.png`;
  const oldFileUrl = `/uploads/${oldFilename}`;
  const oldFilePath = path.join(uploadDirectory, oldFilename);
  await fs.writeFile(oldFilePath, tinyPng);

  try {
    const { service, state } = createProfileService({
      documents: [{ file_url: oldFileUrl, id: '41', mime_type: 'image/png', original_name: 'old.png' }],
      profileImageUrl: '/api/documents/41/file',
    });
    const baseUrl = await startTestServer(t, service);

    const response = await fetch(`${baseUrl}/api/me/profile-image`, {
      body: imageForm(),
      headers: { authorization: `Bearer ${accessToken()}` },
      method: 'PUT',
    });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(state.deletedDocumentIds.includes(41), true);
    assert.equal(state.documents.has(41), false);
    assert.equal(await fileExists(oldFilePath), false);
    assert.notEqual(body.data.profileImageUrl, '/api/documents/41/file');

    const newDocumentId = Number(body.data.profileImageUrl.match(/^\/api\/documents\/(\d+)\/file$/)[1]);
    const newDocument = state.documents.get(newDocumentId);
    assert.ok(newDocument);
    assert.equal(await fileExists(path.join(uploadDirectory, path.basename(newDocument.file_url))), true);
    await removeUploadedFile(newDocument.file_url);
  } finally {
    await fs.unlink(oldFilePath).catch(() => {});
  }
});

test('the generic document delete endpoint preserves the active profile-image document', async (t) => {
  const { service, state } = createProfileService({
    documents: [{ file_url: '/uploads/active-profile.png', id: '41', mime_type: 'image/png', original_name: 'active.png' }],
    profileImageUrl: '/api/documents/41/file',
  });
  const baseUrl = await startTestServer(t, service);

  const response = await fetch(`${baseUrl}/api/documents/41`, {
    headers: { authorization: `Bearer ${accessToken()}` },
    method: 'DELETE',
  });
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.error.code, 'PROFILE_IMAGE_IN_USE');
  assert.equal(state.deletedDocumentIds.length, 0);
  assert.equal(state.documents.has(41), true);
});

test('uploaded-file cleanup ignores paths outside /uploads', async () => {
  const filename = `profile-image-test-${randomUUID()}.png`;
  const filePath = path.join(uploadDirectory, filename);
  await fs.writeFile(filePath, tinyPng);

  try {
    assert.equal(await removeUploadedFile(`/not-uploads/${filename}`), false);
    assert.equal(await fileExists(filePath), true);
    assert.equal(await removeUploadedFile(`/uploads/../${filename}`), false);
    assert.equal(await fileExists(filePath), true);
    assert.equal(await removeUploadedFile(`/uploads/${filename}`), true);
    assert.equal(await fileExists(filePath), false);
  } finally {
    await fs.unlink(filePath).catch(() => {});
  }
});
