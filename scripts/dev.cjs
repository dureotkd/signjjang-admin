const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const windows = process.platform === 'win32';
const children = ['server', 'admin'].map((folder) => spawn(windows ? 'npm.cmd' : 'npm', ['run', 'dev'], {
  cwd: path.join(root, folder), stdio: 'inherit', shell: windows,
}));
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.pid && windows) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  process.exitCode = code;
}
children.forEach(child => {
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code || 0); });
});
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
