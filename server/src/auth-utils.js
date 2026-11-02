const { createHmac, randomBytes, randomInt, timingSafeEqual } = require('node:crypto');

const normalizePhone = (value) => String(value ?? '').replace(/\D/g, '');

const isValidPhone = (value) => /^0\d{9,10}$/.test(value);

const hashSmsCode = (phone, purpose, code, pepper) =>
  createHmac('sha256', pepper)
    .update(`${phone}:${purpose}:${code}`)
    .digest('hex');

const smsCodeMatches = (expectedHash, candidateHash) => {
  const expected = Buffer.from(expectedHash, 'hex');
  const candidate = Buffer.from(candidateHash, 'hex');
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
};

const createSmsCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

const createReferralCode = () => `SJ-${randomBytes(5).toString('hex').toUpperCase()}`;

const maskPhone = (phone) => {
  if (phone.length < 8) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
};

const isValidPassword = (password) => {
  if (password.length < 8 || password.length > 16) return false;
  const categories = [/[A-Za-z]/.test(password), /\d/.test(password), /[^A-Za-z\d]/.test(password)];
  return categories.filter(Boolean).length >= 2;
};

module.exports = {
  createReferralCode,
  createSmsCode,
  hashSmsCode,
  isValidPassword,
  isValidPhone,
  maskPhone,
  normalizePhone,
  smsCodeMatches,
};
