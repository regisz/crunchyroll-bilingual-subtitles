const MANUAL_MODEL_VALUE = "__manual__";
const PROVIDER_ORDER = ["openai", "gemini", "claude", "openrouter", "custom"];
const PROVIDER_LABELS = {
    openai: "OpenAI",
    gemini: "Google",
    claude: "Anthropic",
    openrouter: "OpenRouter",
    custom: "Custom"
};

function getProviderLabel(provider) {
    return PROVIDER_LABELS[provider] || String(provider || "").replace(/_/g, " ");
}

function detectProvider(apiUrl, aiModel) {
    const url = (apiUrl || "").toLowerCase();
    if (url.includes("api.openai.com")) return "openai";
    if (url.includes("generativelanguage.googleapis.com")) return "gemini";
    if (url.includes("api.anthropic.com")) return "claude";
    if (url.includes("openrouter.ai")) return "openrouter";
    if (apiUrl || aiModel) return "custom";
    return "openai";
}

function setHint(el, msg, type = "") {
    el.textContent = msg || "";
    el.className = "hint" + (type ? " " + type : "");
}

function showStatus(el, msg, type) {
    el.textContent = msg;
    el.className = "status " + type;
}

function resolveSelectedModel(modelSelect, modelInput) {
    if (modelSelect.value === MANUAL_MODEL_VALUE || !modelSelect.value) {
        return modelInput.value.trim();
    }
    return modelSelect.value.trim();
}

function humanizeProviderLoadError(raw) {
    const text = String(raw || "").trim();
    const lower = text.toLowerCase();
    if (!text) return "unknown error";
    if (lower.includes("api key required")) return "API key missing";
    if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("incorrect api key") || lower.includes("invalid api key")) {
        return "invalid or unauthorized API key";
    }
    if (lower.includes("403") || lower.includes("forbidden")) return "API key forbidden / no access";
    if (lower.includes("429") || lower.includes("rate limit")) return "rate limited — try again later";
    if (lower.includes("404")) return "models endpoint not found (bad URL or retired API)";
    if (lower.includes("failed to fetch") || lower.includes("networkerror") || lower.includes("network")) {
        return "network error — check connection or extension permissions";
    }
    return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

