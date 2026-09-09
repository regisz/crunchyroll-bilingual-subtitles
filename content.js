// ==========================================
// Crunchyroll AI Bilingual Subtitles Pro - content.js
// 包含【防抢占延迟引擎】修复首播崩溃问题
// ==========================================

const FETCH_TIMEOUT_MS = 15000;
const DEFAULT_SETTINGS = {
    secondLang: "hu-HU",
    transMode: "fallback",
    transEngine: "custom_llm",
    aiProvider: "openai",
    apiUrl: "https://api.openai.com/v1/chat/completions",
    aiModel: "gpt-5.6-luna",
    apiKey: "",
    subSize: 26,
    subBottom: 10,
    batchSize: 15,
    concurrency: 2,
    reasoningEnabled: false,
    streaming: true,
    subColor: "",
    subBgOpacity: 65,
    subTop: "auto",
    subLeft: "0",
    subWidth: "100%"
};

// Cue-index keyed caches: same English text can need different translations by scene
const translationByCue = {};
const streamingByCue = {};
const PRELOAD_AHEAD_SEC = 240; // ~4 minutes — avoid translating the whole episode up front
const CONTEXT_LINES = 5;
let consecutiveErrors = 0;

let activeEpisodeSession = {
    id: 1,
    trackUrl: "",
    isCancelled: false
};

function resetSubtitlePipeline() {
    activeEpisodeSession.isCancelled = true;
    activeEpisodeSession = {
        id: Date.now() + Math.random(),
        trackUrl: "",
        isCancelled: false
    };

    Object.keys(translationByCue).forEach((k) => delete translationByCue[k]);
    Object.keys(streamingByCue).forEach((k) => delete streamingByCue[k]);
    consecutiveErrors = 0;

    const textEl = document.getElementById("my-cr-dual-sub-text");
    if (textEl) {
        textEl.innerHTML = "";
        textEl.style.setProperty("display", "none", "important");
    }

    document.querySelectorAll("video").forEach((v) => {
        if (v._dualSubListener) {
            v.removeEventListener("timeupdate", v._dualSubListener);
            delete v._dualSubListener;
        }
    });
}

function logDual(...args) {
    console.log("[CR Bilingual Subtitles]", ...args);
}

function handleSubtitlePayload(detail, via) {
    if (!detail) return;
    let parsed = detail;
    try {
        if (typeof detail === "string") parsed = JSON.parse(detail);
    } catch (e) {
        logDual("payload JSON parse failed via", via, e);
        return;
    }
    if (parsed && !parsed.url && !parsed.data) {
        parsed = { url: "", options: {}, data: { subtitles: parsed } };
    }
    if (!parsed || !parsed.data) {
        logDual("payload missing data via", via);
        return;
    }

    if (parsed.url && parsed.url === lastProcessedUrl) {
        logDual("duplicate playback url ignored");
        return;
    }
    if (parsed.url) lastProcessedUrl = parsed.url;
    latestSubtitleDetail = parsed;

    // New episode / stream: invalidate previous in-flight work and caches
    resetSubtitlePipeline();
    if (parsed.url) lastProcessedUrl = parsed.url;

    logDual("payload received via", via, {
        subs: parsed.data.subtitles ? Object.keys(parsed.data.subtitles) : [],
        caps: parsed.data.captions ? Object.keys(parsed.data.captions) : []
    });

    chrome.storage.local.get(DEFAULT_SETTINGS, (settings) => {
        if (chrome.runtime.lastError) {
            logDual("storage error", chrome.runtime.lastError.message);
            showToast("Storage error: " + chrome.runtime.lastError.message, true);
            return;
        }
        logDual("settings", {
            lang: settings.secondLang,
            mode: settings.transMode,
            engine: settings.transEngine,
            model: settings.aiModel,
            hasKey: !!settings.apiKey
        });
        if (settings.secondLang !== "none") initDualSubs(parsed, settings);
        else removeExistingSubtitles();
    });
}

function readDomBridgePayload() {
    const raw = document.documentElement.getAttribute("data-cr-dual-subs");
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
}

let lastProcessedUrl = "";
let latestSubtitleDetail = null;
logDual("content script ready");

// Instant clear on episode navigation clicks
document.addEventListener("click", (e) => {
    const isEpisodeNav = e.target.closest('[data-testid="next-episode-button"]') ||
        e.target.closest(".erc-prev-next-episode") ||
        e.target.closest('a[href*="/watch/"]') ||
        e.target.closest('[data-t="see-more-episodes-btn"]');
    if (isEpisodeNav) {
        lastProcessedUrl = "";
        resetSubtitlePipeline();
    }
}, true);

