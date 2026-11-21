# 部署教程

## 先准备什么

| 项目 | 要求 |
| --- | --- |
| macOS | 发布包分别提供 Apple Silicon arm64 / Intel x64，建议 macOS 15+ |
| Windows | Windows 10 / 11 x64；使用系统默认麦克风与播放设备 |
| 文字模型 | 默认 Ollama + `qwen3:8b`；也可使用 OpenAI 兼容的 Qwen 服务 |
| 语音服务 | 有效的 MOSS API Key，能访问 MOSS-Live 与 MOSS TTS |
| 音频设备 | 麦克风与耳机，启动前选好系统默认设备 |

本地 8B 模型建议使用至少 16GB 内存的电脑并保留模型下载空间；实际速度取决于量化、GPU 和上下文。设备较慢时可更换小参数模型或连接服务器，生成质量和等待时间需要重新评估。

发布包内置程序运行时，不包含 Ollama 或 Qwen 权重。仅用本地文字模型不代表整条语音链路离线运行。

## macOS 下载版

### 1. 下载并放置程序

从 [Releases](https://github.com/SocrAItes/LingXu/releases/latest) 下载 `LingXu-macos-arm64.zip`（M 系列芯片）或 `LingXu-macos-x64.zip`（Intel），解压后将 `LingXu.app` 放到“应用程序”。建议使用本机 APFS 磁盘。

当前发行包为本地 ad-hoc 签名，尚未 Apple 公证。系统可能提示无法验证开发者；确认来源后按 macOS“隐私与安全性”中的提示处理。也可以按下方教程从源码运行。不要关闭系统安全保护。

### 2. 准备文字模型

安装 [Ollama for macOS](https://ollama.com/download/mac)，打开 Ollama，然后在“终端”运行：

```bash
ollama pull qwen3:8b
```

下载完成后保持 Ollama 运行。首次加载模型通常比后续推理慢。

### 3. 创建本机私有配置

在终端运行：

```bash
"/Applications/LingXu.app/Contents/Resources/node" "/Applications/LingXu.app/Contents/Resources/app/scripts/setup.mjs"
open -e "$HOME/Library/Application Support/LingXu/config.env"
```

在文件的 `MOSS_API_KEY` 字段填写自己的密钥并保存，其他字段可保持默认。配置文件位于：

```text
~/Library/Application Support/LingXu/config.env
```

这个文件不在应用包或仓库里面。环境变量优先于私有配置；也可用 `LINGXU_CONFIG` 指向另一个私有配置文件。

### 4. 开始访谈

在系统中设置默认麦克风、耳机，双击 `LingXu.app`，首次提示时允许麦克风权限。程序没有访谈窗口；准备好后会直接播放开场问题。听完后回答，停顿后自动进入下一问；说“结束访谈”结束。

如果没有声音，先查看日志，再运行无采集自检：

```bash
"/Applications/LingXu.app/Contents/Resources/node" "/Applications/LingXu.app/Contents/Resources/app/scripts/human-interview.mjs" --check-audio
```

保存位置：

```text
~/Library/Application Support/LingXu/recordings/会话ID/
~/Library/Application Support/LingXu/recordings/会话ID-导出.zip
~/Library/Application Support/LingXu/logs/
```

## Windows 下载版

### 1. 下载并解压

从 [Releases](https://github.com/SocrAItes/LingXu/releases/latest) 下载 `LingXu-windows-x64.zip`，右键“全部解压”到一个普通本地目录，例如 `D:\LingXu`。保持 `LingXu.exe`、`node.exe`、`app` 文件夹在一起；不要直接在 ZIP 里双击。

当前 EXE 尚未进行商业代码签名。Windows 可能提示来源未知；确认下载来源后再按系统提示运行，或使用源码部署。

### 2. 准备文字模型

安装 [Ollama for Windows](https://ollama.com/download/windows)，启动后在 PowerShell 运行：

```powershell
ollama pull qwen3:8b
```

### 3. 创建本机私有配置

在解压后的目录打开 PowerShell：

```powershell
.\node.exe .\app\scripts\setup.mjs
notepad "$env:LOCALAPPDATA\LingXu\config.env"
```

在文件的 `MOSS_API_KEY` 字段填写自己的密钥并保存。私有配置位于 `%LOCALAPPDATA%\LingXu\config.env`，不需要修改下载包中的代码或示例文件。

### 4. 开始访谈

在 Windows 设置中选择默认麦克风和耳机，并允许桌面应用使用麦克风。双击 `LingXu.exe`，稍候会听到开场问题。程序不会打开网页或控制窗口；听完问题直接回答，说“结束访谈”结束并导出。

无声音时先查看 `%LOCALAPPDATA%\LingXu\logs`；无采集自检命令：

```powershell
.\node.exe .\app\scripts\human-interview.mjs --check-audio
```

保存位置：

```text
%LOCALAPPDATA%\LingXu\recordings\会话ID\
%LOCALAPPDATA%\LingXu\recordings\会话ID-导出.zip
%LOCALAPPDATA%\LingXu\logs\
```

## macOS 源码部署

安装 Node.js 22.16+，并安装 Xcode Command Line Tools：

```bash
xcode-select --install
git clone https://github.com/SocrAItes/LingXu.git
cd LingXu
npm ci
npm run setup
```

按命令输出的路径编辑私有配置，准备好文字模型后：

```bash
npm run check
npm start -- --rounds 8
```

首次运行会编译 Swift 音频桥；后续复用编译结果。终端启动的麦克风权限通常对应终端宿主，应用包启动对应应用本身。

## Windows 源码部署

安装 Node.js 22.16+ 与 Python 3.12 x64。PowerShell 中执行：

```powershell
git clone https://github.com/SocrAItes/LingXu.git
cd LingXu
npm ci
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r native/windows/requirements.txt
.\.venv\Scripts\python.exe -m PyInstaller --noconfirm --clean --onefile --console --name voice-console --distpath .cache --workpath .cache/pyinstaller --specpath .cache --collect-all _sounddevice_data native/windows/audio_bridge.py
npm run setup
```

配置密钥、安装 Ollama 并下载模型后：

```powershell
npm run check
npm start -- --rounds 8
```

音频桥使用 sounddevice / PortAudio 的 WASAPI 共享模式，PCM16 单声道 16kHz；系统执行设备采样率转换。编译后的桥位于 `.cache\voice-console.exe`。

## 使用服务器或已有本地 Qwen

修改**本机** `config.env` 中下面几个字段：

| 字段 | 本机 Ollama | 其他兼容服务 |
| --- | --- | --- |
| `TEXT_MODEL_PROVIDER` | `ollama` | `openai` |
| `TEXT_MODEL_BASE_URL` | `http://127.0.0.1:11434/v1` | 自己的服务地址，通常以 `/v1` 结尾 |
| `TEXT_MODEL` | `qwen3:8b` | 服务 `/models` 返回的实际模型 ID |
| `TEXT_MODEL_API_KEY` | 留空 | 服务要求的密钥 |

Ollama 调用原生 `/api/chat` 并设置 `think:false`；其他服务调用 `/chat/completions` 并传递 `chat_template_kwargs.enable_thinking:false`。兼容服务应支持禁用思考及完整 JSON 输出。私有配置不会启动、下载或修改第三方模型服务。

你的服务器应对客户端可达，并提供 `/models` 健康检查接口；Ollama 会检查模型列表，部分 MLX 服务返回空的 HTTP 200 时由实际推理请求校验模型；不要将未经授权的服务暴露到公网。`MOSS_API_KEY` 和文字模型密钥互不通用。

## 测试与打包

```bash
npm test
npm run audit
npm run package
```

在对应系统构建；不在 macOS 上交叉编译 Windows EXE。Windows 本地打包前需编译音频桥，并将安装了 requirements 的 Python 环境加入当前 PATH；macOS 打包需要 Swift 和系统签名工具。输出到 `dist/`。打包只复制白名单源码、空密钥示例和运行时，不读取私有配置。

GitHub Actions 在 macOS arm64 / Intel 和 Windows x64 runner 上分别测试、编译、自检和打包。推送 `v*` 标签后，全部构建成功才会自动发布三个 ZIP。CI 检查协议、依赖打包及导出逻辑，**不等于真实 Windows 麦克风 / 扬声器已通过听测**；展示前应在目标设备完成一次真人访谈。

## 常见问题

| 现象 | 排查 |
| --- | --- |
| 启动后没有窗口 | 正常，设计为无访谈界面；查看本机 logs 文件夹判断启动进度 |
| 没有开场声音 | 查日志中的私有配置、模型连接或 API 错误；确认输出设备 |
| 提示模型不存在 | 检查 `ollama list` 与 `TEXT_MODEL` 是否一致 |
| 识别不到回答 | 检查系统麦克风权限、默认输入设备；在采访员说完后回答 |
| 讲话停顿时提前追问 | 当前使用语音结束事件与停顿策略；较长思考停顿可能被当成回答结束 |
| 模型校验失败 | 原始请求返回会保留；检查模型是否支持指令和 JSON；小模型需要单独评估 |
| 声音回灌或重复 | 先使用耳机；当前没有完整应用级回声消除 |
| 想换研究主题 | 修改 `TEXT_BRIEF`、采访员人物卡及运行提示词，再重新打包 |

依赖依据：[Ollama 下载](https://ollama.com/download)、[Ollama 思考控制](https://docs.ollama.com/capabilities/thinking)、[Ollama 兼容接口](https://docs.ollama.com/api/openai-compatibility)、[sounddevice WASAPI 设置](https://python-sounddevice.readthedocs.io/en/latest/api/platform-specific-settings.html)。
