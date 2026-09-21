const storageKeys = [
  "aiProvider",
  "aiModel",
  "apiUrl",
  "apiKey",
  "providerApiKeys",
  "lastDebugRequest",
  "lastDebugCatalog",
  "uiLang"
];

const t = (...args) => ExtI18n.t(...args);

function maskKey(value) {
  if (!value) return t("debug_key_not_set", "not set");
  if (value.length <= 6) return "***";
  return `${value.slice(0, 3)}${"*".repeat(Math.max(3, value.length - 6))}${value.slice(-3)}`;
}

function setStatus(el, state, text) {
  el.className = `status ${state}`;
  el.textContent = text;
}

function describeRootCause(provider, apiUrl, req) {
  const text = req && req.error ? String(req.error) : "";
  const lower = text.toLowerCase();

  if (!req || !req.type) {
    return t("debug_cause_none", "No translated request has run yet. The extension is configured, but no runtime request has been sent.");
  }

  if (provider && apiUrl) {
    const expectedProvider = provider.toLowerCase();
    const urlMatchesProvider =
      (expectedProvider === "openai" && apiUrl.includes("api.openai.com")) ||
      (expectedProvider === "gemini" && apiUrl.includes("generativelanguage.googleapis.com")) ||
      (expectedProvider === "claude" && apiUrl.includes("api.anthropic.com")) ||
      (expectedProvider === "openrouter" && apiUrl.includes("openrouter.ai"));

    if (!urlMatchesProvider && expectedProvider !== "custom") {
      return t(
        "debug_cause_url_mismatch",
        `Provider and API URL do not match. The selected provider is ${provider}, but the request is still using ${apiUrl}.`,
        [provider, apiUrl]
      );
    }
  }

  if (lower.includes("incorrect api key") || lower.includes("unauthorized") || lower.includes("401") || lower.includes("403")) {
    return t("debug_cause_bad_key", "The API key is invalid for the selected provider or the wrong provider key is being used.");
  }

  if (lower.includes("unsupported") && (lower.includes("max_tokens") || lower.includes("temperature") || lower.includes("max_completion_tokens"))) {
    return t("debug_cause_params", "The chosen model rejects one of the request parameters.");
  }

  if (lower.includes("rate limit") || lower.includes("429")) {
    return t("debug_cause_rate", "The provider rejected the request because of rate limiting.");
  }

  if (lower.includes("malformed json") || lower.includes("alignment failed") || lower.includes("could not be repaired")) {
    return t("debug_cause_json", "The model responded with an unexpected format.");
  }

  if (req.success) {
    return t("debug_cause_ok", "The request succeeded.");
  }

  return t("debug_cause_unknown", "The request failed, but the error does not clearly point to one root cause.");
}

function render() {
  ExtI18n.applyStaticI18n(document);
  const warningEl = document.getElementById("debug-warning");
  if (!window.chrome || !chrome.storage || !chrome.storage.local) {
    warningEl.style.display = "block";
    return;
  }

  warningEl.style.display = "none";
  chrome.storage.local.get(storageKeys, (items) => {
    const provider = items.aiProvider || "openai";
    const model = items.aiModel || "not set";
    const apiUrl = items.apiUrl || "not set";
    const apiKey = items.providerApiKeys && items.providerApiKeys[provider]
      ? items.providerApiKeys[provider]
      : (items.apiKey || "");

    document.getElementById("debug-provider").textContent = provider;
    document.getElementById("debug-model").textContent = model;
    document.getElementById("debug-api-url").textContent = apiUrl;
    document.getElementById("debug-api-key").textContent = maskKey(apiKey);

    const req = items.lastDebugRequest || {};
    const requestEl = document.getElementById("debug-request-details");
    const statusEl = document.getElementById("debug-request-status");
    const rootCauseEl = document.getElementById("debug-root-cause");

    if (!req || !req.type) {
      setStatus(statusEl, "warn", t("debug_waiting", "Waiting…"));
      requestEl.textContent = t("debug_no_request", "No request recorded yet.");
      rootCauseEl.textContent = t("debug_cause_none", "No translated request has run yet.");
    } else {
      const state = req.success ? "success" : "error";
      setStatus(statusEl, state, req.success ? t("debug_success", "Success") : t("debug_failed", "Failed"));
      requestEl.textContent = JSON.stringify(req, null, 2);
      rootCauseEl.textContent = describeRootCause(provider, apiUrl, req);
    }

    const catalog = items.lastDebugCatalog || { provider: provider, models: [] };
    document.getElementById("debug-catalog").textContent = catalog && (catalog.providers || catalog.models || catalog.error)
      ? JSON.stringify(catalog, null, 2)
      : t("debug_no_catalog", "No catalog loaded yet.");
  });
}

const refreshBtn = document.getElementById("refresh-btn");
if (refreshBtn) refreshBtn.addEventListener("click", render);
async function boot() {
  try {
    const uiLang = await ExtI18n.loadUiLangFromStorage();
    await ExtI18n.applyUiLanguage(uiLang);
  } catch (e) {
    console.warn("[CR Dual Subs] debug UI language failed", e);
    await ExtI18n.applyUiLanguage("auto");
  }
  render();
}

boot();

// Live update when translation / model load writes storage
if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    if (changes.uiLang) {
      try {
        await ExtI18n.applyUiLanguage(changes.uiLang.newValue || "auto");
      } catch (e) {
        console.warn("[CR Dual Subs] debug UI language switch failed", e);
      }
    }
    const watched = ["aiProvider", "aiModel", "apiUrl", "apiKey", "providerApiKeys", "lastDebugRequest", "lastDebugCatalog", "uiLang"];
    if (watched.some((key) => Object.prototype.hasOwnProperty.call(changes, key))) {
      render();
    }
  });
}
