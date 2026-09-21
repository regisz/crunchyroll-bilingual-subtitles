# Crunchyroll AI Bilingual Subtitles

<p align="center">
  <b>High-Precision AI Bilingual Subtitle Extension for Crunchyroll</b><br>
  <span>Real-time dual subtitles with provider-aware LLMs, cue-anchored alignment, and a dedicated settings UI</span>
</p>

<p align="center">
  <a href="README_hu.md"><b>Magyar dokumentáció</b></a>
  &nbsp;·&nbsp;
  <a href="README_zh.md"><b>中文文档 (Chinese)</b></a>
</p>

---

## Overview

**Crunchyroll AI Bilingual Subtitles** is a Chrome extension that adds real-time, context-aware bilingual subtitles on Crunchyroll. It works around the site’s Content Security Policy (CSP), talks to multiple LLM providers, and can fall back to Google Translate when needed.

Translations are keyed by **cue index** (with short surrounding context), so the same English line can get different translations in different scenes, and LLM batch replies are checked for 1:1 alignment before they are shown.

---

## Features

- **AI bilingual subtitles** — dual-language overlay driven by custom LLMs or Google Translate.
- **Multi-provider API keys** — store keys per provider: OpenAI, Google Gemini, Anthropic Claude, OpenRouter, and custom OpenAI-compatible endpoints.
- **Live model lists** — load chat models from each configured provider (with clear per-provider success/error status); filter a long list in settings.
- **Popup + full settings** — quick controls in the toolbar popup; full provider/model/debug setup on the options page.
- **Translation modes** — official-first with AI fallback, force AI, or official only.
- **Streaming & reasoning toggles** — optional live streaming of translations; optional deeper reasoning for models that support it.
- **Cue-index cache + preload window** — caches by cue, preloads a few minutes ahead instead of the whole episode at once.
- **In-player style controls** — font size, color, background opacity, and vertical position over the video.
- **Download English subtitle** — from the popup, when an English track is available on the episode.
- **Debug page** — inspect the latest request / model-catalog errors without digging through DevTools.
- **32 target languages** — translate into 32 locales (including Hungarian).
- **UI localization** — 16 browser locales in `_locales`, plus an optional **Settings language** override (`auto` / Hungarian / English) for the options, popup, and debug pages.

---

## Language Capabilities

### Target languages (32)

| Region / Family | Languages |
| :--- | :--- |
| **East Asian** | Simplified Chinese (`zh-CN`), Traditional Chinese (`zh-HK`), Japanese (`ja-JP`), Korean (`ko-KR`) |
| **European & Western** | English (`en-US`), Spanish - LA (`es-419`), Spanish - ES (`es-ES`), Portuguese - BR (`pt-BR`), French (`fr-FR`), German (`de-DE`), Italian (`it-IT`), Russian (`ru-RU`), Polish (`pl-PL`), Dutch (`nl-NL`), Swedish (`sv-SE`), Finnish (`fi-FI`), Norwegian (`no-NO`), Danish (`da-DK`), Czech (`cs-CZ`), Hungarian (`hu-HU`), Romanian (`ro-RO`), Ukrainian (`uk-UA`), Greek (`el-GR`) |
| **Middle Eastern & Asian** | Arabic (`ar-SA`), Turkish (`tr-TR`), Hebrew (`he-IL`), Hindi (`hi-IN`), Vietnamese (`vi-VN`), Thai (`th-TH`), Indonesian (`id-ID`), Malay (`ms-MY`), Tagalog (`tl-PH`) |

### UI locales (16)

Bundled under `_locales` (Chrome picks from the browser language by default):

- English (`en`), Hungarian (`hu`), Simplified Chinese (`zh_CN`), Traditional Chinese (`zh_TW`), Japanese (`ja`), Korean (`ko`)
- Spanish (`es`), French (`fr`), German (`de`), Russian (`ru`), Portuguese - BR (`pt_BR`)
- Vietnamese (`vi`), Thai (`th`), Indonesian (`id`), Malay (`ms`), Arabic (`ar`)

On the **full settings** page you can override the UI language to **Auto (browser)**, **Hungarian**, or **English**. That override also applies to the popup and debug page.

---

## Installation

1. Clone or download this repository:
   ```bash
   git clone https://github.com/regisz/crunchyroll-bilingual-subtitles.git
   ```
2. Open Chrome and go to `chrome://extensions/`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this project folder.

---

## Usage & Configuration

1. Open the **toolbar popup** for quick language / mode / engine / model controls, or **Open full settings** for the complete page.
2. Choose **Target language** (subtitle translation language — 32 options).
3. Choose **Translation mode**:
   - **Official First, AI Fallback** — use official subs when present; AI fills gaps.
   - **Force AI Translation** — always translate with AI.
   - **Official Only** — official subs only, no AI.
4. Choose **Translation engine**: Google free translation, or **Custom LLM**.
5. For Custom LLM (full settings):
   - Enter an **API key per provider** you use (OpenAI, Gemini, Claude, OpenRouter, Custom).
   - For **Custom**, set an OpenAI-compatible API URL if needed.
   - Click **Load all models**, pick a model (use the filter if the list is long), optionally export the list.
   - Tune **batch size**, **concurrency**, **reasoning**, and **streaming** as needed.
6. Optionally set **Settings language** (UI only: auto / Hungarian / English). It saves as soon as you change it.
7. Click **Save** (and reload the Crunchyroll tab if it was already open). Use **Open debug** when a provider or translation request fails.

---

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE).

---

## Contributing

Issues and pull requests are welcome.
