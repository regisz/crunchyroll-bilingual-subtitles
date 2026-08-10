// ==========================================
// background.js - 强力抗错位 ID 锚定 + 自动重传版 + 实时流式(Streaming)支持
// ==========================================

importScripts("models-api.js");

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "translate_batch") {
        handleBatchTranslation(request.lines, request.settings)
            .then(res => sendResponse({ success: true, data: res }))
            .catch(err => {
                console.error("[CR Bilingual Subtitles] Batch translation failed:", err);
                sendResponse({ success: false, error: err.message });
            });
        return true;
    }

    if (request.action === "list_models") {
        listProviderModels(request.provider, request.apiKey, request.apiUrl)
            .then(models => sendResponse({ success: true, models }))
            .catch(err => {
                console.error("[CR Bilingual Subtitles] Model list failed:", err);
                sendResponse({ success: false, error: err.message });
            });
        return true;
    }
});

// ✨ 长连接(Port)流式通道：content script 通过该通道实时接收逐字生成的翻译
chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'translate_stream') return;
    port.onMessage.addListener(async (msg) => {
        if (msg && msg.action === 'translate_stream') {
            try {
                await handleStreamTranslation(msg.lines, msg.settings, port);
            } catch (e) {
                console.error("[CR Bilingual Subtitles] Stream translation crashed:", e);
                port.postMessage({ type: 'done', success: false, error: e.message });
            }
        }
    });
});

// ====================================================
// ✨ 共享工具：构建请求体 / 严格解析 / 流式增量解析
// ====================================================

const LANG_DISPLAY_NAMES = {
    'zh-CN': 'Simplified Chinese',
    'zh-HK': 'Traditional Chinese',
    'en-US': 'English',
    'es-419': 'Latin American Spanish',
    'es-ES': 'Spanish',
    'pt-BR': 'Brazilian Portuguese',
    'fr-FR': 'French',
    'de-DE': 'German',
    'hu-HU': 'Hungarian',
    'it-IT': 'Italian',
    'ru-RU': 'Russian',
    'ar-SA': 'Arabic',
    'vi-VN': 'Vietnamese',
    'th-TH': 'Thai',
    'id-ID': 'Indonesian',
    'ms-MY': 'Malay'
};

function resolveTargetLanguageName(secondLang) {
    if (!secondLang) return 'the target language';
    return LANG_DISPLAY_NAMES[secondLang] || secondLang;
}

function isOpenRouterEndpoint(apiUrl) {
    return typeof apiUrl === 'string' && apiUrl.includes('openrouter.ai');
}

function isAnthropicEndpoint(apiUrl) {
    return typeof apiUrl === 'string' && apiUrl.includes('api.anthropic.com');
}

function isOpenAIEndpoint(apiUrl) {
    return typeof apiUrl === 'string' && apiUrl.includes('api.openai.com');
}

function isGeminiEndpoint(apiUrl) {
    return typeof apiUrl === 'string' && apiUrl.includes('generativelanguage.googleapis.com');
}

function isReasoningStyleModel(aiModel) {
    const m = (aiModel || '').toLowerCase();
    // o-series + gpt-5* often reject temperature / classic max_tokens
    return /(^|\/)o[0-9]/.test(m) || m.includes('gpt-5');
}

function usesMaxCompletionTokens(aiModel) {
    const m = (aiModel || '').toLowerCase();
    return /(^|\/)o[0-9]/.test(m) || m.includes('gpt-5');
}

function buildTranslationPayload(lines, settings, tweaks = {}) {
    const { secondLang, aiModel, apiUrl, reasoningEnabled } = settings;
    const reasoningOn = reasoningEnabled === true;
    const model = aiModel || 'gpt-4o-mini';
    const langName = resolveTargetLanguageName(secondLang);
    const omitTemperature = tweaks.omitTemperature === true || isReasoningStyleModel(model);
    const useMaxCompletion = tweaks.useMaxCompletionTokens === true || usesMaxCompletionTokens(model);

    let effortPrompt = '';
    if (!reasoningOn) {
        effortPrompt = '\n[CRITICAL WARNING]: SKIP ALL REASONING. IMMEDIATELY output the final JSON object.';
    }

    const linesObj = {};
    lines.forEach((line, index) => { linesObj[index] = line; });

    const payload = {
        model,
        messages: [
            {
                role: 'system',
                content: `You are an expert anime subtitle translator. Translate each JSON value into natural spoken ${langName} suitable for on-screen anime subtitles (target locale: ${secondLang}).
CRITICAL RULES:
1. Output ONLY a valid JSON object matching the exact keys (0, 1, 2...) of the input.
2. DO NOT merge or split sentences. Keep a strict 1-to-1 mapping for every key.
3. DO NOT output markdown formatting or \`\`\`json.
4. NO conversational text before or after the JSON.
5. Keep lines short and natural for spoken dialogue; match character tone and emotion.
6. Localize honorifics and cultural references when natural in ${langName}; do not add translator notes.${effortPrompt}`
            },
            { role: 'user', content: JSON.stringify(linesObj) }
        ]
    };

    // Native OpenAI/Gemini/Claude reject unknown fields — only send widely supported params
    if (!omitTemperature) payload.temperature = 0.2;

    if (useMaxCompletion) payload.max_completion_tokens = 4096;
    else payload.max_tokens = 4096;

    // OpenRouter-only extras
    if (isOpenRouterEndpoint(apiUrl) && !reasoningOn && !isReasoningStyleModel(model)) {
        payload.reasoning = { enabled: false };
    }

    // OpenAI reasoning models: optional effort (never send OpenRouter `reasoning` object)
    if (isOpenAIEndpoint(apiUrl) && isReasoningStyleModel(model) && /(^|\/)o[0-9]/.test(model.toLowerCase())) {
        payload.reasoning_effort = reasoningOn ? 'medium' : 'low';
    }

    return payload;
}

