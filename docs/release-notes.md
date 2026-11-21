聆序 ListenFlow 首个打包版本。

- macOS Apple Silicon / Intel 与 Windows x64 原生启动程序。
- 真人访谈、候选问题预生成、根据真实 ASR 动态选路。
- 默认女声；支持机器人模拟回归。
- 保存录音、真实模型输入输出、ASR 修订、决策树、时延报告并自动导出 ZIP。
- 发布包内置运行时，API 从本机私有配置读取，不包含密钥或模型权重。

部署前请阅读 [部署教程](https://github.com/SocrAItes/LingXu/blob/main/docs/deployment.md)。需要自行安装 Ollama / 文字模型并配置 MOSS API。

当前为一问一答模式，尚未实现自由打断和重叠说话。应用尚未进行 Apple 公证或 Windows 商业代码签名。CI 进行编译、离线测试和无采集自检；目标 Windows 设备的实际麦克风与扬声器效果需现场验证。
