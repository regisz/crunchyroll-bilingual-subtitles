// Shared model catalog helpers (popup + service worker)

const PROVIDER_PRESETS = {
    openai: {
        apiUrl: "https://api.openai.com/v1/chat/completions",
        // Cost-efficient default for subtitle translation (low latency, reasoning can be set to none)
        aiModel: "gpt-5.6-luna",
        preferredModels: [
            "gpt-5.6-luna",
            "gpt-5-nano",
            "gpt-4.1-mini",
            "gpt-4o-mini"
        ]
    },
    gemini: {
        apiUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        aiModel: "gemini-2.5-flash",
        preferredModels: [
            "gemini-3.5-flash-lite",
            "gemini-3.1-flash-lite",
            "gemini-2.5-flash-lite",
            "gemini-2.5-flash",
            "gemini-flash-latest",
            "gemini-2.0-flash-lite",
            "gemini-2.0-flash"
        ]
    },
    claude: {
        apiUrl: "https://api.anthropic.com/v1/chat/completions",
        aiModel: "claude-haiku-4-5",
        preferredModels: [
            "claude-haiku-4-5",
            "claude-3-5-haiku-latest",
            "claude-3-5-haiku",
            "claude-sonnet-4-5"
        ]
    },
    openrouter: {
        apiUrl: "https://openrouter.ai/api/v1/chat/completions",
        aiModel: "openai/gpt-5.6-luna",
        preferredModels: [
            "openai/gpt-5.6-luna",
            "openai/gpt-5-nano",
            "openai/gpt-4o-mini",
            "google/gemini-2.5-flash-lite",
            "google/gemini-2.5-flash",
            "anthropic/claude-3.5-haiku"
        ]
    },
    custom: {
        apiUrl: "",
        aiModel: "",
        preferredModels: []
    }
};

// Back-compat alias used by older call sites
Object.keys(PROVIDER_PRESETS).forEach((key) => {
    const preset = PROVIDER_PRESETS[key];
    if (!preset.fallbackModels) preset.fallbackModels = preset.preferredModels || [];
});