let currentPathname = location.pathname;
const checkPathChange = () => {
    if (location.pathname !== currentPathname) {
        currentPathname = location.pathname;
        lastProcessedUrl = "";
        resetSubtitlePipeline();
    }
};
window.addEventListener("popstate", checkPathChange);
window.addEventListener("hashchange", checkPathChange);
setInterval(checkPathChange, 500);

// DOM bridge (attribute is shared across MAIN / isolated worlds)
document.documentElement.addEventListener("cr-dual-subs-ready", () => {
    const payload = readDomBridgePayload();
    if (payload) handleSubtitlePayload(payload, "dom-event");
});

// Poll briefly in case the event fired before listener attach (rare)
(function pollDomBridge() {
    let tries = 0;
    const id = setInterval(() => {
        tries++;
        const payload = readDomBridgePayload();
        if (payload && payload.url && payload.url !== lastProcessedUrl) {
            handleSubtitlePayload(payload, "dom-poll");
        }
        if (tries >= 40) clearInterval(id); // ~20s
    }, 500);
})();

// postMessage backup
window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.source !== "CR_DUAL_SUBS" || data.type !== "CR_SUBTITLE_DATA") return;
    handleSubtitlePayload(data.payload, "postMessage");
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action !== "download_english_subtitle") return;

    const data = latestSubtitleDetail && latestSubtitleDetail.data;
    const englishTrack = data ? findTrackInManifest(data, "en-US", true) : null;
    if (!englishTrack) {
        sendResponse({ success: false, error: chrome.i18n.getMessage("download_english_unavailable") || "English subtitle unavailable" });
        return;
    }

    fetch(englishTrack.url)
        .then((response) => {
            if (!response.ok) throw new Error("Subtitle request failed");
            return response.text();
        })
        .then((subtitleText) => {
            const blob = new Blob([subtitleText], { type: "text/vtt;charset=utf-8" });
            const downloadUrl = URL.createObjectURL(blob);
            const link = document.createElement("a");
            const episodeName = document.title.replace(/[\\/:*?"<>|]/g, "").trim() || "crunchyroll-episode";
            link.href = downloadUrl;
            link.download = `${episodeName}-en-US.vtt`;
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
            sendResponse({ success: true });
        })
        .catch(() => sendResponse({
            success: false,
            error: chrome.i18n.getMessage("download_english_failed") || "English subtitle download failed"
        }));

    return true;
});

function showToast(message, isError = true) {
    let toast = document.getElementById('cr-dual-sub-toast');
    if (toast) toast.remove();
    toast = document.createElement('div');
    toast.id = 'cr-dual-sub-toast';
    toast.style.cssText = `position:absolute; top:20px; left:20px; background:${isError ? 'rgba(220, 53, 69, 0.9)' : 'rgba(40, 167, 69, 0.9)'}; color:white; padding:10px 15px; border-radius:6px; z-index:99999; font-weight:bold; font-family:sans-serif; pointer-events:none; box-shadow:0 4px 6px rgba(0,0,0,0.3); max-width:420px;`;
    toast.innerText = message;
    const container = document.querySelector('.bitmovinplayer-container') || document.body;
    container.appendChild(toast);
    setTimeout(() => { if (toast) toast.remove(); }, 8000);
}

function findTrackInManifest(data, lang, preferCaptions = false) {
    const fuzzyLang = lang.split('-')[0]; 
    const checkSubtitles = () => {
        if (data.subtitles) {
            if (data.subtitles[lang] && data.subtitles[lang].url) return { url: data.subtitles[lang].url, format: data.subtitles[lang].format || 'ass' };
            const subKey = Object.keys(data.subtitles).find(k => k.startsWith(fuzzyLang) && data.subtitles[k].url);
            if (subKey) return { url: data.subtitles[subKey].url, format: data.subtitles[subKey].format || 'ass' };
        }
        return null;
    };
    const checkCaptions = () => {
        if (data.captions) {
            if (data.captions[lang] && data.captions[lang].url) return { url: data.captions[lang].url, format: data.captions[lang].format || 'vtt' };
            const capKey = Object.keys(data.captions).find(k => k.startsWith(fuzzyLang) && data.captions[k].url);
            if (capKey) return { url: data.captions[capKey].url, format: data.captions[capKey].format || 'vtt' };
        }
        return null;
    };
    return preferCaptions ? (checkCaptions() || checkSubtitles()) : (checkSubtitles() || checkCaptions());
}