function buildRequestHeaders(apiKey, apiUrl) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    // OpenRouter ranking headers only — native APIs can be picky about extras
    if (isOpenRouterEndpoint(apiUrl)) {
        headers['HTTP-Referer'] = 'https://www.crunchyroll.com';
        headers['X-Title'] = 'CR Dual Subs Plugin';
    }
    if (isAnthropicEndpoint(apiUrl)) {
        headers['anthropic-version'] = '2023-06-01';
    }
    return headers;
}

function truncateError(text, n = 180) {
    return String(text || '').replace(/\s+/g, ' ').trim().substring(0, n);
}

function payloadTweaksFromHttp400(errorText) {
    const t = (errorText || '').toLowerCase();
    const tweaks = {};
    if (t.includes('unsupported') && t.includes('max_tokens')) {
        tweaks.useMaxCompletionTokens = true;
    }
    if (t.includes('unsupported') && t.includes('max_completion_tokens')) {
        tweaks.useMaxCompletionTokens = false;
    }
    if (t.includes('unsupported') && t.includes('temperature')) {
        tweaks.omitTemperature = true;
    }
    return tweaks;
}

// 严格解析模型最终输出：返回完整对齐的数组，任何 key 缺失/为空则抛错触发重试
function parseModelTranslations(content, lines) {
    const cleaned = content.trim().replace(/```json/gi, '').replace(/```/g, '').trim();
    const translatedArray = new Array(lines.length).fill(chrome.i18n.getMessage("toast_translation_missing") || "[Translation missing]");

    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');

    if (first === -1 || last === -1 || last <= first) {
        throw new Error("Model did not return valid JSON object containing { }");
    }

    const parsedObj = JSON.parse(cleaned.substring(first, last + 1));
    let validKeysCount = 0;

    for (let i = 0; i < lines.length; i++) {
        const translatedLine = parsedObj[i] || parsedObj[String(i)];
        if (translatedLine !== undefined && translatedLine !== null && String(translatedLine).trim() !== "") {
            translatedArray[i] = translatedLine;
            validKeysCount++;
        }
    }

    if (validKeysCount < lines.length) {
        throw new Error(`LLM alignment failed: expected ${lines.length} keys, but only matched ${validKeysCount}`);
    }

    return translatedArray;
}

// ✨ 流式增量解析：模型仍在生成时，也能尽量提取出已完成/进行中的 key-value
// 对于尚未闭合引号的 value，返回截至目前已生成的部分文本（用于实时显示）
function extractPartialTranslations(content, count) {
    const result = {};
    const text = content.replace(/```json/gi, '').replace(/```/g, '');
    const objStart = text.indexOf('{');
    if (objStart === -1) return result;

    const objEnd = text.lastIndexOf('}');
    const sub = objEnd > objStart ? text.slice(objStart, objEnd + 1) : text.slice(objStart);

    for (let i = 0; i < count; i++) {
        const key = `"${i}"`;
        const ki = sub.indexOf(key);
        if (ki === -1) continue;

        let p = ki + key.length;
        while (p < sub.length && sub[p] !== ':') p++;
        if (p >= sub.length) continue;
        p++; // skip ':'
        while (p < sub.length && (sub[p] === ' ' || sub[p] === '\t')) p++;
        if (sub[p] !== '"') continue; // value 还未开始
        p++; // 跳过开头引号

        let val = '';
        while (p < sub.length) {
            const c = sub[p];
            if (c === '\\') {
                val += sub[p] + (sub[p + 1] || '');
                p += 2;
                continue;
            }
            if (c === '"') break; // 引号闭合 -> 该 value 已完成
            val += c;
            p++;
        }
        result[i] = val;
    }
    return result;
}

