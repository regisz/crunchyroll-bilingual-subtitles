// ==========================================
// background.js - 强力抗错位 ID 锚定 + 自动重传版 + 实时流式(Streaming)支持
// ==========================================

importScripts("models-api.js");

function writeDebugLog(entry) {
    chrome.storage.local.set({ lastDebugRequest: entry });
}

function writeDebugCatalog(entry) {
    chrome.storage.local.set({ lastDebugCatalog: entry });
}

function debugMetaFromSettings(settings = {}) {
    return {
        provider: settings.aiProvider || null,
        model: settings.aiModel || null,
        apiUrl: settings.apiUrl || null,
        engine: settings.transEngine || null
    };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "translate_batch") {
        handleBatchTranslation(request.lines, request.settings, request.contextLines || [])
            .then(res => {
                writeDebugLog({
                    type: "translate_batch",
                    success: true,
                    ...debugMetaFromSettings(request.settings),
                    at: new Date().toISOString(),
                    resultCount: Array.isArray(res) ? res.length : 0,
                    lineCount: Array.isArray(request.lines) ? request.lines.length : 0,
                    contextCount: Array.isArray(request.contextLines) ? request.contextLines.length : 0
                });
                sendResponse({ success: true, data: res });
            })
            .catch(err => {
                console.error("[CR Bilingual Subtitles] Batch translation failed:", err);
                writeDebugLog({
                    type: "translate_batch",
                    success: false,
                    ...debugMetaFromSettings(request.settings),
                    at: new Date().toISOString(),
                    error: err.message,
                    lineCount: Array.isArray(request.lines) ? request.lines.length : 0
                });
                sendResponse({ success: false, error: err.message });
            });
        return true;
    }

    if (request.action === "list_models") {
        listProviderModels(request.provider, request.apiKey, request.apiUrl)
            .then(models => {
                writeDebugCatalog({
                    provider: request.provider,
                    models: models.slice(0, 20),
                    totalCount: models.length,
                    loadedAt: new Date().toISOString()
                });
                sendResponse({ success: true, models });
            })
            .catch(err => {
                console.error("[CR Bilingual Subtitles] Model list failed:", err);
                writeDebugCatalog({
                    provider: request.provider,
                    models: [],
                    totalCount: 0,
                    error: err.message,
                    loadedAt: new Date().toISOString()
                });
                sendResponse({ success: false, error: err.message });
            });
        return true;
    }

    if (request.action === "debug_catalog") {
        writeDebugCatalog(request.catalog || {});
        sendResponse({ success: true });
        return false;
    }
});