async function initDualSubs(detail, settings) {
    const { secondLang: targetLang, transMode } = settings;
    const { url, options, data } = detail;
    let targetTrack = null;
    let useAI = false;
    let hasWaitedForCrossTrack = false; // ✨ 记录是否已经为防抢占做过延迟

    const findCrossTrack = async (lang, preferCaptions = false, targetAudioLocale = null) => {
        const versions = data.versions ||[];
        let targetVersion = null;
        
        if (targetAudioLocale === 'original') {
            targetVersion = versions.find(v => v.original === true);
        } else if (targetAudioLocale) {
            targetVersion = versions.find(v => v.audio_locale === targetAudioLocale);
        }
        
        if (!targetVersion) {
            targetVersion = versions.find(v => v.original === true) || versions.find(v => v.audio_locale === 'ja-JP');
        }
        if (!targetVersion || !targetVersion.guid || !url) return null;
        
        const currentGuidMatch = url.match(/\/v3\/([^\/]+)\//);
        if (currentGuidMatch && currentGuidMatch[1] === targetVersion.guid) {
            return findTrackInManifest(data, lang, preferCaptions);
        }

        // ✨ 核心修复：防抢占竞态！如果是首次执行跨轨，强制休眠 2.5 秒，让主视频先稳定加载画面和 Token，避免被顶号
        if (!hasWaitedForCrossTrack) {
            hasWaitedForCrossTrack = true;
            await new Promise(r => setTimeout(r, 2500));
        }

        const newUrl = url.replace(/\/v3\/[^\/]+\//, `/v3/${targetVersion.guid}/`);
        const fetchUrl = newUrl.includes('?') ? newUrl + '&cr_cross_track=1' : newUrl + '?cr_cross_track=1';
        
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
            const safeHeaders = new Headers(options.headers || {});
            
            const res = await fetch(fetchUrl, { headers: safeHeaders, signal: controller.signal });
            clearTimeout(timeout);
            if (!res.ok) return null; 
            
            const originalData = await res.json();

            // 阅后即焚，销毁并发后台 Token
            if (originalData.assetId && originalData.token) {
                const deleteUrl = `https://www.crunchyroll.com/playback/v1/token/${originalData.assetId}/${originalData.token}`;
                fetch(deleteUrl, { method: 'DELETE', headers: safeHeaders }).catch(()=>{});
            }

            return findTrackInManifest(originalData, lang, preferCaptions);
        } catch (e) { return null; }
    };

    if (transMode !== 'force_ai') {
        targetTrack = findTrackInManifest(data, targetLang, false);
        if (!targetTrack) targetTrack = await findCrossTrack(targetLang, false, 'original'); 
        if (!targetTrack) targetTrack = await findCrossTrack(targetLang, false, 'ja-JP');
    }

    if (!targetTrack && (transMode === 'fallback' || transMode === 'force_ai')) {
        useAI = true;
        targetTrack = findTrackInManifest(data, 'en-US', true); 

        if (!targetTrack) targetTrack = await findCrossTrack('en-US', true, 'en-US'); 
        if (!targetTrack) targetTrack = await findCrossTrack('en-US', true, 'original'); 
        if (!targetTrack) targetTrack = await findCrossTrack('en-US', true, 'ja-JP'); 
    }

    if (!targetTrack) {
        showToast(transMode === 'native' ? chrome.i18n.getMessage("toast_no_official_subs") : chrome.i18n.getMessage("toast_parse_failed"));
        return;
    }

    if (targetTrack.url !== activeEpisodeSession.trackUrl) {
        activeEpisodeSession.trackUrl = targetTrack.url;
    }

    try {
        const response = await fetch(targetTrack.url);
        const subText = await response.text();
        let parsedSubs = targetTrack.format === 'vtt' ? parseVTT(subText) : parseASS(subText);
        if (parsedSubs.length === 0) return showToast(chrome.i18n.getMessage("toast_no_dialogue"), true);
        renderSubtitlesOnVideo(parsedSubs, useAI, settings);
        const engineLabel = useAI
            ? (settings.transEngine === "custom_llm" ? (settings.aiModel || "AI") : "Google")
            : "Official";
        const loadedMsg = (chrome.i18n.getMessage("toast_loaded") || "Loaded [ENGINE]!").replace("[ENGINE]", engineLabel);
        showToast(loadedMsg + (useAI && !settings.apiKey && settings.transEngine === "custom_llm" ? " (no API key!)" : ""), useAI && settings.transEngine === "custom_llm" && !settings.apiKey);
        if (useAI && settings.transEngine === "custom_llm" && !settings.apiKey) {
            console.warn("[CR Bilingual Subtitles] AI mode active but API key is empty");
        }
    } catch (e) { showToast(chrome.i18n.getMessage("toast_download_failed")); }
}

function describeTranslationFailure(rawMessage) {
    const msg = String(rawMessage || "").trim();
    const lower = msg.toLowerCase();

    if (!msg) return "A fordítási kérés sikertelen volt. Próbáld meg újra, vagy válassz egy másik modellt.";
    if (lower.includes("api-kulcs") || lower.includes("unauthorized") || lower.includes("forbidden") || lower.includes("401") || lower.includes("403")) {
        return "Az API-kulcs nem működik vagy nem engedélyezett. Ellenőrizd a kulcsot és a provider beállításait. Ha a kulcs jó, érdemes másik modellt próbálni.";
    }
    if (lower.includes("rate limit") || lower.includes("429") || lower.includes("too many requests")) {
        return "A szolgáltató túl sok kérés miatt ideiglenesen elutasította a fordítást. Kérlek várj egy kicsit, vagy próbálj ki egy stabilabb, olcsóbb modellt.";
    }
    if (lower.includes("json") || lower.includes("malformed") || lower.includes("alignment failed") || lower.includes("escaped character")) {
        return "A modell nem adta vissza a várt JSON formátumot. Ez általában a modell válaszának formátumából adódik. Javaslat: próbálj ki egy stabilabb modellt, például OpenAI gpt-4o-mini vagy Gemini 2.5 flash-lite.";
    }
    if (lower.includes("http 400") || lower.includes("unsupported") || lower.includes("temperature") || lower.includes("max_tokens") || lower.includes("max_completion_tokens")) {
        return "A modell nem tudja használni az aktuális paramétereket. Javaslat: válassz egy kompatibilisebb modellt.";
    }
    return "A fordítási modell nem tudott értelmes subtitle JSON-t adni vissza. Javaslat: próbálj ki egy másik modellt.";
}

async function fetchAIBatchTranslation(cues, settings, contextLines = []) {
    const linesArray = cues.map(c => c.text);
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({
            action: "translate_batch",
            lines: linesArray,
            contextLines,
            settings: settings
        }, (response) => {
            if (chrome.runtime.lastError) {
                consecutiveErrors++;
                resolve(linesArray.map(() => chrome.i18n.getMessage("toast_connection_lost")));
                return;
            }
            if (response && response.success) {
                consecutiveErrors = 0;
                response.data.forEach((translated, index) => {
                    const cue = cues[index];
                    if (cue) translationByCue[cue.index] = translated;
                });
                resolve(response.data);
            } else {
                consecutiveErrors++;
                const errDetail = (response && response.error) ? String(response.error) : "";
                showToast(describeTranslationFailure(errDetail), true);
                resolve(linesArray.map(() => chrome.i18n.getMessage("toast_translation_missing")));
            }
        });
    });
}

