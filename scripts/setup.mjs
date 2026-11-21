import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfig } from '../src/config.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
console.log(`私有配置文件：${await createConfig(root)}`);
console.log('在本机编辑 MOSS_API_KEY，然后启动本地 Qwen 模型。已有配置不会覆盖。');
