// Shared model catalog helpers (popup + service worker)

const PROVIDER_PRESETS = {
    openai: {
        apiUrl: "https://api.openai.com/v1/chat/completions",
        aiModel: "gpt-4o-mini",
        fallbackModels: [
            "gpt-4o-mini",
            "gpt-4o",
            "gpt-4.1-mini",
            "gpt-4.1",
            "o4-mini",
            "o3-mini"
        ]
    },
    gemini: {
        apiUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        aiModel: "gemini-2.5-flash",
        fallbackModels: [
            "gemini-2.5-flash",
            "gemini-2.5-pro",
            "gemini-2.0-flash",
            "gemini-2.0-flash-lite",
            "gemini-flash-latest",
            "gemini-pro-latest"
        ]
    },
    claude: {
        apiUrl: "https://api.anthropic.com/v1/chat/completions",
        aiModel: "claude-haiku-4-5",
        fallbackModels: [
            "claude-haiku-4-5",
            "claude-sonnet-4-5",
            "claude-sonnet-4-6",
            "claude-opus-4-5",
            "claude-opus-4-6"
        ]
    },
    openrouter: {
        apiUrl: "https://openrouter.ai/api/v1/chat/completions",
        aiModel: "openai/gpt-4o-mini",
        fallbackModels: [
            "openai/gpt-4o-mini",
            "google/gemini-2.5-flash",
            "anthropic/claude-haiku-4.5",
            "openai/gpt-4o"
        ]
    },
    custom: {
        apiUrl: "",
        aiModel: "",
        fallbackModels: []
    }
};

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
    if (/(embedding|whisper|tts|dall-e|dall_e|moderation|realtime|transcribe|\bimage\b|sora|omni-moderation|audio)/.test(x)) {
        return false;
    }
    return true;
}

function fallbackModelList(provider) {
    const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
    return (preset.fallbackModels || []).map(id => ({ id, name: id }));
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
            .map(m => ({ id: m.id, name: m.id }))
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
        const models = (data.data || []).map(m => ({
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
                    .map(m => ({ id: m.id, name: m.id }))
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
            .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
            .map(m => {
                const id = (m.name || "").replace(/^models\//, "");
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
        const models = (data.data || []).map(m => ({
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
    const models = raw.map(m => {
        const id = m.id || (m.name || "").replace(/^models\//, "");
        return { id, name: m.displayName || m.display_name || m.name || id };
    }).filter(m => m.id);
    return uniqSortModels(models);
}