// ✨ 流式通道：打开长连接到 background，实时接收逐行(partial)与最终(done)翻译
// onPartial(translationsMap) / onDone(data, success, error)
function openTranslationStream(cues, settings, callbacks, contextLines = []) {
    const linesArray = cues.map(c => c.text);
    const { onPartial, onDone } = callbacks;
    const port = chrome.runtime.connect({ name: 'translate_stream' });
    let settled = false;
    const finish = (data, success, error) => {
        if (settled) return;
        settled = true;
        try { port.disconnect(); } catch (e) {}
        if (onDone) onDone(data, success, error);
    };
    port.onMessage.addListener((msg) => {
        if (!msg) return;
        if (msg.type === 'partial') {
            if (onPartial) onPartial(msg.translations || {});
        } else if (msg.type === 'done') {
            finish(msg.translations, msg.success, msg.error);
        }
    });
    port.onDisconnect.addListener(() => finish(null, false, "stream disconnected"));
    port.postMessage({ action: 'translate_stream', lines: linesArray, contextLines, settings });
    return port;
}

function parseVTT(vttText) {
    const lines = vttText.split(/\r?\n/); const result =[]; let i = 0;
    const timeToSeconds = (timeStr) => {
        const parts = timeStr.trim().split(':'); let secs = 0;
        if (parts.length === 3) secs = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
        else if (parts.length === 2) secs = parseInt(parts[0]) * 60 + parseFloat(parts[1]);
        return secs;
    };
    while (i < lines.length) {
        const line = lines[i].trim();
        if (line.includes('-->')) {
            const times = line.split('-->');
            const start = timeToSeconds(times[0]); const end = timeToSeconds(times[1].trim().split(' ')[0]); 
            let text = ""; i++;
            while (i < lines.length && lines[i].trim() !== '') {
                let cleanLine = lines[i].replace(/<[^>]+>/g, '').trim();
                if (cleanLine) text += (text ? '\n' : '') + cleanLine;
                i++;
            }
            if (text) result.push({ start, end, text, index: result.length });
        } else i++;
    }
    return result;
}

