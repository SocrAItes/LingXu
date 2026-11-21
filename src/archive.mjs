import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function archiveFolder(source, destination) {
  if (process.platform === 'darwin') {
    await exec('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--keepParent', source, destination]);
  } else if (process.platform === 'win32') {
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -LiteralPath $env:LINGXU_ARCHIVE_SOURCE -DestinationPath $env:LINGXU_ARCHIVE_DESTINATION -Force'], {
      windowsHide: true, env: { ...process.env, LINGXU_ARCHIVE_SOURCE: source, LINGXU_ARCHIVE_DESTINATION: destination }, maxBuffer: 1024 * 1024,
    });
  } else throw new Error('当前发布包仅支持 macOS 与 Windows');
}