async function handleBatchTranslation(lines, settings) {
    const { secondLang, transEngine, apiUrl, aiModel, apiKey, reasoningEnabled } = settings;
    const MAX_RETRIES = 3;

    if (transEngine === 'custom_llm' && apiUrl) {
        const headers = buildRequestHeaders(apiKey, apiUrl);
        let tweaks = {};

        let lastError = null;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const payload = buildTranslationPayload(lines, settings, tweaks);
                const res = await fetch(apiUrl, { method: 'POST', headers, body: JSON.stringify(payload) });

                if (!res.ok) {
                    const errorText = await res.text();
                    const status = res.status;

                    if (status === 401 || status === 403 || status === 404 || status === 402) {
                        throw new Error(`Critical error HTTP ${status}: ${truncateError(errorText)}`);
                    }

                    if (status === 400) {
                        const next = payloadTweaksFromHttp400(errorText);
                        tweaks = { ...tweaks, ...next };
                        // gpt-4o-mini / Gemini sometimes still want classic max_tokens; if unclear, try both shapes
                        if (!Object.keys(next).length) {
                            tweaks.omitTemperature = true;
                            tweaks.useMaxCompletionTokens = !tweaks.useMaxCompletionTokens;
                        }
                    }

                    throw new Error(`HTTP ${status}: ${truncateError(errorText)}`);
                }

                const data = await res.json();
                if (!data.choices || !data.choices[0] || !data.choices[0].message) {
                    throw new Error("Interface returned malformed data, missing choices[0].message");
                }

                const content = (data.choices[0].message.content || '').trim();
                const translatedArray = parseModelTranslations(content, lines);
                return translatedArray;

            } catch (e) {
                lastError = e;
                if (e.message.includes('Critical error')) throw e;
                if (attempt === MAX_RETRIES) break;

                let delay = 1000 * attempt;
                if (e.message.includes('429')) delay = 2500 * attempt;

                console.warn(`[CR Bilingual Subtitles] Model request failed or misaligned, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`, e.message);
                await new Promise(r => setTimeout(r, delay));
            }
        }

        throw new Error(`Retried ${MAX_RETRIES} attempts, failed: ${lastError.message}`);

    } else {
        // ====================================================
        // ✨ Google 机翻 自动重试循环
        // ====================================================
        const tl = secondLang === 'zh-HK' ? 'zh-TW' : secondLang.split('-')[0];
        const delimiter = '\n\n|||\n\n'; 
        const joinedText = lines.join(delimiter); 
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&q=${encodeURIComponent(joinedText)}`;
        
        let lastError = null;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const res = await fetch(url);
                if (!res.ok) {
                    if (res.status === 429) throw new Error("429 Too Many Requests");
                    throw new Error(`HTTP ${res.status}`);
                }
                
                const data = await res.json();
                const fullTranslatedText = data[0].map(item => item[0]).join('');
                
                let translatedArray = fullTranslatedText.split(/\n\n\|\|\|\n\n/);
                if (translatedArray.length < lines.length) {
                    translatedArray = fullTranslatedText.split('\n\n'); 
                }
                
                while (translatedArray.length < lines.length) translatedArray.push(chrome.i18n.getMessage("toast_translation_missing") || "[Translation missing]");
                return translatedArray.slice(0, lines.length);

            } catch (e) {
                lastError = e;
                if (attempt === MAX_RETRIES) break;
                
                let delay = 1500 * attempt;
                if (e.message.includes('429')) delay = 3000 * attempt;
                
                console.warn(`[CR Bilingual Subtitles] Google translation failed, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
        
        throw new Error(`Google 机翻重试 ${MAX_RETRIES} 次后失败: ${lastError.message}`);
    }
}