function parseASS(assText) {
    const lines = assText.split(/\r?\n/); const result =[];
    const timeToSeconds = (timeStr) => {
        if (!timeStr) return 0; const parts = timeStr.split(':');
        return (parseFloat(parts[0]) || 0) * 3600 + (parseFloat(parts[1]) || 0) * 60 + (parseFloat(parts[2]) || 0);
    };
    for (const line of lines) {
        if (!line.startsWith('Dialogue:')) continue;
        const parts = line.split(','); if (parts.length < 10) continue;
        const cleanText = parts.slice(9).join(',').replace(/\{[^}]+\}/g, '').replace(/\\N/g, '\n').trim();
        if (cleanText) result.push({ start: timeToSeconds(parts[1]), end: timeToSeconds(parts[2]), text: cleanText, index: result.length });
    }
    return result;
}

function renderSubtitlesOnVideo(parsedSubs, useAI, settings) {
    const intervalId = setInterval(() => {
        const video = document.querySelector('video');
        const playerContainer = document.querySelector('.bitmovinplayer-container') || document.getElementById('player-container');
        if (video && playerContainer) {
            clearInterval(intervalId);
            setupContainerAndListen(video, playerContainer, parsedSubs, useAI, settings);
            setupInPlayerControls(playerContainer, settings); 
        }
    }, 1000);
}

function setupInPlayerControls(playerContainer, settings) {
    if (document.getElementById('cr-inplayer-controls-wrapper')) return;
    const wrapper = document.createElement('div');
    wrapper.id = 'cr-inplayer-controls-wrapper';
    wrapper.innerHTML = `
        <div id="cr-inplayer-btn">${chrome.i18n.getMessage("style_adjust_btn") || "⚙️ Style Settings"}</div>
        <div id="cr-inplayer-panel">
            <div class="cr-panel-row">
                <label>${chrome.i18n.getMessage("font_size_label") || "Font Size"} <span id="cr-val-size">${settings.subSize}px</span></label>
                <input type="range" id="cr-range-size" min="14" max="50" value="${settings.subSize}">
            </div>
            <div class="cr-panel-row">
                <label>${chrome.i18n.getMessage("vertical_pos_label") || "Vertical Position"} <span id="cr-val-bottom">${settings.subBottom}%</span></label>
                <input type="range" id="cr-range-bottom" min="0" max="100" value="${settings.subBottom}">
            </div>
            <div class="cr-panel-row" style="display:flex; justify-content:space-between; align-items:center;">
                <label style="margin:0; font-size:13px; color:#ccc;">${chrome.i18n.getMessage("font_color_label") || "Font Color"}</label>
                <input type="color" id="cr-color-picker" value="${settings.subColor || '#ffffff'}">
            </div>
            <div class="cr-panel-row">
                <label>${chrome.i18n.getMessage("bg_opacity_label") || "Background Opacity"} <span id="cr-val-opacity">${settings.subBgOpacity}%</span></label>
                <input type="range" id="cr-range-opacity" min="0" max="100" value="${settings.subBgOpacity}">
            </div>
            <div class="cr-panel-row">
                <button id="cr-reset-pos" style="width:100%; padding:6px; background:#f47521; color:#fff; border:none; border-radius:4px; cursor:pointer; font-weight:bold;">${chrome.i18n.getMessage("reset_style_btn") || "Reset Style & Pos"}</button>
            </div>
        </div>
    `;
    playerContainer.appendChild(wrapper);

    const btn = document.getElementById('cr-inplayer-btn');
    const panel = document.getElementById('cr-inplayer-panel');
    const rangeSize = document.getElementById('cr-range-size');
    const rangeBottom = document.getElementById('cr-range-bottom');
    const valSize = document.getElementById('cr-val-size');
    const valBottom = document.getElementById('cr-val-bottom');
    const colorPicker = document.getElementById('cr-color-picker');
    const rangeOpacity = document.getElementById('cr-range-opacity');
    const valOpacity = document.getElementById('cr-val-opacity');
    const resetBtn = document.getElementById('cr-reset-pos');
    
    const subContainer = document.getElementById('my-cr-dual-sub-container');
    const subText = document.getElementById('my-cr-dual-sub-text');

    if (subContainer) {
        subContainer.style.setProperty('--cr-sub-bottom', settings.subBottom !== 'auto' ? `${settings.subBottom}%` : 'auto');
        subContainer.style.setProperty('--cr-sub-top', settings.subTop);
        subContainer.style.setProperty('--cr-sub-left', settings.subLeft);
        subContainer.style.setProperty('--cr-sub-width', settings.subWidth);
    }
    if (subText) {
        subText.style.setProperty('--cr-sub-size', `${settings.subSize}px`);
        if (settings.subColor) subText.style.setProperty('--cr-sub-color', settings.subColor);
        subText.style.setProperty('--cr-sub-bg', `rgba(0, 0, 0, ${settings.subBgOpacity / 100})`);
    }

    btn.addEventListener('click', () => { panel.style.display = panel.style.display === 'block' ? 'none' : 'block'; });

    rangeSize.addEventListener('input', (e) => {
        const v = e.target.value;
        valSize.innerText = `${v}px`;
        if (subText) subText.style.setProperty('--cr-sub-size', `${v}px`);
        chrome.storage.local.set({ subSize: v });
    });

    rangeBottom.addEventListener('input', (e) => {
        const v = e.target.value;
        valBottom.innerText = `${v}%`;
        if (subContainer) {
            subContainer.style.setProperty('--cr-sub-bottom', `${v}%`);
            subContainer.style.setProperty('--cr-sub-top', 'auto');
            subContainer.style.setProperty('--cr-sub-left', '0');
            subContainer.style.setProperty('--cr-sub-width', '100%');
        }
        chrome.storage.local.set({ subBottom: v, subTop: 'auto', subLeft: '0', subWidth: '100%' });
    });

    colorPicker.addEventListener('input', (e) => {
        const v = e.target.value;
        if (subText) subText.style.setProperty('--cr-sub-color', v);
        chrome.storage.local.set({ subColor: v });
    });

    rangeOpacity.addEventListener('input', (e) => {
        const v = e.target.value;
        valOpacity.innerText = `${v}%`;
        if (subText) subText.style.setProperty('--cr-sub-bg', `rgba(0, 0, 0, ${v / 100})`);
        chrome.storage.local.set({ subBgOpacity: v });
    });

    resetBtn.addEventListener('click', () => {
        chrome.storage.local.set({
            subBottom: 10, subTop: 'auto', subLeft: '0', subWidth: '100%',
            subColor: "", subBgOpacity: 65, subSize: 26
        }, () => {
            rangeBottom.value = 10; valBottom.innerText = '10%';
            rangeSize.value = 26; valSize.innerText = '26px';
            rangeOpacity.value = 65; valOpacity.innerText = '65%';
            colorPicker.value = '#ffffff';
            if (subContainer) {
                subContainer.style.setProperty('--cr-sub-bottom', '10%');
                subContainer.style.setProperty('--cr-sub-top', 'auto');
                subContainer.style.setProperty('--cr-sub-left', '0');
                subContainer.style.setProperty('--cr-sub-width', '100%');
            }
            if (subText) {
                subText.style.setProperty('--cr-sub-size', '26px');
                subText.style.removeProperty('--cr-sub-color'); // Let it fallback to useAI logic
                subText.style.setProperty('--cr-sub-bg', `rgba(0, 0, 0, 0.65)`);
            }
        });
    });
}

