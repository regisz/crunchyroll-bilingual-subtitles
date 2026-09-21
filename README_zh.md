# Crunchyroll AI 双语字幕扩展

<p align="center">
  <b>面向 Crunchyroll 的高精度 AI 双语字幕 Chrome 扩展</b><br>
  <span>多供应商 LLM、Cue 锚定对齐，以及独立的完整设置页</span>
</p>

<p align="center">
  <a href="README.md"><b>English</b></a>
  &nbsp;·&nbsp;
  <a href="README_hu.md"><b>Magyar (匈牙利语)</b></a>
</p>

---

## 项目简介

**Crunchyroll AI 双语字幕扩展**是一款专为 Crunchyroll 开发的 Chrome 扩展，可在站点严格的 Content Security Policy (CSP) 下提供实时、带上下文的双语字幕。支持多家大语言模型（LLM）服务商，并在需要时回退到 Google 翻译。

翻译按 **cue index** 缓存（并带短上下文），同一句英语在不同场景可得到不同译文；LLM 批量回复在展示前会做 1:1 对齐校验。

---

## 功能特性

- **AI 智能双语字幕**：自定义 LLM 或 Google 翻译，双语同屏显示。
- **多供应商 API 密钥**：可为 OpenAI、Google Gemini、Anthropic Claude、OpenRouter 以及自定义 OpenAI 兼容端点分别保存密钥。
- **在线模型列表**：为已配置的供应商加载可用聊天模型（按供应商显示成功/失败），设置页支持过滤长列表。
- **弹窗 + 完整设置**：工具栏弹窗提供快捷项；完整设置页管理供应商、模型与调试。
- **翻译模式**：官方优先 + AI 兜底、强制 AI、仅官方。
- **流式与推理开关**：可选流式显示翻译；对支持的模型可开启更深推理。
- **Cue-index 缓存 + 预加载窗口**：按 cue 缓存，向前预译数分钟，而不是整集一次性翻译。
- **播放器内样式**：字号、颜色、背景透明度与垂直位置。
- **下载英文字幕**：弹窗中可下载（若该集有英文字幕轨）。
- **调试页**：查看最近一次请求 / 模型目录错误，无需翻 DevTools。
- **32 种目标翻译语言**：含匈牙利语等。
- **界面本地化**：`_locales` 下 16 种浏览器语言；设置页可将界面语言覆盖为 **自动 / 匈牙利语 / 英语**（同时作用于弹窗与调试页）。

---

## 语言能力矩阵

### 支持的目标翻译语言 (32 种)

| 语系 / 地区 | 支持的目标语言 |
| :--- | :--- |
| **东亚语系** | 简体中文 (`zh-CN`)、繁体中文 (`zh-HK`)、日语 (`ja-JP`)、韩语 (`ko-KR`) |
| **欧洲与西方语系** | 英语 (`en-US`)、拉美西班牙语 (`es-419`)、西班牙西班牙语 (`es-ES`)、巴西葡萄牙语 (`pt-BR`)、法语 (`fr-FR`)、德语 (`de-DE`)、意大利语 (`it-IT`)、俄语 (`ru-RU`)、波兰语 (`pl-PL`)、荷兰语 (`nl-NL`)、瑞典语 (`sv-SE`)、芬兰语 (`fi-FI`)、挪威语 (`no-NO`)、丹麦语 (`da-DK`)、捷克语 (`cs-CZ`)、匈牙利语 (`hu-HU`)、罗马尼亚语 (`ro-RO`)、乌克兰语 (`uk-UA`)、希腊语 (`el-GR`) |
| **中东与亚非语系** | 阿拉伯语 (`ar-SA`)、土耳其语 (`tr-TR`)、希伯来语 (`he-IL`)、印地语 (`hi-IN`)、越南语 (`vi-VN`)、泰语 (`th-TH`)、印尼语 (`id-ID`)、马来语 (`ms-MY`)、他加禄语 (`tl-PH`) |

### 支持的界面语言 (16 种)

默认跟随浏览器语言（`_locales`）：

- English (`en`)、匈牙利语 (`hu`)、简体中文 (`zh_CN`)、繁體中文 (`zh_TW`)、日本語 (`ja`)、한국어 (`ko`)
- Español (`es`)、Français (`fr`)、Deutsch (`de`)、Русский (`ru`)、Português - BR (`pt_BR`)
- Tiếng Việt (`vi`)、ไทย (`th`)、Bahasa Indonesia (`id`)、Bahasa Melayu (`ms`)、العربية (`ar`)

在**完整设置页**可将界面语言覆盖为 **自动（浏览器）**、**匈牙利语** 或 **英语**；弹窗与调试页同样生效。

---

## 安装指南

1. 下载或克隆本仓库：
   ```bash
   git clone https://github.com/regisz/crunchyroll-bilingual-subtitles.git
   ```
2. 打开 Chrome，访问 `chrome://extensions/`。
3. 开启右上角的**开发者模式**。
4. 点击**加载已解压的扩展程序**，选择本项目根目录。

---

## 使用与配置说明

1. 使用工具栏**弹窗**做快捷设置，或打开**完整设置**页。
2. 选择**目标翻译语言**（共 32 种）。
3. 选择翻译模式：
   - **官方优先，AI 兜底**
   - **强制 AI 翻译**
   - **仅官方字幕**
4. 选择翻译引擎：Google 免费翻译，或**自定义 LLM**。
5. 自定义 LLM（完整设置）：
   - 为要用的供应商填写 **API 密钥**（OpenAI、Gemini、Claude、OpenRouter、Custom）。
   - **Custom** 时可填写 OpenAI 兼容 API URL。
   - 点击**加载全部模型**，选择模型（列表很长时可用过滤），可选导出列表。
   - 按需调整 batch size、concurrency、reasoning、streaming。
6. 可选：**设置界面语言**（auto / 匈牙利语 / 英语）— 更改后立即保存。
7. 点击**保存**（若 Crunchyroll 标签页已打开请刷新）。出错时可打开**调试**页。

---

## 开源协议

本项目采用 **GNU General Public License v3.0** — 详见 [LICENSE](LICENSE)。

---

## 贡献指南

欢迎提交 Issue 与 Pull Request！
