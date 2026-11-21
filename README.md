# 聆序 · ListenFlow

<img src="assets/branding/logo.png" alt="聆序 LingXu Logo" width="128" />

根据受访者的真实回答，动态选择下一问的语音访谈 Demo。

聆序把提问过程保留为一棵可追溯的问题树：采访员说出问题时，文字模型提前准备多个候选追问；收到真实语音识别结果后，模型检查候选是否适合当前回答，选择已有问题，或现场生成新问题。录音、原始识别事件、模型输入输出、实际走过的路径及阶段时延一起保存在本机。

[下载 macOS / Windows 版本](https://github.com/SocrAItes/LingXu/releases/latest) · [部署教程](docs/deployment.md) · [项目架构](docs/architecture.md) · [导出文件与时延说明](docs/exports.md)

## 可以做什么

- **真人访谈**：双击程序，听完问题直接回答；无网页、无访谈按钮。说“结束访谈”结束并导出。默认最多 8 轮，包含开场征询同意。
- **动态问题树**：提前生成主问题和备选路线；回答发生后再选路，候选失效时重新生成。未走过的分支只保留假设条件，不编造受访者回答。
- **女性采访员**：默认使用 MOSS 女声“暖暖”；提问由 Qwen 规划，MOSS TTS 接收音频后持续排队播放。
- **机器人回归**：另开一个独立 MOSS-Live 会话扮演虚构受访者，默认每轮开口前等待 0.5 秒，用于检查链路。真人模式不使用受访者人物卡。
- **完整记录**：双轨录音、逐轮真正发送给识别服务的音频、ASR 更新与修订、实际模型请求返回、选路证据、树的 JSON / SVG、可观测阶段时延及导出 ZIP。

## 快速开始

### 下载版

1. 从 [Releases](https://github.com/SocrAItes/LingXu/releases/latest) 下载适合电脑的 ZIP 并完整解压。macOS 使用 `LingXu.app`；Windows 使用 `LingXu.exe`。
2. 安装 [Ollama](https://ollama.com/download)，启动服务并在终端运行 `ollama pull qwen3:8b`。
3. 按 [部署教程](docs/deployment.md) 在**本机私有目录**创建 `config.env`，填写自己的 MOSS API Key。程序不会携带任何默认密钥。
4. 设置系统默认麦克风与耳机，启动程序，听完问题后回答。

发布包内置 Node；Windows 还内置音频桥所需的 Python 运行时。模型权重需要自行下载，MOSS 语音服务需要联网。

### 源码运行

需要 Node.js 22.16+、一个可用的 Qwen 服务，以及目标系统的原生音频依赖。

```bash
git clone https://github.com/SocrAItes/LingXu.git
cd LingXu
npm ci
npm run setup
```

编辑命令输出位置的私有配置文件，填写 `MOSS_API_KEY`。安装并启动 Ollama 后：

```bash
ollama pull qwen3:8b
npm run check
npm start
```

macOS 首次源码运行会调用 Swift 编译音频桥，需要 Xcode Command Line Tools。**Windows 源码运行还需先编译音频桥**，命令见 [Windows 源码部署](docs/deployment.md#windows-源码部署)。

## 原理

```text
真人麦克风 → MOSS-Live 真实转写 → Qwen 候选选路 / 重新生成
      ↑                                ↓
      └──── 系统播放 ← MOSS TTS ← 完整校验后的提问

每一轮：原始 ASR → 实际使用的回答 → 候选 / 决策 → 下一问
所有阶段：原始事件、模型请求返回、录音、时延 → 本机导出
```

默认研究主题是“设计 AI 的付费价值与续费决策”。可修改 `src/text-interview.mjs` 的 `TEXT_BRIEF`、`roles/许知.md` 和 `prompts/interviewer-text.txt` 来更换访谈任务。`roles/林舟.md` 只供机器人模拟；真实受访者没有预设回答。

## 运行命令

| 命令 | 用途 |
| --- | --- |
| `npm run setup` | 创建本机私有配置，已有文件不会覆盖 |
| `npm start -- --rounds 8` | 真人访谈，支持 2～12 轮 |
| `npm run check` | 音频协议自检、设备 / 权限状态检查，不采集麦克风 |
| `npm run robot -- --rounds 8` | 两个语音角色模拟；会调用付费 API |
| `npm test` | 离线回归测试，不调用真实模型或语音 API |
| `npm run latency -- "记录目录"` | 从原始事件重算时延报告 |
| `npm run tree:review -- "机器人记录目录"` | 检查机器人运行记录与路径 |
| `npm run package` | 在当前 macOS / Windows 上生成发布 ZIP |
| `npm run audit` | 检查受版本控制的文件是否包含密钥或个人路径 |

## 仓库结构

```text
src/                  访谈控制、问题树、模型调用、语音、时延与导出
scripts/              真人 / 机器人入口、配置、构建与检查
native/               macOS Swift 音频桥与启动器
native/windows/       Windows WASAPI 音频桥与无窗口启动器
assets/branding/      项目 Logo、macOS ICNS 与 Windows ICO
roles/                采访员和模拟受访者人物卡
prompts/              访谈规则
test/                 识别关联、选路、音频及模型客户端回归测试
docs/                 两平台部署、架构、导出说明
.github/workflows/    两平台构建、测试与 Release 发布
```

## 当前边界

当前版本是**先听完问题、再回答的一问一答模式**。底层 MOSS-Live 具有实时语音能力，但应用在采访员播报时不向识别链路提交麦克风音频；尚未实现自由打断、重叠说话、回声消除及取消旧音频队列的完整全双工交互。

预生成候选减少回答后的规划工作量，但选路仍需要模型推理，未命中、候选未就绪或校验失败时会增加等待。这里记录真实时延，不承诺固定响应速度，也不把未暴露的模型内部耗时当成实测。

配置、录音和访谈内容默认留在本机目录；识别 / 合成会向 MOSS 服务发送相应语音或文本。文字模型默认连接本机 Ollama，也可使用自己的兼容服务。公开仓库与发布包不包含密钥、录音、真实访谈记录或模型权重。