document.addEventListener("DOMContentLoaded", () => {
    const aiFields = document.getElementById("ai-fields");
    const engineSelect = document.getElementById("engine-select");
    const globalModelSelect = document.getElementById("global-model-select");
    const providerKeyTable = document.getElementById("provider-key-table");
    const customUrlPanel = document.getElementById("custom-url-panel");
    const apiUrlInput = document.getElementById("api-url");
    const modelSelect = globalModelSelect;
    const modelInput = document.getElementById("ai-model");
    const loadModelsBtn = document.getElementById("load-models-btn");
    const exportModelsBtn = document.getElementById("export-models-btn");
    const modelsHint = document.getElementById("models-hint");
    const providerLoadStatusEl = document.getElementById("provider-load-status");
    const modelFilterInput = document.getElementById("model-filter");
    const modelFilterMeta = document.getElementById("model-filter-meta");
    const saveBtn = document.getElementById("save-btn");
    const resetBtn = document.getElementById("reset-btn");
    const openDebugBtn = document.getElementById("open-debug-btn");
    const statusEl = document.getElementById("save-status");
    const langSelect = document.getElementById("lang-select");
    const modeSelect = document.getElementById("mode-select");

    let preferredModel = "";
    let selectedProvider = "openai";
    let selectedModel = "";
    let loadSeq = 0;
    let providerApiKeys = {};
    let providerModelCatalog = {};
    let providerLoadStatus = {};
    let allModelOptions = [];

    const setActiveProviderKey = (provider, keyValue) => {
        if (!provider) return "";
        providerApiKeys[provider] = String(keyValue || "").trim();
        return providerApiKeys[provider];
    };

    const applySelectedFromValue = (value) => {
        if (!value) return;
        const [provider, ...rest] = value.split("|");
        const modelId = rest.join("|");
        if (!provider || !modelId) return;
        selectedProvider = provider;
        selectedModel = modelId;
        preferredModel = modelId;
        modelInput.value = modelId;
        syncSelectedProviderUrl(provider, true);
        updateCustomUrlVisibility();
    };

    const renderFilteredModelSelect = () => {
        const query = ((modelFilterInput && modelFilterInput.value) || "").trim().toLowerCase();
        const filtered = !query
            ? allModelOptions
            : allModelOptions.filter((option) => {
                const hay = `${option.label} ${option.provider} ${option.id}`.toLowerCase();
                return query.split(/\s+/).every((token) => hay.includes(token));
            });

        const previousValue = selectedProvider && selectedModel
            ? `${selectedProvider}|${selectedModel}`
            : (globalModelSelect.value || "");

        globalModelSelect.innerHTML = "";
        if (!allModelOptions.length) {
            const empty = document.createElement("option");
            empty.value = "";
            empty.textContent = "No models loaded — fix API keys / provider errors below";
            globalModelSelect.appendChild(empty);
            if (modelFilterMeta) modelFilterMeta.textContent = "";
            return;
        }

        if (!filtered.length) {
            const empty = document.createElement("option");
            empty.value = "";
            empty.textContent = query
                ? `No models match “${query}”`
                : "No models";
            globalModelSelect.appendChild(empty);
            if (modelFilterMeta) {
                modelFilterMeta.textContent = `Showing 0 of ${allModelOptions.length}`;
            }
            return;
        }

        filtered.forEach((option) => {
            const opt = document.createElement("option");
            opt.value = `${option.provider}|${option.id}`;
            opt.textContent = option.label;
            globalModelSelect.appendChild(opt);
        });

        const stillVisible = filtered.some((o) => `${o.provider}|${o.id}` === previousValue);
        if (stillVisible) {
            globalModelSelect.value = previousValue;
        } else {
            globalModelSelect.selectedIndex = 0;
            applySelectedFromValue(globalModelSelect.value);
        }

        if (modelFilterMeta) {
            modelFilterMeta.textContent = query
                ? `Showing ${filtered.length} of ${allModelOptions.length} (filter: “${query}”)`
                : `${allModelOptions.length} models — type above to filter`;
        }
    };

    const rebuildGlobalModelSelect = () => {
        allModelOptions = [];
        PROVIDER_ORDER.forEach((provider) => {
            const items = providerModelCatalog[provider] || [];
            items.forEach((item) => {
                const id = item.id || item.name;
                if (!id) return;
                allModelOptions.push({
                    provider,
                    id,
                    label: `${PROVIDER_LABELS[provider] || provider} - ${id}`
                });
            });
        });

        if (selectedProvider && selectedModel) {
            const currentValue = `${selectedProvider}|${selectedModel}`;
            const exists = allModelOptions.some((o) => `${o.provider}|${o.id}` === currentValue);
            if (!exists && allModelOptions.length) {
                const preferredIdx = allModelOptions.findIndex((o) =>
                    o.provider === "openai" && /luna|gpt-4o-mini|gpt-4\.1-mini|gpt-5-nano/i.test(o.id)
                );
                const pick = preferredIdx >= 0 ? allModelOptions[preferredIdx] : allModelOptions[0];
                selectedProvider = pick.provider;
                selectedModel = pick.id;
                preferredModel = pick.id;
                modelInput.value = pick.id;
                syncSelectedProviderUrl(pick.provider, true);
            }
        } else if (allModelOptions.length) {
            const preferredIdx = allModelOptions.findIndex((o) =>
                o.provider === "openai" && /luna|gpt-4o-mini|gpt-4\.1-mini|gpt-5-nano/i.test(o.id)
            );
            const pick = preferredIdx >= 0 ? allModelOptions[preferredIdx] : allModelOptions[0];
            selectedProvider = pick.provider;
            selectedModel = pick.id;
            preferredModel = pick.id;
            modelInput.value = pick.id;
            syncSelectedProviderUrl(pick.provider, true);
        }

        renderFilteredModelSelect();
    };

    const renderProviderLoadStatus = () => {
        if (!providerLoadStatusEl) return;
        providerLoadStatusEl.innerHTML = "";
        PROVIDER_ORDER.forEach((provider) => {
            const st = providerLoadStatus[provider];
            if (!st) return;
            const line = document.createElement("div");
            line.className = `provider-status-line ${st.state || ""}`;
            const label = getProviderLabel(provider);
            if (st.state === "ok") {
                line.textContent = `${label}: OK — ${st.count} models loaded`;
            } else if (st.state === "error") {
                line.textContent = `${label}: FAILED — ${st.detail}`;
            } else if (st.state === "skip") {
                line.textContent = `${label}: skipped — ${st.detail}`;
            } else if (st.state === "loading") {
                line.textContent = `${label}: loading…`;
            } else {
                line.textContent = `${label}: ${st.detail || st.state}`;
            }
            providerLoadStatusEl.appendChild(line);
        });
    };

    const renderProviderKeyTable = () => {
        providerKeyTable.innerHTML = "";

        PROVIDER_ORDER.forEach((provider) => {
            const row = document.createElement("div");
            row.className = "provider-row";

            const providerName = document.createElement("div");
            providerName.className = "provider-name";
            providerName.textContent = PROVIDER_LABELS[provider] || provider;

            const providerInputWrap = document.createElement("div");
            providerInputWrap.className = "provider-input-wrap";

            const keyInput = document.createElement("input");
            keyInput.type = "password";
            keyInput.value = providerApiKeys[provider] || "";
            keyInput.placeholder = `API key for ${PROVIDER_LABELS[provider] || provider}`;
            keyInput.addEventListener("input", () => {
                setActiveProviderKey(provider, keyInput.value.trim());
                if (provider === "custom") {
                    customUrlPanel.style.display = "block";
                }
            });

            providerInputWrap.appendChild(keyInput);
            row.appendChild(providerName);
            row.appendChild(providerInputWrap);
            providerKeyTable.appendChild(row);
        });
    };

    const updateCustomUrlVisibility = () => {
        customUrlPanel.style.display = selectedProvider === "custom" || Boolean(apiUrlInput.value.trim()) ? "block" : "none";
    };

    const syncSelectedProviderUrl = (provider, force = false) => {
        if (!provider || provider === "custom") return;
        const preset = PROVIDER_PRESETS[provider];
        if (!preset || !preset.apiUrl) return;

        const current = apiUrlInput.value.trim();
        const builtInUrls = Object.values(PROVIDER_PRESETS)
            .map((entry) => entry && entry.apiUrl)
            .filter(Boolean);

        if (force || !current || builtInUrls.includes(current)) {
            apiUrlInput.value = preset.apiUrl;
        }
    };

    const updateVisibility = () => {
        aiFields.style.display = engineSelect.value === "custom_llm" ? "block" : "none";
    };

    const exportLoadedModels = async () => {
        const payload = { exportedAt: new Date().toISOString(), providers: {} };
        const visibleEntries = Array.from(globalModelSelect.options || []).map((option) => {
            const value = (option.value || "").trim();
            if (!value) return null;
            const [provider, ...rest] = value.split("|");
            const modelId = rest.join("|");
            if (!provider || !modelId) return null;
            return { provider, modelId };
        }).filter(Boolean);

        if (!visibleEntries.length) {
            showStatus(statusEl, "No models are available to export.", "error");
            return;
        }

        visibleEntries.forEach(({ provider, modelId }) => {
            const label = getProviderLabel(provider);
            if (!payload.providers[label]) payload.providers[label] = [];
            if (!payload.providers[label].includes(modelId)) {
                payload.providers[label].push(modelId);
            }
        });

        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        link.download = `ai-model-list-${timestamp}.json`;
        link.click();
        URL.revokeObjectURL(url);
        showStatus(statusEl, "Visible model list exported as JSON.", "success");
    };

    const loadModelsForProvider = async (provider) => {
        const apiKey = (providerApiKeys[provider] || "").trim();
        const apiUrl = apiUrlInput.value.trim();
        const label = getProviderLabel(provider);

        if (provider !== "openrouter" && !apiKey) {
            providerModelCatalog[provider] = [];
            providerLoadStatus[provider] = { state: "skip", detail: "no API key" };
            return { provider, ok: false, skipped: true };
        }
        if (provider === "custom" && !apiUrl) {
            providerModelCatalog[provider] = [];
            providerLoadStatus[provider] = { state: "skip", detail: "no custom API URL" };
            return { provider, ok: false, skipped: true };
        }

        providerLoadStatus[provider] = { state: "loading", detail: "loading…" };
        renderProviderLoadStatus();

        try {
            const models = await listProviderModels(provider, apiKey, apiUrl);
            providerModelCatalog[provider] = models;
            if (!models.length) {
                providerLoadStatus[provider] = {
                    state: "error",
                    detail: "API responded but returned 0 usable chat models"
                };
                return { provider, ok: false, error: "empty catalog" };
            }
            providerLoadStatus[provider] = { state: "ok", count: models.length, detail: `${models.length} models` };
            return { provider, ok: true, models };
        } catch (e) {
            providerModelCatalog[provider] = [];
            const detail = humanizeProviderLoadError(e && e.message ? e.message : e);
            providerLoadStatus[provider] = { state: "error", detail };
            console.warn(`[CR Dual Subs] ${label} model list failed:`, e);
            return { provider, ok: false, error: detail };
        }
    };

    const loadAllProviderModels = async () => {
        const seq = ++loadSeq;
        loadModelsBtn.disabled = true;
        setHint(modelsHint, "Loading models for every configured provider…");
        providerLoadStatus = {};
        PROVIDER_ORDER.forEach((provider) => {
            providerLoadStatus[provider] = { state: "loading", detail: "queued…" };
        });
        renderProviderLoadStatus();

        const results = await Promise.all(PROVIDER_ORDER.map((provider) => loadModelsForProvider(provider)));
        if (seq !== loadSeq) return;

        rebuildGlobalModelSelect();
        renderProviderLoadStatus();

        const ok = results.filter(r => r.ok);
        const failed = results.filter(r => !r.ok && !r.skipped);
        const skipped = results.filter(r => r.skipped);

        const catalogSummary = {
            source: "options_load_all",
            loadedAt: new Date().toISOString(),
            providers: {}
        };
        PROVIDER_ORDER.forEach((provider) => {
            const st = providerLoadStatus[provider] || {};
            const models = providerModelCatalog[provider] || [];
            catalogSummary.providers[provider] = {
                state: st.state || "unknown",
                detail: st.detail || "",
                count: models.length,
                sample: models.slice(0, 8).map((m) => m.id || m.name).filter(Boolean)
            };
        });
        chrome.storage.local.set({ lastDebugCatalog: catalogSummary });
        chrome.runtime.sendMessage({ action: "debug_catalog", catalog: catalogSummary }, () => {
            void chrome.runtime.lastError;
        });

        if (!ok.length) {
            setHint(
                modelsHint,
                failed.length
                    ? "No provider returned models. Check the FAILED lines below (usually a bad/missing API key)."
                    : "No API keys configured. Add at least one provider key, then load again.",
                "error"
            );
            return;
        }

        if (failed.length) {
            setHint(
                modelsHint,
                `Loaded ${ok.length} provider(s), but ${failed.length} failed. Only successful providers appear in the model list.`,
                "warn"
            );
        } else {
            const skipNote = skipped.length ? ` (${skipped.length} skipped without key/URL)` : "";
            setHint(modelsHint, `Loaded models from ${ok.length} provider(s)${skipNote}.`, "ok");
        }
    };

    const syncFromStorage = (s) => {
        providerApiKeys = { ...(s.providerApiKeys || {}) };
        if (!providerApiKeys.openai && s.apiKey) providerApiKeys.openai = s.apiKey || "";
        selectedProvider = s.aiProvider || detectProvider(s.apiUrl, s.aiModel) || "openai";
        selectedModel = s.aiModel || "";
        preferredModel = selectedModel || (PROVIDER_PRESETS[selectedProvider] || {}).aiModel || "";
        apiUrlInput.value = s.apiUrl || (PROVIDER_PRESETS[selectedProvider] || {}).apiUrl || "";
        syncSelectedProviderUrl(selectedProvider, true);
        modelInput.value = selectedModel || "";

        renderProviderKeyTable();
        PROVIDER_ORDER.forEach((provider) => {
            providerModelCatalog[provider] = [];
        });
        providerLoadStatus = {};
        rebuildGlobalModelSelect();
        renderProviderLoadStatus();
        updateCustomUrlVisibility();
    };

    chrome.storage.local.get({
        secondLang: "hu-HU",
        transMode: "fallback",
        transEngine: "custom_llm",
        aiProvider: "openai",
        apiUrl: PROVIDER_PRESETS.openai.apiUrl,
        aiModel: PROVIDER_PRESETS.openai.aiModel,
        apiKey: "",
        batchSize: 15,
        concurrency: 2,
        reasoningEnabled: false,
        streaming: true,
        providerApiKeys: {}
    }, (s) => {
        langSelect.value = s.secondLang || "hu-HU";
        modeSelect.value = s.transMode || "fallback";
        engineSelect.value = s.transEngine || "custom_llm";
        const reasoningToggle = document.getElementById("reasoning-toggle");
        const streamingToggle = document.getElementById("streaming-toggle");
        if (reasoningToggle) reasoningToggle.checked = !!s.reasoningEnabled;
        if (streamingToggle) streamingToggle.checked = s.streaming !== false;
        const batchInput = document.getElementById("batch-size");
        const concurrencyInput = document.getElementById("concurrency");
        if (batchInput) batchInput.value = s.batchSize || 15;
        if (concurrencyInput) concurrencyInput.value = s.concurrency || 2;

        syncFromStorage(s);
        updateVisibility();

        if (engineSelect.value === "custom_llm") {
            const hasAnyKey = PROVIDER_ORDER.some((p) => (providerApiKeys[p] || "").trim()) ||
                Boolean((s.apiKey || "").trim());
            if (hasAnyKey) {
                setHint(modelsHint, "Loading models for configured providers…");
                loadAllProviderModels().finally(() => {
                    loadModelsBtn.disabled = false;
                });
            } else {
                setHint(modelsHint, "Add provider API keys above, then click Load all models.", "");
            }
        }
    });

    globalModelSelect.addEventListener("change", () => {
        applySelectedFromValue(globalModelSelect.value);
    });

    if (modelFilterInput) {
        modelFilterInput.addEventListener("input", () => {
            renderFilteredModelSelect();
        });
        modelFilterInput.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                modelFilterInput.value = "";
                renderFilteredModelSelect();
            } else if (e.key === "Enter") {
                e.preventDefault();
                if (globalModelSelect.value) applySelectedFromValue(globalModelSelect.value);
            } else if (e.key === "ArrowDown") {
                e.preventDefault();
                globalModelSelect.focus();
                if (globalModelSelect.selectedIndex < 0 && globalModelSelect.options.length) {
                    globalModelSelect.selectedIndex = 0;
                    applySelectedFromValue(globalModelSelect.value);
                }
            }
        });
    }

    if (openDebugBtn) {
        openDebugBtn.addEventListener("click", () => {
            chrome.tabs.create({ url: chrome.runtime.getURL("debug.html") });
        });
    }

    loadModelsBtn.addEventListener("click", () => {
        loadAllProviderModels().finally(() => {
            loadModelsBtn.disabled = false;
        });
    });
    exportModelsBtn.addEventListener("click", async () => {
        exportModelsBtn.disabled = true;
        exportModelsBtn.textContent = "Exporting…";
        try {
            await exportLoadedModels();
        } finally {
            exportModelsBtn.disabled = false;
            exportModelsBtn.textContent = "Export model list";
        }
    });

    apiUrlInput.addEventListener("input", () => {
        updateCustomUrlVisibility();
    });

    resetBtn.addEventListener("click", () => {
        chrome.storage.local.clear(() => {
            const defaults = {
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
                streaming: true,
                lastDebugRequest: null,
                lastDebugCatalog: null
            };

            chrome.storage.local.set(defaults, () => {
                showStatus(statusEl, "All settings cleared and reset to defaults.", "success");
                setTimeout(() => {
                    window.location.reload();
                }, 200);
            });
        });
    });

    saveBtn.addEventListener("click", () => {
        const provider = selectedProvider || "openai";
        const aiModel = selectedModel || resolveSelectedModel(modelSelect, modelInput) || (PROVIDER_PRESETS[provider] || {}).aiModel || "";
        if (engineSelect.value === "custom_llm" && !aiModel) {
            showStatus(statusEl, "Please select a model", "error");
            return;
        }
        if (engineSelect.value === "custom_llm" && provider !== "openrouter" && provider !== "custom" && !(providerApiKeys[provider] || "").trim()) {
            showStatus(statusEl, "Enter API key for the selected provider", "error");
            return;
        }

        const failedSelected = providerLoadStatus[provider] && providerLoadStatus[provider].state === "error";
        if (failedSelected) {
            showStatus(statusEl, `${getProviderLabel(provider)} model list failed earlier: ${providerLoadStatus[provider].detail}`, "error");
            return;
        }

        syncSelectedProviderUrl(provider, true);
        const resolvedApiUrl = provider === "custom"
            ? apiUrlInput.value.trim()
            : (PROVIDER_PRESETS[provider] || {}).apiUrl || apiUrlInput.value.trim();

        const settings = {
            secondLang: langSelect.value,
            transMode: modeSelect.value,
            transEngine: engineSelect.value,
            aiProvider: provider,
            apiUrl: resolvedApiUrl,
            aiModel,
            apiKey: providerApiKeys[provider] || "",
            providerApiKeys,
            batchSize: parseInt(document.getElementById("batch-size").value) || 15,
            concurrency: parseInt(document.getElementById("concurrency").value) || 2,
            reasoningEnabled: document.getElementById("reasoning-toggle").checked,
            streaming: document.getElementById("streaming-toggle").checked
        };

        saveBtn.disabled = true;
        saveBtn.textContent = "Saving...";

        chrome.storage.local.set(settings, () => {
            showStatus(statusEl, "Settings saved. Reload the Crunchyroll tab to apply.", "success");
            saveBtn.disabled = false;
            saveBtn.textContent = "Save";
        });
    });

    engineSelect.addEventListener("change", updateVisibility);
});
