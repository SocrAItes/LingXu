# 聆序 Logo

紫色折带构成抽象的 L 和追问分支。此处采用用户选定的图片生成版本。

- `logo.png`：选定的原始 PNG，保留透明背景。
- `app.icns`：macOS 程序图标，包含 16 至 1024 像素规格。
- `app.ico`：Windows 程序图标，包含 16、24、32、48、64、128、256 像素规格。

程序图标仅做尺寸和格式转换，不重绘标志。`scripts/package.mjs` 会为 macOS 写入 `CFBundleIconFile` 并在签名前放入图标资源，为 Windows 编译器传入 `/win32icon`，把图标嵌进 `LingXu.exe`。

生成方式：内置图片生成工具。最终选定版本的提示词如下。

```text
Use case: logo-brand. Design a refined original app icon for LingXu, a contemporary AI conversation and research product. A single elegant abstract cobalt-blue ribbon glyph on a warm porcelain-white rounded-square tile. The glyph consists of two offset folded strokes that form a subtle letter L and an ascending fork / branching conversation path in negative space. Think sophisticated independent design studio identity, exquisitely balanced, compact geometric silhouette, architectural simplicity, fewer and stronger shapes. Use vivid periwinkle-cobalt (#6557EF) with a restrained lighter lavender plane (#A49BFF); mostly flat color with exceptionally subtle tonal change on a fold only. Mark centered, filling 55-60 percent of tile; generous calm whitespace. White tile fills 88 percent of square canvas, transparent outside its rounded corners. Crisp smooth edges, readable at tiny sizes, premium and graceful, optically balanced asymmetry. ABSOLUTELY NO literal ear, ear outline, microphone, headphones, audio equalizer bars, speech bubbles, robot, brain, infinity sign, network dots, mascot, text, lettering, brand name, border, dark background, 3D extrusion, heavy shadows, noisy textures, reflections, mockup or presentation sheet. One icon only, square high resolution PNG, real transparent outer background.
```