// ✨ 长连接(Port)流式通道：content script 通过该通道实时接收逐字生成的翻译
chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'translate_stream') return;
    port.onMessage.addListener(async (msg) => {
        if (msg && msg.action === 'translate_stream') {
            const settings = msg.settings || {};
            try {
                await handleStreamTranslation(msg.lines, settings, port, msg.contextLines || []);
            } catch (e) {
                console.error("[CR Bilingual Subtitles] Stream translation crashed:", e);
                writeDebugLog({
                    type: "translate_stream",
                    success: false,
                    ...debugMetaFromSettings(settings),
                    at: new Date().toISOString(),
                    error: e.message,
                    lineCount: Array.isArray(msg.lines) ? msg.lines.length : 0
                });
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

function modelIdLower(aiModel) {
    return String(aiModel || '').toLowerCase();
}

/**
 * Per-family API quirks for subtitle translation.
 * Not Luna-only: OpenAI gpt-5 family / o-series, Gemini thinking, Claude,
 * DeepSeek/Qwen/Grok via OpenRouter, etc.
 */
function getModelCapabilities(aiModel, apiUrl) {
    const m = modelIdLower(aiModel);
    const openAI = isOpenAIEndpoint(apiUrl);
    const openRouter = isOpenRouterEndpoint(apiUrl);
    const gemini = isGeminiEndpoint(apiUrl);
    const anthropic = isAnthropicEndpoint(apiUrl);

    const isOSeries = /(^|\/)o[0-9]/.test(m);
    const isGpt5Family = m.includes('gpt-5');
    const isOpenAIReasoning = isOSeries || isGpt5Family;
    // gpt-5* (incl. luna/nano/sol) usually accept effort "none"; classic o1 often does not
    const supportsReasoningNone = isGpt5Family || /(^|\/)o3/.test(m) || /(^|\/)o4/.test(m);
    const isGeminiFamily = m.includes('gemini') || gemini;
    const isGeminiThinking = isGeminiFamily && /(thinking|2\.5|3\.|flash|pro)/.test(m);
    const isClaude = m.includes('claude') || anthropic;
    const isDeepseekReasoner = /deepseek/.test(m) && /(r1|reasoner)/.test(m);
    const isQwenThinking = /qwen|qwq/.test(m) && /(thinking|qwq|reason)/.test(m);
    const isGrokReasoning = /grok/.test(m);

    const needsReasoningControl = isOpenAIReasoning || isGeminiThinking || isDeepseekReasoner ||
        isQwenThinking || isGrokReasoning || (openRouter && (isClaude || isGeminiFamily));

    return {
        omitTemperature: isOpenAIReasoning || isDeepseekReasoner || isQwenThinking,
        useMaxCompletionTokens: isOpenAIReasoning || (openAI && isGpt5Family),
        // Native OpenAI Chat Completions param
        useOpenAIReasoningEffort: openAI && isOpenAIReasoning,
        supportsReasoningNone,
        // OpenRouter unified reasoning object (maps to provider-native thinking)
        useOpenRouterReasoning: openRouter && needsReasoningControl,
        // Cheap JSON lock-in where the OpenAI-compatible surface accepts it
        useJsonObjectFormat: (openAI || gemini || openRouter) && !anthropic,
        // Subtitle batches are short — avoid burning a 4k completion budget
        outputTokenBudget: 2048,
        needsReasoningControl
    };
}

function isReasoningStyleModel(aiModel) {
    return getModelCapabilities(aiModel, '').omitTemperature ||
        /(^|\/)o[0-9]/.test(modelIdLower(aiModel)) ||
        modelIdLower(aiModel).includes('gpt-5');
}

function usesMaxCompletionTokens(aiModel) {
    return getModelCapabilities(aiModel, 'https://api.openai.com/v1/chat/completions').useMaxCompletionTokens;
}

function buildTranslationPayload(lines, settings, tweaks = {}, contextLines = []) {
    const { secondLang, aiModel, apiUrl, reasoningEnabled } = settings;
    const reasoningOn = reasoningEnabled === true;
    const model = aiModel || 'gpt-5.6-luna';
    const langName = resolveTargetLanguageName(secondLang);
    const caps = getModelCapabilities(model, apiUrl);
    const omitTemperature = tweaks.omitTemperature === true || caps.omitTemperature;
    const useMaxCompletion = tweaks.useMaxCompletionTokens === true ||
        (tweaks.useMaxCompletionTokens !== false && caps.useMaxCompletionTokens);
    const tokenBudget = Math.max(256, Number(tweaks.outputTokenBudget) || caps.outputTokenBudget);

    let effortPrompt = '';
    if (!reasoningOn) {
        effortPrompt = '\n[CRITICAL WARNING]: SKIP ALL REASONING. IMMEDIATELY output the final JSON object.';
    }

    const contextObj = {};
    (contextLines || []).forEach((line, index) => { contextObj[index] = line; });
    const targetObj = {};
    lines.forEach((line, index) => { targetObj[index] = line; });

    const hasContext = Array.isArray(contextLines) && contextLines.length > 0;
    const userPayload = hasContext
        ? {
            context_previous_lines: contextObj,
            translate_these_lines: targetObj,
            instruction: 'CONTEXT lines are previous dialogue for pronouns/tone only. Translate ONLY translate_these_lines. Return JSON with the same numeric keys as translate_these_lines.'
        }
        : targetObj;

    const contextRule = hasContext
        ? `\n9. The user may include context_previous_lines for dialogue continuity. Do NOT translate those. Output keys must match translate_these_lines only.`
        : '';

    const payload = {
        model,
        messages: [
            {
                role: 'system',
                content: `You are an expert anime subtitle translator. Translate each target JSON value into natural spoken ${langName} suitable for on-screen anime subtitles (target locale: ${secondLang}).
STRICT OUTPUT CONTRACT:
1. Return ONLY ONE valid JSON object, with no markdown fences, no commentary, and no explanation text.
2. The JSON root must be an object with exactly the same keys as the lines to translate: 0, 1, 2, ...
3. Every value must be a non-empty string.
4. Keep a strict 1:1 mapping: do not merge, split, omit, reorder, or add extra keys.
5. Use valid JSON escaping only. Do not insert raw newline characters inside string values unless escaped as \\n.
6. Do not wrap the answer in triple backticks, do not say "Here is the JSON", and do not add any text before or after the object.
7. Keep each subtitle short, natural, and spoken; match the character tone and emotion.
8. Localize honorifics and cultural references when natural in ${langName}; do not add translator notes.${contextRule}${effortPrompt}`
            },
            { role: 'user', content: JSON.stringify(userPayload) }
        ]
    };

    // Native OpenAI/Gemini/Claude reject unknown fields — only send widely supported params
    if (!omitTemperature) payload.temperature = 0.2;

    if (useMaxCompletion) payload.max_completion_tokens = tokenBudget;
    else payload.max_tokens = tokenBudget;

    if (tweaks.omitResponseFormat !== true && caps.useJsonObjectFormat) {
        payload.response_format = { type: 'json_object' };
    }

    // OpenAI Chat Completions: reasoning_effort for gpt-5* / o-series (Luna included, not exclusive)
    if (caps.useOpenAIReasoningEffort) {
        if (reasoningOn) {
            payload.reasoning_effort = 'medium';
        } else if (caps.supportsReasoningNone) {
            payload.reasoning_effort = 'none';
        } else {
            payload.reasoning_effort = 'low';
        }
    }

    // OpenRouter: unified reasoning object maps to OpenAI/Anthropic/Gemini/Qwen/etc.
    if (caps.useOpenRouterReasoning) {
        if (reasoningOn) {
            payload.reasoning = { effort: 'medium' };
        } else if (caps.supportsReasoningNone || caps.needsReasoningControl) {
            payload.reasoning = { effort: 'none', exclude: true };
        } else {
            payload.reasoning = { enabled: false, exclude: true };
        }
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

function formatHumanTranslationError(rawError, fallback = 'A fordítási kérés sikertelen volt.') {
    const detail = String(rawError || '').trim();
    const text = detail || fallback;
    const lower = text.toLowerCase();

    if (lower.includes('escaped character') || lower.includes('malformed json') || lower.includes('valid json object') || lower.includes('alignment failed') || lower.includes('could not be repaired')) {
        return `A fordítási modell nem adta vissza a várt JSON formátumot. Ez általában a modell válaszának formátuma miatt történik. Javaslat: próbálj ki egy stabilabb modellt, például OpenAI gpt-4o-mini vagy Gemini 2.5 flash-lite. Részletek: ${truncateError(text, 180)}`;
    }

    if (lower.includes('401') || lower.includes('403') || lower.includes('unauthorized') || lower.includes('forbidden')) {
        return `Az API-kulcs érvénytelen vagy a provider letiltotta a hozzáférést. Ellenőrizd a kulcsot és a provider beállításait. Javaslat: ha a kulcs jó, próbálj ki egy másik modellfajtát. Részletek: ${truncateError(text, 180)}`;
    }

    if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests')) {
        return `A szolgáltató túl sok kérést kapott rövid idő alatt, ezért ideiglenesen elutasította a kérést. Várj egy kicsit, vagy próbálj ki olcsóbb, stabilabb modellt. Részletek: ${truncateError(text, 180)}`;
    }

    if (lower.includes('http 400') || lower.includes('unsupported') || lower.includes('temperature') || lower.includes('max_tokens') || lower.includes('max_completion_tokens')) {
        return `A modell nem fogadja a beállított API-paramétereket. Javaslat: próbálj ki egy kompatibilisebb modellt. Részletek: ${truncateError(text, 180)}`;
    }

    if (lower.includes('critical error')) {
        return `A provider nem fogadja az aktuális beállításokat. Ellenőrizd az API URL-t, a modell nevét és a hozzáférést. Javaslat: ha ez így marad, válassz másik modellre. Részletek: ${truncateError(text, 180)}`;
    }

    return `A fordítási kérés nem tudott értelmes, subtitle-hoz megfelelő JSON választ adni. Javaslat: próbálj ki egy másik modellt. Részletek: ${truncateError(text, 180)}`;
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
    if (t.includes('response_format') || t.includes('json_object') || (t.includes('unsupported') && t.includes('response'))) {
        tweaks.omitResponseFormat = true;
    }
    return tweaks;
}

function decodeEscapedJsonString(rawValue) {
    return String(rawValue || "")
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\r/g, "\r")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
}

function sanitizeModelJsonObject(rawText) {
    const cleaned = String(rawText || "").trim().replace(/```json/gi, "").replace(/```/g, "").trim();
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) return null;

    let candidate = cleaned.substring(first, last + 1);
    candidate = candidate
        .replace(/\\(?!["\\\/bfnrtu])/g, "\\\\")
        .replace(/,\s*([}\]])/g, "$1")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

    let inString = false;
    let escaped = false;
    let repaired = "";
    for (let i = 0; i < candidate.length; i++) {
        const ch = candidate[i];
        if (inString) {
            if (escaped) {
                repaired += ch;
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                repaired += ch;
                escaped = true;
                continue;
            }
            if (ch === '"') {
                inString = false;
                repaired += ch;
                continue;
            }
            if (ch === '\n' || ch === '\r') {
                repaired += "\\n";
                continue;
            }
            repaired += ch;
            continue;
        }

        if (ch === '"') {
            inString = true;
        }
        repaired += ch;
    }

    return repaired;
}

// 严格解析模型最终输出：返回完整对齐的数组，任何 key 缺失/为空则抛错触发重试
function parseModelTranslations(content, lines) {
    const cleaned = String(content || "").trim().replace(/```json/gi, "").replace(/```/g, "").trim();
    const translatedArray = new Array(lines.length).fill(chrome.i18n.getMessage("toast_translation_missing") || "[Translation missing]");

    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');

    if (first === -1 || last === -1 || last <= first) {
        throw new Error("Model did not return valid JSON object containing { }");
    }

    const rawJson = cleaned.substring(first, last + 1);
    let parsedObj = null;

    try {
        parsedObj = JSON.parse(rawJson);
    } catch (e) {
        try {
            const repaired = sanitizeModelJsonObject(rawJson);
            if (repaired) parsedObj = JSON.parse(repaired);
        } catch (repairErr) {
            // fall through to best-effort extraction below
        }
    }

    if (!parsedObj) {
        const fallbackPattern = /"(\d+)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
        const fallbackObj = {};
        let match;
        while ((match = fallbackPattern.exec(rawJson)) !== null) {
            fallbackObj[match[1]] = decodeEscapedJsonString(match[2]);
        }

        if (Object.keys(fallbackObj).length) {
            parsedObj = fallbackObj;
        }
    }

    if (!parsedObj) {
        throw new Error("Model returned malformed JSON that could not be repaired");
    }

    let validKeysCount = 0;

    for (let i = 0; i < lines.length; i++) {
        const translatedLine = parsedObj[i] || parsedObj[String(i)];
        if (translatedLine !== undefined && translatedLine !== null && String(translatedLine).trim() !== "") {
            translatedArray[i] = translatedLine;
            validKeysCount++;
        }
    }

    if (validKeysCount === 0) {
        throw new Error(`LLM alignment failed: expected ${lines.length} keys, but only matched ${validKeysCount}`);
    }

    if (validKeysCount < lines.length) {
        console.warn(`[CR Bilingual Subtitles] Partial model output: expected ${lines.length} keys, but only matched ${validKeysCount}. Using best-effort mapping for the missing lines.`);
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

async function handleBatchTranslation(lines, settings, contextLines = []) {
    const { secondLang, transEngine, apiUrl, aiModel, apiKey, reasoningEnabled } = settings;
    const MAX_RETRIES = 3;

    if (transEngine === 'custom_llm' && apiUrl) {
        const headers = buildRequestHeaders(apiKey, apiUrl);
        let tweaks = {};

        let lastError = null;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const payload = buildTranslationPayload(lines, settings, tweaks, contextLines);
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
                if (e.message.includes('Critical error')) throw new Error(formatHumanTranslationError(e.message, 'A provider beállítások nem kompatibilisek a kért modelllel.'));
                if (attempt === MAX_RETRIES) break;

                let delay = 1000 * attempt;
                if (e.message.includes('429')) delay = 2500 * attempt;

                console.warn(`[CR Bilingual Subtitles] Model request failed or misaligned, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`, e.message);
                await new Promise(r => setTimeout(r, delay));
            }
        }

        throw new Error(formatHumanTranslationError(lastError && lastError.message ? lastError.message : 'A fordítási kérés végül sikertelen volt.', 'A fordítási kérés végül sikertelen volt.'));

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
async function handleStreamTranslation(lines, settings, port, contextLines = []) {
    const { transEngine, apiUrl, aiModel, apiKey } = settings;
    const meta = {
        ...debugMetaFromSettings(settings),
        lineCount: Array.isArray(lines) ? lines.length : 0,
        contextCount: Array.isArray(contextLines) ? contextLines.length : 0
    };

    // 非 custom_llm（如 Google 机翻）无法流式，直接走批量逻辑后回传 done
    if (transEngine !== 'custom_llm' || !apiUrl) {
        try {
            const res = await handleBatchTranslation(lines, settings, contextLines);
            writeDebugLog({
                type: "translate_stream",
                mode: "batch_fallback",
                success: true,
                ...meta,
                at: new Date().toISOString(),
                resultCount: Array.isArray(res) ? res.length : 0
            });
            port.postMessage({ type: 'done', success: true, translations: res });
        } catch (e) {
            writeDebugLog({
                type: "translate_stream",
                mode: "batch_fallback",
                success: false,
                ...meta,
                at: new Date().toISOString(),
                error: e.message
            });
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
            const payload = buildTranslationPayload(lines, settings, tweaks, contextLines);
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
            writeDebugLog({
                type: "translate_stream",
                success: true,
                ...meta,
                at: new Date().toISOString(),
                resultCount: Array.isArray(translatedArray) ? translatedArray.length : 0,
                attempt,
                usedSSE: gotSSE
            });
            port.postMessage({ type: 'done', success: true, translations: translatedArray });
            return;

        } catch (e) {
            lastError = e;
            if (e.message.includes('Critical error')) {
                const human = formatHumanTranslationError(e.message, 'A provider beállítások nem kompatibilisek a kért modelllel.');
                writeDebugLog({
                    type: "translate_stream",
                    success: false,
                    ...meta,
                    at: new Date().toISOString(),
                    error: human,
                    rawError: e.message,
                    attempt
                });
                port.postMessage({ type: 'done', success: false, error: human });
                return;
            }
            if (attempt === MAX_RETRIES) break;

            let delay = 1000 * attempt;
            if (e.message.includes('429')) delay = 2500 * attempt;

            console.warn(`[CR Bilingual Subtitles] Stream request failed or misaligned, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`, e.message);
            await new Promise(r => setTimeout(r, delay));
        }
    }

    const humanFinal = formatHumanTranslationError(lastError && lastError.message ? lastError.message : 'A fordítási kérés végül sikertelen volt.', 'A fordítási kérés végül sikertelen volt.');
    writeDebugLog({
        type: "translate_stream",
        success: false,
        ...meta,
        at: new Date().toISOString(),
        error: humanFinal,
        rawError: lastError && lastError.message ? lastError.message : null
    });
    port.postMessage({ type: 'done', success: false, error: humanFinal });
}