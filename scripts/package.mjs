import { mkdir, cp, copyFile, writeFile, chmod, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildNativeAudio } from '../src/native-audio.mjs';
import { archiveFolder } from '../src/archive.mjs';
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!['darwin', 'win32'].includes(process.platform)) throw new Error('请在目标 macOS / Windows 上构建');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json')));
// Use the system temporary directory: macOS app signing requires a native filesystem.
const temporary = await mkdtemp(path.join(os.tmpdir(), 'lingxu-build-'));
const name = `LingXu-${process.platform === 'darwin' ? 'macos' : 'windows'}-${process.arch}`;
const delivery = path.join(temporary, name);
await mkdir(delivery, { recursive: true });
const app = path.join(delivery, 'LingXu.app');
const resources = process.platform === 'darwin' ? path.join(app, 'Contents', 'Resources') : delivery;
const runtime = path.join(resources, 'app');
await mkdir(runtime, { recursive: true });
const filter = source => !path.basename(source).startsWith('._') && path.basename(source) !== '.DS_Store';
for (const directory of ['src', 'scripts', 'roles', 'prompts']) {
  await cp(path.join(root, directory), path.join(runtime, directory), { recursive: true, filter });
}
for (const file of ['package.json', '.env.example']) await copyFile(path.join(root, file), path.join(runtime, file));
await cp(path.join(root, 'node_modules', 'ws'), path.join(runtime, 'node_modules', 'ws'), { recursive: true, dereference: true, filter });
const node = path.join(resources, process.platform === 'darwin' ? 'node' : 'node.exe');
await copyFile(process.execPath, node);
await chmod(node, 0o755);
await mkdir(path.join(runtime, '.cache'), { recursive: true });
const helper = await buildNativeAudio(root);
const bundledHelper = path.join(runtime, '.cache', path.basename(helper));
await copyFile(helper, bundledHelper);
await chmod(bundledHelper, 0o755);
await writeFile(path.join(runtime, '.cache', 'prebuilt'), '1');

const licenseResponse = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`);
if (!licenseResponse.ok) throw new Error('无法获取与内置 Node 版本对应的许可证');
await mkdir(path.join(delivery, 'licenses'), { recursive: true });
await writeFile(path.join(delivery, 'licenses', 'Node.txt'), await licenseResponse.text());
await copyFile(path.join(root, 'node_modules', 'ws', 'LICENSE'), path.join(delivery, 'licenses', 'ws.txt'));

if (process.platform === 'darwin') {
  const contents = path.join(app, 'Contents');
  await mkdir(path.join(contents, 'MacOS'), { recursive: true });
  await writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>ListenFlow</string><key>CFBundleIdentifier</key><string>ai.lingxu.listenflow</string><key>CFBundleName</key><string>聆序 ListenFlow</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>${version}</string><key>CFBundleShortVersionString</key><string>${version}</string><key>LSUIElement</key><true/><key>NSMicrophoneUsageDescription</key><string>使用麦克风进行访谈，并在本机保存录音、识别文本和决策轨迹。</string></dict></plist>`);
  await exec('/usr/bin/swiftc', [path.join(root, 'native', 'AppLauncher.swift'), '-o', path.join(contents, 'MacOS', 'ListenFlow'), '-framework', 'Cocoa', '-module-cache-path', path.join(root, '.cache', 'swift-modules')]);
  await exec('/usr/bin/xattr', ['-cr', app]);
  await exec('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
  await exec('/usr/bin/codesign', ['--verify', '--strict', app]);
} else {
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  await exec(compiler, ['/nologo', '/target:winexe', `/out:${path.join(delivery, 'LingXu.exe')}`, path.join(root, 'native', 'windows', 'Launcher.cs')], { windowsHide: true });
  // PyInstaller bundles the Python runtime; retain dependency license texts too.
  await exec('python', [path.join(root, 'scripts', 'windows-licenses.py'), path.join(delivery, 'licenses')], { windowsHide: true });
}
await copyFile(path.join(root, 'README.md'), path.join(delivery, 'README.md'));
await cp(path.join(root, 'docs'), path.join(delivery, 'docs'), { recursive: true, filter });
await writeFile(path.join(delivery, '使用说明.txt'), '聆序 ListenFlow\n\n先按 docs/deployment.md 配置本机 MOSS API 和文字模型。\n程序内置 Node 运行时，不包含 API 密钥或模型权重。\n双击 LingXu.app / LingXu.exe 启动，无访谈界面。\n听完问题直接回答，说“结束访谈”结束并导出。\n录音和日志位置见部署文档。\n');
// Check the packaged program, with no credentials or device capture.
const check = await exec(node, [path.join(runtime, 'scripts', 'human-interview.mjs'), '--check-audio'], { windowsHide: true });
console.log(check.stdout.trim());
await mkdir(path.join(root, 'dist'), { recursive: true });
const zip = path.join(root, 'dist', `${name}.zip`);
await archiveFolder(delivery, zip);
console.log(`已打包 ${zip}`);
console.log(`构建目录 ${delivery}`);
