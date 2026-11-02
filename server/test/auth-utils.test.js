const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  hashSmsCode,
  isValidPassword,
  isValidPhone,
  maskPhone,
  normalizePhone,
  smsCodeMatches,
} = require('../src/auth-utils');

test('phone helpers normalize and mask Korean phone numbers', () => {
  const phone = normalizePhone('010-1234-5678');
  assert.equal(phone, '01012345678');
  assert.equal(isValidPhone(phone), true);
  assert.equal(maskPhone(phone), '010****5678');
});

test('password validation requires two character categories', () => {
  assert.equal(isValidPassword('abcdefgh'), false);
  assert.equal(isValidPassword('abcd1234'), true);
  assert.equal(isValidPassword('Password!'), true);
});

test('SMS hashes compare without storing the original code', () => {
  const expected = hashSmsCode('01012345678', 'signup', '123456', 'x'.repeat(32));
  const same = hashSmsCode('01012345678', 'signup', '123456', 'x'.repeat(32));
  const different = hashSmsCode('01012345678', 'signup', '654321', 'x'.repeat(32));
  assert.equal(smsCodeMatches(expected, same), true);
  assert.equal(smsCodeMatches(expected, different), false);
});