function setupContainerAndListen(video, playerContainer, parsedSubs, useAI, settings) {
    let subContainer = document.getElementById('my-cr-dual-sub-container');
    if (!subContainer) {
        subContainer = document.createElement('div');
        subContainer.id = 'my-cr-dual-sub-container';
        playerContainer.appendChild(subContainer);
    }

    let textElement = document.getElementById('my-cr-dual-sub-text');
    if (!textElement) {
        textElement = document.createElement('div');
        textElement.id = 'my-cr-dual-sub-text';
        subContainer.appendChild(textElement);
    }

    if (settings.subColor) {
        textElement.style.setProperty('--cr-sub-color', settings.subColor);
    } else {
        textElement.style.setProperty('--cr-sub-color', useAI ? (settings.transEngine === 'custom_llm' ? '#00FFFF' : '#55FF55') : '#FFFF00');
    }
    
    textElement.style.setProperty('--cr-sub-bg', `rgba(0, 0, 0, ${settings.subBgOpacity / 100})`);
    subContainer.style.setProperty('--cr-sub-top', settings.subTop);
    subContainer.style.setProperty('--cr-sub-left', settings.subLeft);
    subContainer.style.setProperty('--cr-sub-width', settings.subWidth);
    if (settings.subBottom !== 'auto') {
        subContainer.style.setProperty('--cr-sub-bottom', `${settings.subBottom}%`);
    } else {
        subContainer.style.setProperty('--cr-sub-bottom', 'auto');
    }

    makeDraggable(textElement, subContainer, playerContainer);

    if (video._dualSubListener) video.removeEventListener('timeupdate', video._dualSubListener);

    const currentSessionId = activeEpisodeSession.id;

    // Ensure every cue has a stable index (also for older parsed payloads)
    parsedSubs.forEach((sub, i) => {
        if (typeof sub.index !== "number") sub.index = i;
    });

    // ✨ 实时流式开关：仅 custom_llm 引擎支持逐字流式
    const streamingEnabled = useAI && settings.streaming && settings.transEngine === 'custom_llm';

    let currentDisplayedSourceText = "";
    let currentActiveCues = []; // active subtitle cues (index + text)

    const inFlight = new Set(); // cue indexes
    const BATCH_SIZE = settings.batchSize || 15;
    const MAX_CONCURRENCY = settings.concurrency || 2;
    let isPreloading = false;

    const sessionAlive = () => currentSessionId === activeEpisodeSession.id && !activeEpisodeSession.isCancelled;

    const escapeHtml = (s) => String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    const contextBeforeCue = (cueIndex) => {
        const start = Math.max(0, cueIndex - CONTEXT_LINES);
        return parsedSubs.slice(start, cueIndex).map(s => s.text);
    };

    // ✨ 渲染当前正在显示的字幕行：优先用最终译文，其次用流式中的部分译文，未开始则显示省略号占位
    const renderActive = () => {
        if (!sessionAlive()) return;
        if (!currentDisplayedSourceText) {
            textElement.style.setProperty('display', 'none', 'important');
            textElement.innerHTML = '';
            return;
        }
        const cues = currentActiveCues;
        const fmt = (t) => escapeHtml(t).replace(/\n/g, '<br>').replace(/\\n/g, '<br>');
        const parts = cues.map(cue => {
            if (translationByCue[cue.index]) return fmt(translationByCue[cue.index]);
            const sp = streamingByCue[cue.index];
            if (sp != null) return fmt(sp) + '▌';
            return `<span style="color:#888;font-size:16px;">…</span>`;
        });
        textElement.innerHTML = parts.join('<br>');
        textElement.style.setProperty('display', 'inline-block', 'important');
    };

    // chunk = array of { index, text }
    function requestBatch(chunk) {
        if (!sessionAlive()) return Promise.resolve();
        chunk.forEach(c => inFlight.add(c.index));
        const contextLines = chunk.length ? contextBeforeCue(chunk[0].index) : [];

        if (streamingEnabled) {
            return new Promise((resolve) => {
                openTranslationStream(chunk, settings, {
                    onPartial: (tr) => {
                        if (!sessionAlive()) return;
                        const activeIndexes = currentActiveCues.map(c => c.index);
                        let hitsActive = false;
                        Object.keys(tr).forEach(k => {
                            const cue = chunk[Number(k)];
                            if (cue) {
                                streamingByCue[cue.index] = tr[k];
                                if (activeIndexes.includes(cue.index)) hitsActive = true;
                            }
                        });
                        if (hitsActive) renderActive();
                    },
                    onDone: (data, success, error) => {
                        chunk.forEach(c => inFlight.delete(c.index));
                        if (!sessionAlive()) {
                            resolve(data);
                            return;
                        }
                        if (success && data) {
                            consecutiveErrors = 0;
                            data.forEach((t, i) => {
                                const cue = chunk[i];
                                if (cue) {
                                    translationByCue[cue.index] = t;
                                    delete streamingByCue[cue.index];
                                }
                            });
                        } else {
                            consecutiveErrors++;
                            const errDetail = error ? String(error).slice(0, 120) : "";
                            showToast((chrome.i18n.getMessage("toast_api_error") || "API error: ") + errDetail, true);
                            chunk.forEach(c => delete streamingByCue[c.index]);
                        }
                        if (currentDisplayedSourceText) renderActive();
                        resolve(data);
                    }
                }, contextLines);
            });
        }

        return fetchAIBatchTranslation(chunk, settings, contextLines).then(data => {
            chunk.forEach(c => inFlight.delete(c.index));
            if (!sessionAlive()) return data;
            if (currentDisplayedSourceText) renderActive();
            return data;
        }).catch(() => {
            chunk.forEach(c => inFlight.delete(c.index));
        });
    }

    const runContinuousPreload = async () => {
        if (!useAI || isPreloading || !sessionAlive()) return;
        isPreloading = true;

        while (consecutiveErrors <= 3) {
            if (!sessionAlive()) break;
            const v = document.querySelector('video');
            if (!v) break;
            const actualTime = v.currentTime;

            const currentIndex = parsedSubs.findIndex(sub => sub.end >= actualTime);
            if (currentIndex === -1) break;

            const horizon = actualTime + PRELOAD_AHEAD_SEC;
            const futureSubs = parsedSubs
                .slice(currentIndex)
                .filter(s => s.start <= horizon && s.text && translationByCue[s.index] == null && !inFlight.has(s.index));

            if (futureSubs.length === 0) break;

            const targetCues = futureSubs.slice(0, BATCH_SIZE * MAX_CONCURRENCY);
            const chunks = [];
            for (let i = 0; i < targetCues.length; i += BATCH_SIZE) {
                chunks.push(targetCues.slice(i, i + BATCH_SIZE));
            }

            const promises = chunks.map(chunk => requestBatch(chunk));
            await Promise.all(promises);
            if (!sessionAlive()) break;
            await new Promise(r => setTimeout(r, 1000));
        }

        isPreloading = false;
    };

    video._dualSubListener = () => {
        if (!sessionAlive()) return;
        if (settings.secondLang === "none") return;
        const currentTime = video.currentTime;

        if (useAI) runContinuousPreload();

        const activeSubs = parsedSubs.filter(sub => currentTime >= sub.start && currentTime <= sub.end);

        if (activeSubs.length > 0) {
            const cueKey = activeSubs.map(s => s.index).join(",");
            const combinedSourceText = activeSubs.map(s => s.text).join('\n');

            if (currentDisplayedSourceText !== combinedSourceText + "#" + cueKey) {
                currentDisplayedSourceText = combinedSourceText + "#" + cueKey;
                currentActiveCues = activeSubs.map(s => ({ index: s.index, text: s.text }));
                renderActive();

                const needTranslation = currentActiveCues.filter(c => translationByCue[c.index] == null && !inFlight.has(c.index));
                if (useAI && needTranslation.length > 0) {
                    requestBatch(needTranslation);
                }
            }
        } else {
            if (currentDisplayedSourceText !== "") {
                currentDisplayedSourceText = "";
                currentActiveCues = [];
                textElement.style.setProperty('display', 'none', 'important');
                textElement.innerHTML = '';
            }
        }
    };
    video.addEventListener('timeupdate', video._dualSubListener);
}