// ====================================================
// ✨ 流式翻译：开启 stream:true，逐 token 解析并实时回传 partial，结束回传 done
// 兼容两种情况：
//   1) 支持 SSE 的端点 -> 解析 data: 行，增量拼出 content
//   2) 不支持 stream 的端点 -> 回退为一次性解析整包 chat completion
// ====================================================
async function handleStreamTranslation(lines, settings, port) {
    const { transEngine, apiUrl, aiModel, apiKey } = settings;

    // 非 custom_llm（如 Google 机翻）无法流式，直接走批量逻辑后回传 done
    if (transEngine !== 'custom_llm' || !apiUrl) {
        try {
            const res = await handleBatchTranslation(lines, settings);
            port.postMessage({ type: 'done', success: true, translations: res });
        } catch (e) {
            port.postMessage({ type: 'done', success: false, error: e.message });
        }
        return;
    }

    const headers = buildRequestHeaders(apiKey, apiUrl);
    const MAX_RETRIES = 3;
    let lastError = null;
    let lastPartialsSig = '';
    let tweaks = {};

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const payload = buildTranslationPayload(lines, settings, tweaks);
            payload.stream = true;
            const res = await fetch(apiUrl, { method: 'POST', headers, body: JSON.stringify(payload) });

            if (!res.ok) {
                const errorText = await res.text();
                const status = res.status;
                if (status === 401 || status === 403 || status === 404 || status === 402) {
                    throw new Error(`Critical error HTTP ${status}: ${truncateError(errorText)}`);
                }
                if (status === 400) {
                    const next = payloadTweaksFromHttp400(errorText);
                    tweaks = { ...tweaks, ...next };
                    if (!Object.keys(next).length) {
                        tweaks.omitTemperature = true;
                        tweaks.useMaxCompletionTokens = !tweaks.useMaxCompletionTokens;
                    }
                }
                throw new Error(`HTTP ${status}: ${truncateError(errorText)}`);
            }

            if (!res.body || !res.body.getReader) {
                throw new Error("Endpoint does not support streaming response body");
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let rawBody = '';
            let fullContent = '';    // SSE content 增量（最终答案）
            let fullReasoning = '';  // SSE reasoning / reasoning_content 增量（部分模型把答案放在这里）
            let gotSSE = false;      // 是否真的收到了 SSE data: 增量
            let streamDone = false;

            const streamedText = () => fullContent + fullReasoning;

            while (true) {
                const { done, value } = await reader.read();
                if (done) { streamDone = true; break; }
                const chunkStr = decoder.decode(value, { stream: true });
                buffer += chunkStr;
                rawBody += chunkStr;

                let nl;
                while ((nl = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, nl).trim();
                    buffer = buffer.slice(nl + 1);
                    if (!line) continue;

                    if (line.startsWith('data:')) {
                        const data = line.slice(5).trim();
                        if (data === '[DONE]') { streamDone = true; break; }
                        try {
                            const json = JSON.parse(data);
                            const choice = (json.choices && json.choices[0]) || {};
                            const deltaObj = choice.delta || {};
                            const contentDelta = deltaObj.content || (choice.message && choice.message.content) || '';
                            const reasoningDelta = deltaObj.reasoning || deltaObj.reasoning_content || '';
                            if (contentDelta) { gotSSE = true; fullContent += contentDelta; }
                            if (reasoningDelta) { gotSSE = true; fullReasoning += reasoningDelta; }
                            if (contentDelta || reasoningDelta) {
                                const partial = extractPartialTranslations(streamedText(), lines.length);
                                const sig = JSON.stringify(partial);
                                if (sig !== lastPartialsSig) {
                                    lastPartialsSig = sig;
                                    port.postMessage({ type: 'partial', translations: partial });
                                }
                            }
                        } catch (e) {
                            // 忽略非 JSON 的 SSE 控制行（如 : keep-alive）
                        }
                    }
                }
                if (streamDone) break;
            }

            // 若端点忽略了 stream:true，回退为解析整包 chat completion
            if (!gotSSE) {
                try {
                    const env = JSON.parse(rawBody);
                    const content = (env.choices && env.choices[0] && env.choices[0].message && env.choices[0].message.content) || '';
                    if (!content) throw new Error('No content in response');
                    fullContent = content;
                } catch (e) {
                    throw new Error('Streaming unsupported and response is not a valid chat completion');
                }
            }

            // 最终解析：优先用 content（更干净），否则回退到 content + reasoning 组合
            // （tencent/hy3 等模型把答案塞进 reasoning 字段，content 为空）
            let translatedArray = null;
            if (fullContent) {
                try { translatedArray = parseModelTranslations(fullContent, lines); } catch (e) { translatedArray = null; }
            }
            if (!translatedArray) {
                translatedArray = parseModelTranslations(streamedText(), lines);
            }
            port.postMessage({ type: 'done', success: true, translations: translatedArray });
            return;

        } catch (e) {
            lastError = e;
            if (e.message.includes('Critical error')) {
                port.postMessage({ type: 'done', success: false, error: e.message });
                return;
            }
            if (attempt === MAX_RETRIES) break;

            let delay = 1000 * attempt;
            if (e.message.includes('429')) delay = 2500 * attempt;

            console.warn(`[CR Bilingual Subtitles] Stream request failed or misaligned, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`, e.message);
            await new Promise(r => setTimeout(r, delay));
        }
    }

    port.postMessage({ type: 'done', success: false, error: `Retried ${MAX_RETRIES} attempts, failed: ${lastError ? lastError.message : 'unknown'}` });
}