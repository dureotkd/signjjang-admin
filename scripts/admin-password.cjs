#!/usr/bin/env node

const path = require('node:path');
const readline = require('node:readline');
const { createRequire } = require('node:module');

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    let value = '';
    const previousRawMode = Boolean(process.stdin.isRaw);
    const finish = (error) => {
      process.stdin.off('keypress', onKeypress);
      process.stdin.setRawMode(previousRawMode);
      process.stdin.pause();
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onKeypress = (character, key = {}) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('입력을 취소했습니다.'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace' || key.name === 'delete') {
        value = Array.from(value).slice(0, -1).join('');
      } else if (typeof character === 'string' && !key.ctrl && !key.meta && !/\p{Cc}/u.test(character)) {
        value += character;
      }
    };
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', onKeypress);
    process.stdin.resume();
    process.stderr.write(prompt);
  });
}

async function main() {
  if (process.argv.length > 2) throw new Error('비밀번호는 명령행 인자로 전달하지 마세요. npm run admin:password를 실행하세요.');
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('대화형 터미널에서 npm run admin:password를 실행하세요.');
  }
  let bcrypt;
  try {
    bcrypt = createRequire(path.resolve(__dirname, '../server/package.json'))('bcryptjs');
  } catch {
    throw new Error('먼저 npm --prefix server install을 실행하세요.');
  }

  const password = await readHidden('관리자 비밀번호 (입력 숨김): ');
  if (Array.from(password).length < 1) throw new Error('비밀번호를 입력해 주세요.');
  if (Buffer.byteLength(password, 'utf8') > 72) throw new Error('비밀번호는 UTF-8 기준 72바이트 이하여야 합니다.');
  const confirmation = await readHidden('관리자 비밀번호 확인: ');
  if (password !== confirmation) throw new Error('비밀번호가 일치하지 않습니다.');

  const hash = await bcrypt.hash(password, 12);
  process.stdout.write(`${hash}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
