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
    const engineSelect = document.getElementById("engine-select");
    const modelSelect = document.getElementById("ai-model-select");
    const modelInput = document.getElementById("ai-model");
    const loadModelsBtn = document.getElementById("load-models-btn");
    const exportModelsBtn = document.getElementById("export-models-btn");
    const modelsHint = document.getElementById("models-hint");
    const saveBtn = document.getElementById("save-btn");
    const openOptionsBtn = document.getElementById("open-options-btn");
    const openDebugBtn = document.getElementById("open-debug-btn");
    const downloadEnBtn = document.getElementById("download-en-btn");
    const statusEl = document.getElementById("save-status");

    let currentLoadedModels = [];
    let currentProvider = "openai";
    let currentApiKey = "";
    let currentApiUrl = "";
    let preferredModel = "";
    let loadSeq = 0;
    let savedSettings = {};

    document.getElementById("title").textContent = t("popup_title");
    document.getElementById("label-lang").textContent = t("target_language");
    document.getElementById("label-mode").textContent = t("translation_mode");
    document.getElementById("label-engine").textContent = t("translation_engine");
    document.getElementById("label-model").textContent = t("model_label");
    loadModelsBtn.textContent = t("load_models_button", "Load models");
    saveBtn.textContent = t("save_button");
    if (downloadEnBtn) downloadEnBtn.textContent = t("download_english_button", "Download English subtitle");
    modelInput.placeholder = t("model_placeholder");

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

    const setHint = (msg, type = "") => {
        modelsHint.textContent = msg || "";
        modelsHint.className = "hint" + (type ? " " + type : "");
    };

    const updateVisibility = () => {
        const isCustom = engineSelect.value === "custom_llm";
        modelSelect.disabled = !isCustom;
        loadModelsBtn.disabled = !isCustom;
        modelInput.style.display = modelSelect.value === MANUAL_MODEL_VALUE ? "block" : "none";
    };

    const fillModelSelect = (models, selectedId) => {
        currentLoadedModels = Array.isArray(models) ? models.map(m => ({ id: m.id, name: m.name || m.id })) : [];
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

        updateVisibility();
    };

    const clearModelList = (hintMsg, hintType) => {
        currentLoadedModels = [];
        modelSelect.innerHTML = "";
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = t("model_select_placeholder", "Select a model…");
        modelSelect.appendChild(placeholder);
        modelInput.value = "";
        updateVisibility();
        if (hintMsg) setHint(hintMsg, hintType || "");
    };

    const exportLoadedModels = () => {
        const selectedModel = resolveSelectedModel();
        const payload = {
            exportedAt: new Date().toISOString(),
            selectedModel,
            providers: {
                [currentProvider]: currentLoadedModels.map(item => item.id || item.name)
            }
        };

        if (!currentLoadedModels.length) {
            showStatus("No models are loaded yet.", "error");
            return;
        }

        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        link.download = `ai-model-list-${timestamp}.json`;
        link.click();
        URL.revokeObjectURL(url);
        showStatus("Model list exported as JSON.", "success");
    };

    const loadModels = async () => {
        const provider = currentProvider;
        const apiKey = currentApiKey;
        const apiUrl = currentApiUrl;

        if (provider !== "openrouter" && !apiKey) {
            clearModelList("Open full settings and add the API key for this provider.", "error");
            return;
        }
        if (provider === "custom" && !apiUrl) {
            clearModelList("Open full settings and add the custom API URL.", "error");
            return;
        }

        const seq = ++loadSeq;
        loadModelsBtn.disabled = true;
        setHint("Loading models…");

        try {
            const models = await listProviderModels(provider, apiKey, apiUrl);
            if (seq !== loadSeq) return;

            if (!models.length) {
                chrome.storage.local.set({
                    lastDebugCatalog: {
                        source: "popup_load",
                        provider,
                        models: [],
                        totalCount: 0,
                        error: "API responded but returned 0 usable chat models",
                        loadedAt: new Date().toISOString()
                    }
                });
                clearModelList("No chat models found for this provider.", "error");
                return;
            }

            const recommended = preferredModel && models.some(m => m.id === preferredModel)
                ? preferredModel
                : pickBestAvailableModel(provider, models);
            preferredModel = recommended;
            fillModelSelect(models, recommended);
            chrome.storage.local.set({
                lastDebugCatalog: {
                    source: "popup_load",
                    provider,
                    models: models.slice(0, 20).map(m => m.id || m.name),
                    totalCount: models.length,
                    loadedAt: new Date().toISOString()
                }
            });
            setHint(`Loaded ${models.length} models`, "ok");
        } catch (e) {
            if (seq !== loadSeq) return;
            console.warn("[CR Dual Subs] Model list failed:", e);
            chrome.storage.local.set({
                lastDebugCatalog: {
                    source: "popup_load",
                    provider,
                    models: [],
                    totalCount: 0,
                    error: e && e.message ? e.message : String(e),
                    loadedAt: new Date().toISOString()
                }
            });
            clearModelList("Failed to load models: " + (e && e.message ? e.message : String(e)), "error");
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
        providerApiKeys: {},
        batchSize: 15,
        concurrency: 2,
        reasoningEnabled: false,
        streaming: true
    }, (s) => {
        savedSettings = s;
        currentProvider = s.aiProvider || detectProvider(s.apiUrl, s.aiModel);
        currentApiKey = (s.providerApiKeys && s.providerApiKeys[currentProvider]) || s.apiKey || "";
        currentApiUrl = s.apiUrl || (PROVIDER_PRESETS[currentProvider] || {}).apiUrl || "";
        preferredModel = s.aiModel || "";
        modelInput.value = preferredModel;

        clearModelList();
        updateVisibility();

        if (engineSelect.value === "custom_llm") {
            if (currentApiKey || currentProvider === "openrouter" || (currentProvider === "custom" && currentApiUrl)) {
                loadModels();
            } else {
                setHint("Open full settings to add the API key for this provider.", "error");
            }
        }
    });

    engineSelect.addEventListener("change", updateVisibility);
    modelSelect.addEventListener("change", () => {
        if (modelSelect.value === MANUAL_MODEL_VALUE) {
            modelInput.style.display = "block";
            modelInput.focus();
        } else if (modelSelect.value) {
            modelInput.value = modelSelect.value;
            preferredModel = modelSelect.value;
        }
        updateVisibility();
    });
    loadModelsBtn.addEventListener("click", loadModels);
    exportModelsBtn.addEventListener("click", exportLoadedModels);

    if (openOptionsBtn) {
        openOptionsBtn.addEventListener("click", () => {
            if (chrome.runtime.openOptionsPage) {
                chrome.runtime.openOptionsPage();
            } else {
                chrome.tabs.create({ url: "options.html" });
            }
        });
    }
    if (openDebugBtn) {
        openDebugBtn.addEventListener("click", () => {
            chrome.tabs.create({ url: chrome.runtime.getURL("debug.html") });
        });
    }

    if (downloadEnBtn) {
        downloadEnBtn.addEventListener("click", () => {
            downloadEnBtn.disabled = true;
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (!tabs[0]) {
                    showStatus(t("download_english_failed", "Download failed"), "error");
                    downloadEnBtn.disabled = false;
                    return;
                }
                chrome.tabs.sendMessage(tabs[0].id, { action: "download_english_subtitle" }, (response) => {
                    downloadEnBtn.disabled = false;
                    if (chrome.runtime.lastError || !response || !response.success) {
                        showStatus(
                            (response && response.error) || t("download_english_unavailable", "English subtitle unavailable"),
                            "error"
                        );
                        return;
                    }
                    showStatus(t("download_english_started", "English subtitle download started"), "success");
                });
            });
        });
    }

    saveBtn.addEventListener("click", () => {
        const aiModel = resolveSelectedModel();
        if (engineSelect.value === "custom_llm" && !aiModel) {
            showStatus(t("models_need_model", "Please select a model"), "error");
            return;
        }

        const providerApiKeys = { ...(savedSettings.providerApiKeys || {}) };
        providerApiKeys[currentProvider] = currentApiKey;

        const settings = {
            ...savedSettings,
            aiProvider: currentProvider,
            apiUrl: currentApiUrl,
            aiModel,
            apiKey: currentApiKey,
            providerApiKeys
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
