import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
const failures = [];
for (const file of files) {
  if (file.startsWith('data/') || file.startsWith('dist/') || file === '.env' || file.endsWith('config.env')) failures.push(`${file}: private file`);
  const contents = await readFile(path.join(root, file), 'utf8');
  if (/sk-[a-zA-Z0-9]{20,}/.test(contents)) failures.push(`${file}: key-like string`);
  if (/\/(Users|Volumes)\/[A-Za-z\u4e00-\u9fff]/.test(contents)) failures.push(`${file}: personal absolute path`);
  if (/MOSS_API_KEY[ \t]*=[ \t]*[^\s#\r\n]+/.test(contents)) failures.push(`${file}: nonempty key assignment`);
}
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log(`隐私检查通过：${files.length} 个受版本控制的文件；没有配置密钥、个人绝对路径或访谈数据。`);