function stripModelsPrefix(modelId) {
    return String(modelId || "").trim().replace(/^models\//i, "");
}

function normalizeModelId(modelId) {
    return stripModelsPrefix(modelId).toLowerCase();
}

function modelMatchesPriority(modelId, candidate) {
    const normalizedModel = normalizeModelId(modelId);
    const normalizedCandidate = normalizeModelId(candidate);
    if (!normalizedModel || !normalizedCandidate) return false;
    return normalizedModel === normalizedCandidate ||
        normalizedModel.includes(normalizedCandidate) ||
        normalizedCandidate.includes(normalizedModel);
}

function resolveDefaultModel(provider, availableModels = []) {
    const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
    const priority = (preset.preferredModels || preset.fallbackModels || []).length
        ? (preset.preferredModels || preset.fallbackModels)
        : [preset.aiModel].filter(Boolean);
    const liveIds = (availableModels || [])
        .map(item => item && (item.id || item.name))
        .filter(Boolean);

    for (const candidate of priority) {
        const match = liveIds.find(id => modelMatchesPriority(id, candidate));
        if (match) return match;
    }

    if (liveIds.length) return liveIds[0];
    return preset.aiModel || "";
}

function modelsUrlFromChatCompletions(apiUrl) {
    if (!apiUrl) return null;
    try {
        const u = new URL(apiUrl);
        if (/\/chat\/completions\/?$/.test(u.pathname)) {
            u.pathname = u.pathname.replace(/\/chat\/completions\/?$/, "/models");
        } else if (!u.pathname.endsWith("/models")) {
            u.pathname = u.pathname.replace(/\/[^/]*\/?$/, "/models");
        }
        return u.toString();
    } catch (e) {
        return null;
    }
}

function uniqSortModels(models) {
    const seen = new Set();
    const out = [];
    for (const m of models) {
        if (!m || !m.id || seen.has(m.id)) continue;
        seen.add(m.id);
        out.push({ id: m.id, name: m.name || m.id });
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
}

function isLikelyOpenAIChatModel(id) {
    const x = (id || "").toLowerCase();
    if (!x) return false;
    // Exclude non-chat modalities; keep the rest (IDs change often)
    if (/(embedding|whisper|tts|dall-e|dall_e|moderation|realtime|transcribe|\bimage\b|sora|omni-moderation|audio|codex|davinci|babbage|ada|ft:)/.test(x)) {
        return false;
    }
    return true;
}

function textLooksDeprecated(text) {
    const t = String(text || "").toLowerCase();
    if (!t) return false;
    return /(deprecated|deprecat|retired|shutdown|shut down|no longer (supported|available)|discontinued|end of life|\beol\b)/.test(t);
}

function isExpiredDate(value) {
    if (!value) return false;
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) return false;
    return ms < Date.now();
}

function isUsableOpenRouterModel(raw) {
    if (!raw || !raw.id) return false;
    if (isExpiredDate(raw.expiration_date)) return false;
    if (textLooksDeprecated(raw.description) || textLooksDeprecated(raw.name)) return false;

    const arch = raw.architecture || {};
    const outputs = arch.output_modalities || arch.modality || [];
    if (Array.isArray(outputs) && outputs.length && !outputs.some(m => String(m).toLowerCase() === "text")) {
        return false;
    }
    if (typeof outputs === "string" && outputs && !/text/i.test(outputs)) {
        return false;
    }
    return true;
}

function isUsableGeminiNativeModel(raw) {
    if (!raw) return false;
    const methods = raw.supportedGenerationMethods || [];
    if (!Array.isArray(methods) || !methods.includes("generateContent")) return false;
    if (textLooksDeprecated(raw.description) || textLooksDeprecated(raw.displayName) || textLooksDeprecated(raw.name)) {
        return false;
    }
    return true;
}

function isUsableGenericModel(raw) {
    if (!raw) return false;
    if (raw.deprecated === true || raw.is_deprecated === true || raw.retired === true) return false;
    if (isExpiredDate(raw.expiration_date || raw.deprecated_at || raw.shutdown_at)) return false;
    if (textLooksDeprecated(raw.description) || textLooksDeprecated(raw.name) || textLooksDeprecated(raw.display_name)) {
        return false;
    }
    return true;
}

function fallbackModelList(provider) {
    // Kept for resolveDefaultModel priority only — do not use as a UI model catalog.
    const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
    return (preset.preferredModels || preset.fallbackModels || []).map(id => ({ id, name: id }));
}

function pickBestAvailableModel(provider, models) {
    const list = Array.isArray(models) ? models : [];
    const preferred = resolveDefaultModel(provider, list);
    if (preferred && list.some(m => modelMatchesPriority(m.id || m.name, preferred))) {
        return preferred;
    }
    if (list.length) return list[0].id || list[0].name;
    return preferred || "";
}

async function readHttpError(res) {
    let detail = "";
    try {
        detail = (await res.text() || "").slice(0, 120);
    } catch (e) { /* ignore */ }
    return detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`;
}

async function listProviderModels(provider, apiKey, apiUrl) {
    const key = (apiKey || "").trim();
    const p = provider || "openai";

    if (p === "openai") {
        if (!key) throw new Error("API key required");
        const res = await fetch("https://api.openai.com/v1/models", {
            headers: { Authorization: `Bearer ${key}` }
        });
        if (!res.ok) throw new Error(`OpenAI models ${await readHttpError(res)}`);
        const data = await res.json();
        const models = (data.data || [])
            .filter(isUsableGenericModel)
            .map(m => ({ id: stripModelsPrefix(m.id), name: stripModelsPrefix(m.id) }))
            .filter(m => isLikelyOpenAIChatModel(m.id));
        return uniqSortModels(models);
    }

    if (p === "claude") {
        if (!key) throw new Error("API key required");
        const res = await fetch("https://api.anthropic.com/v1/models", {
            headers: {
                "x-api-key": key,
                Authorization: `Bearer ${key}`,
                "anthropic-version": "2023-06-01"
            }
        });
        if (!res.ok) throw new Error(`Anthropic models ${await readHttpError(res)}`);
        const data = await res.json();
        const models = (data.data || [])
            .filter(isUsableGenericModel)
            .map(m => ({
                id: m.id,
                name: m.display_name ? `${m.display_name} (${m.id})` : m.id
            }));
        return uniqSortModels(models);
    }

    if (p === "gemini") {
        if (!key) throw new Error("API key required");

        // Prefer OpenAI-compatible catalog (same IDs as chat/completions)
        try {
            const res = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/models", {
                headers: { Authorization: `Bearer ${key}` }
            });
            if (res.ok) {
                const data = await res.json();
                const models = (data.data || [])
                    .filter(isUsableGenericModel)
                    .map(m => ({ id: stripModelsPrefix(m.id), name: stripModelsPrefix(m.id) }))
                    .filter(m => m.id && /gemini/i.test(m.id));
                if (models.length) return uniqSortModels(models);
            }
        } catch (e) {
            // fall through to native list
        }

        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
        if (!res.ok) throw new Error(`Gemini models ${await readHttpError(res)}`);
        const data = await res.json();
        const models = (data.models || [])
            .filter(isUsableGeminiNativeModel)
            .map(m => {
                const id = stripModelsPrefix(m.name || "");
                return { id, name: m.displayName ? `${m.displayName} (${id})` : id };
            })
            .filter(m => m.id && /gemini/i.test(m.id));
        return uniqSortModels(models);
    }

    if (p === "openrouter") {
        const headers = {};
        if (key) headers.Authorization = `Bearer ${key}`;
        const res = await fetch("https://openrouter.ai/api/v1/models", { headers });
        if (!res.ok) throw new Error(`OpenRouter models ${await readHttpError(res)}`);
        const data = await res.json();
        const models = (data.data || [])
            .filter(isUsableOpenRouterModel)
            .map(m => ({
                id: m.id,
                name: m.name ? `${m.name}` : m.id
            }));
        return uniqSortModels(models);
    }

    const modelsUrl = modelsUrlFromChatCompletions(apiUrl);
    if (!modelsUrl) throw new Error("Custom provider needs a chat completions API URL");
    if (!key) throw new Error("API key required");
    const res = await fetch(modelsUrl, {
        headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json"
        }
    });
    if (!res.ok) throw new Error(`Custom models ${await readHttpError(res)}`);
    const data = await res.json();
    const raw = data.data || data.models || [];
    const models = raw
        .filter(isUsableGenericModel)
        .map(m => {
            const id = stripModelsPrefix(m.id || m.name || "");
            return { id, name: stripModelsPrefix(m.displayName || m.display_name || m.name || id) };
        }).filter(m => m.id);
    return uniqSortModels(models);
}