function removeExistingSubtitles() {
    const c = document.getElementById('my-cr-dual-sub-container');
    const w = document.getElementById('cr-inplayer-controls-wrapper');
    const t = document.getElementById('cr-dual-sub-toast');
    if (c) c.remove();
    if (w) w.remove();
    if (t) t.remove();
}

function makeDraggable(textEl, containerEl, videoContainer) {
    if (textEl._dragInitialized) return;
    textEl._dragInitialized = true;

    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    textEl.addEventListener('mousedown', (e) => {
        isDragging = true;
        
        const rect = containerEl.getBoundingClientRect();
        const parentRect = videoContainer.getBoundingClientRect();
        
        if (containerEl.style.getPropertyValue('--cr-sub-width') === '' || containerEl.style.getPropertyValue('--cr-sub-width') === '100%') {
            containerEl.style.setProperty('--cr-sub-width', 'auto');
            containerEl.style.setProperty('--cr-sub-bottom', 'auto');
            initialLeft = rect.left - parentRect.left;
            initialTop = rect.top - parentRect.top;
            containerEl.style.setProperty('--cr-sub-left', `${initialLeft}px`);
            containerEl.style.setProperty('--cr-sub-top', `${initialTop}px`);
        } else {
            initialLeft = parseFloat(containerEl.style.getPropertyValue('--cr-sub-left')) || (rect.left - parentRect.left);
            initialTop = parseFloat(containerEl.style.getPropertyValue('--cr-sub-top')) || (rect.top - parentRect.top);
        }

        startX = e.clientX;
        startY = e.clientY;
        e.preventDefault(); 
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        
        const newLeft = initialLeft + dx;
        const newTop = initialTop + dy;
        
        containerEl.style.setProperty('--cr-sub-left', `${newLeft}px`);
        containerEl.style.setProperty('--cr-sub-top', `${newTop}px`);
    });

    document.addEventListener('mouseup', (e) => {
        if (!isDragging) return;
        isDragging = false;
        
        const rect = containerEl.getBoundingClientRect();
        const parentRect = videoContainer.getBoundingClientRect();
        
        const leftPct = ((rect.left - parentRect.left) / parentRect.width) * 100;
        const topPct = ((rect.top - parentRect.top) / parentRect.height) * 100;
        
        containerEl.style.setProperty('--cr-sub-left', `${leftPct}%`);
        containerEl.style.setProperty('--cr-sub-top', `${topPct}%`);
        
        chrome.storage.local.set({
            subLeft: `${leftPct}%`,
            subTop: `${topPct}%`,
            subWidth: 'auto',
            subBottom: 'auto'
        });
    });
}
