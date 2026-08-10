const MANUAL_MODEL_VALUE = "__manual__";

function detectProvider(apiUrl, aiModel) {
    const url = (apiUrl || "").toLowerCase();
    if (url.includes("api.openai.com")) return "openai";
    if (url.includes("generativelanguage.googleapis.com")) return "gemini";
    if (url.includes("api.anthropic.com")) return "claude";
    if (url.includes("openrouter.ai")) return "openrouter";
    if (apiUrl || aiModel) return "custom";
    return "openai";
}

function t(key, fallback) {
    return chrome.i18n.getMessage(key) || fallback || key;
}

document.addEventListener("DOMContentLoaded", () => {
    const aiFields = document.getElementById("ai-fields");
    const engineSelect = document.getElementById("engine-select");
    const providerSelect = document.getElementById("ai-provider");
    const apiUrlWrap = document.getElementById("api-url-wrap");
    const apiUrlInput = document.getElementById("api-url");
    const apiKeyInput = document.getElementById("api-key");
    const modelSelect = document.getElementById("ai-model-select");
    const modelInput = document.getElementById("ai-model");
    const loadModelsBtn = document.getElementById("load-models-btn");
    const modelsHint = document.getElementById("models-hint");
    const saveBtn = document.getElementById("save-btn");
    const statusEl = document.getElementById("save-status");

    document.getElementById("title").textContent = t("popup_title");
    document.getElementById("label-lang").textContent = t("target_language");
    document.getElementById("label-mode").textContent = t("translation_mode");
    document.getElementById("label-engine").textContent = t("translation_engine");
    document.getElementById("label-provider").textContent = t("provider_label", "AI Provider");
    document.getElementById("label-api-url").textContent = t("api_url_label");
    document.getElementById("label-model").textContent = t("model_label");
    document.getElementById("label-api-key").textContent = t("api_key_label");
    document.getElementById("label-effort").textContent = t("reasoning_effort_label");
    document.getElementById("label-streaming").textContent = t("streaming_label");
    document.getElementById("label-batch").textContent = t("batch_size_label");
    document.getElementById("label-concurrency").textContent = t("concurrency_label");
    loadModelsBtn.textContent = t("load_models_button", "Load models");
    saveBtn.textContent = t("save_button");

    apiUrlInput.placeholder = t("api_url_placeholder");
    modelInput.placeholder = t("model_placeholder");
    apiKeyInput.placeholder = t("api_key_placeholder");

    const langSelect = document.getElementById("lang-select");
    const modeSelect = document.getElementById("mode-select");

    Array.from(langSelect.options).forEach(opt => {
        const msg = chrome.i18n.getMessage("lang_" + opt.value.replace("-", "_").toLowerCase());
        if (msg) opt.textContent = msg;
    });
    Array.from(modeSelect.options).forEach(opt => {
        const msg = chrome.i18n.getMessage("mode_" + opt.value);
        if (msg) opt.textContent = msg;
    });
    Array.from(engineSelect.options).forEach(opt => {
        const msg = chrome.i18n.getMessage("engine_" + opt.value.replace("_llm", ""));
        if (msg) opt.textContent = msg;
    });
    Array.from(providerSelect.options).forEach(opt => {
        const msg = chrome.i18n.getMessage("provider_" + opt.value);
        if (msg) opt.textContent = msg;
    });

    let preferredModel = "";
    let loadSeq = 0;
    let keyDebounce = null;

    const setHint = (msg, type = "") => {
        modelsHint.textContent = msg || "";
        modelsHint.className = "hint" + (type ? " " + type : "");
    };

    const updateCustomVisibility = () => {
        apiUrlWrap.style.display = providerSelect.value === "custom" ? "block" : "none";
        modelInput.style.display = modelSelect.value === MANUAL_MODEL_VALUE ? "block" : "none";
    };

    const updateVisibility = () => {
        aiFields.style.display = engineSelect.value === "custom_llm" ? "block" : "none";
        updateCustomVisibility();
    };

    const applyProviderPreset = (provider, forceUrl = false) => {
        const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
        if (provider === "custom") {
            updateCustomVisibility();
            return;
        }
        if (forceUrl || !apiUrlInput.value.trim()) apiUrlInput.value = preset.apiUrl;
        if (!preferredModel) preferredModel = preset.aiModel;
        updateCustomVisibility();
    };

    const ensurePresetApiUrl = (provider) => {
        const preset = PROVIDER_PRESETS[provider];
        if (preset && preset.apiUrl) apiUrlInput.value = preset.apiUrl;
    };

    const fillModelSelect = (models, selectedId) => {
        modelSelect.innerHTML = "";
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = t("model_select_placeholder", "Select a model…");
        modelSelect.appendChild(placeholder);

        const preferred = selectedId || preferredModel || "";
        let hasPreferred = false;

        for (const m of models) {
            const opt = document.createElement("option");
            opt.value = m.id;
            opt.textContent = m.name || m.id;
            if (m.id === preferred) {
                opt.selected = true;
                hasPreferred = true;
            }
            modelSelect.appendChild(opt);
        }

        const manual = document.createElement("option");
        manual.value = MANUAL_MODEL_VALUE;
        manual.textContent = t("model_manual_option", "Other (type manually)…");
        modelSelect.appendChild(manual);

        if (!hasPreferred && preferred) {
            const orphan = document.createElement("option");
            orphan.value = preferred;
            orphan.textContent = preferred;
            modelSelect.insertBefore(orphan, manual);
            orphan.selected = true;
            modelInput.value = preferred;
        } else if (hasPreferred) {
            modelInput.value = preferred;
        } else if (models.length) {
            modelSelect.selectedIndex = 1;
            modelInput.value = modelSelect.value;
        }

        updateCustomVisibility();
    };

    const seedFallbackModels = (hintMsg, hintType) => {
        const preset = PROVIDER_PRESETS[providerSelect.value] || PROVIDER_PRESETS.custom;
        let models = fallbackModelList(providerSelect.value);
        const selected = preferredModel || preset.aiModel || "";
        if (selected && !models.some(m => m.id === selected)) {
            models = [{ id: selected, name: selected }, ...models];
        }
        fillModelSelect(models, selected);
        if (hintMsg) setHint(hintMsg, hintType || "");
    };

    const loadModels = async () => {
        const provider = providerSelect.value;
        const apiKey = apiKeyInput.value.trim();
        const apiUrl = apiUrlInput.value.trim();

        if (provider !== "openrouter" && !apiKey) {
            seedFallbackModels(t("models_need_api_key", "Enter API key to load models"), "error");
            return;
        }
        if (provider === "custom" && !apiUrl) {
            seedFallbackModels(t("models_need_api_url", "Enter API URL to load models"), "error");
            return;
        }

        const seq = ++loadSeq;
        loadModelsBtn.disabled = true;
        setHint(t("models_loading", "Loading models…"));

        try {
            // Fetch directly from popup (host_permissions) — more reliable than SW messaging
            const models = await listProviderModels(provider, apiKey, apiUrl);
            if (seq !== loadSeq) return;

            if (!models.length) {
                seedFallbackModels(t("models_empty", "No chat models found"), "error");
                return;
            }
            fillModelSelect(models, preferredModel || modelInput.value);
            setHint(t("models_loaded", "Loaded {count} models").replace("{count}", String(models.length)), "ok");
        } catch (e) {
            if (seq !== loadSeq) return;
            console.warn("[CR Dual Subs] Model list failed:", e);
            seedFallbackModels(
                t("models_load_failed", "Failed to load models") + ": " + e.message,
                "error"
            );
        } finally {
            if (seq === loadSeq) loadModelsBtn.disabled = false;
        }
    };

    const resolveSelectedModel = () => {
        if (modelSelect.value === MANUAL_MODEL_VALUE || !modelSelect.value) {
            return modelInput.value.trim();
        }
        return modelSelect.value.trim();
    };

    chrome.storage.local.get({
        secondLang: "hu-HU",
        transMode: "fallback",
        transEngine: "custom_llm",
        aiProvider: "openai",
        apiUrl: PROVIDER_PRESETS.openai.apiUrl,
        aiModel: PROVIDER_PRESETS.openai.aiModel,
        apiKey: "",
        batchSize: 10,
        concurrency: 3,
        reasoningEnabled: false,
        streaming: true
    }, (s) => {
        langSelect.value = s.secondLang || "hu-HU";
        modeSelect.value = s.transMode || "fallback";
        engineSelect.value = s.transEngine || "custom_llm";
        apiUrlInput.value = s.apiUrl || "";
        preferredModel = s.aiModel || "";
        modelInput.value = s.aiModel || "";
        apiKeyInput.value = s.apiKey || "";
        document.getElementById("batch-size").value = s.batchSize || 10;
        document.getElementById("concurrency").value = s.concurrency || 3;
        document.getElementById("reasoning-toggle").checked = s.reasoningEnabled === true;
        document.getElementById("streaming-toggle").checked = s.streaming !== false;

        const provider = s.aiProvider || detectProvider(s.apiUrl, s.aiModel);
        providerSelect.value = PROVIDER_PRESETS[provider] ? provider : "custom";
        if (providerSelect.value !== "custom") {
            applyProviderPreset(providerSelect.value, !apiUrlInput.value.trim());
        }
        seedFallbackModels();
        updateVisibility();

        if (engineSelect.value === "custom_llm" && (apiKeyInput.value.trim() || providerSelect.value === "openrouter")) {
            loadModels();
        } else if (engineSelect.value === "custom_llm") {
            setHint(t("models_need_api_key", "Enter API key to load models"));
        }
    });

    engineSelect.addEventListener("change", updateVisibility);
    providerSelect.addEventListener("change", () => {
        preferredModel = (PROVIDER_PRESETS[providerSelect.value] || {}).aiModel || "";
        applyProviderPreset(providerSelect.value, true);
        seedFallbackModels();
        if (apiKeyInput.value.trim() || providerSelect.value === "openrouter") loadModels();
        else setHint(t("models_need_api_key", "Enter API key to load models"));
    });
    modelSelect.addEventListener("change", () => {
        if (modelSelect.value === MANUAL_MODEL_VALUE) {
            modelInput.style.display = "block";
            modelInput.focus();
        } else if (modelSelect.value) {
            modelInput.value = modelSelect.value;
            preferredModel = modelSelect.value;
        }
        updateCustomVisibility();
    });
    loadModelsBtn.addEventListener("click", loadModels);
    apiKeyInput.addEventListener("input", () => {
        clearTimeout(keyDebounce);
        keyDebounce = setTimeout(() => {
            if (apiKeyInput.value.trim().length > 10) loadModels();
        }, 500);
    });
    apiKeyInput.addEventListener("change", () => {
        if (apiKeyInput.value.trim()) loadModels();
    });

    saveBtn.addEventListener("click", () => {
        const provider = providerSelect.value;
        if (provider !== "custom") ensurePresetApiUrl(provider);

        const aiModel = resolveSelectedModel();
        if (engineSelect.value === "custom_llm" && !aiModel) {
            showStatus(t("models_need_model", "Please select a model"), "error");
            return;
        }
        if (engineSelect.value === "custom_llm" && provider !== "openrouter" && provider !== "custom" && !apiKeyInput.value.trim()) {
            showStatus(t("models_need_api_key", "Enter API key to load models"), "error");
            return;
        }

        const settings = {
            secondLang: langSelect.value,
            transMode: modeSelect.value,
            transEngine: engineSelect.value,
            aiProvider: provider,
            apiUrl: apiUrlInput.value.trim(),
            aiModel,
            apiKey: apiKeyInput.value.trim(),
            batchSize: parseInt(document.getElementById("batch-size").value) || 10,
            concurrency: parseInt(document.getElementById("concurrency").value) || 3,
            reasoningEnabled: document.getElementById("reasoning-toggle").checked,
            streaming: document.getElementById("streaming-toggle").checked
        };

        saveBtn.disabled = true;
        saveBtn.textContent = t("saving");

        chrome.storage.local.set(settings, () => {
            showStatus(t("saved_refreshing"), "success");
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0]) chrome.tabs.reload(tabs[0].id);
            });
        });
    });

    function showStatus(msg, type) {
        statusEl.textContent = msg;
        statusEl.className = "status " + type;
        statusEl.style.display = "block";
        setTimeout(() => { statusEl.style.display = "none"; }, 3000);
    }
});
