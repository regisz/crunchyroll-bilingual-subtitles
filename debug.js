const storageKeys = [
  "aiProvider",
  "aiModel",
  "apiUrl",
  "apiKey",
  "providerApiKeys",
  "lastDebugRequest",
  "lastDebugCatalog"
];

function maskKey(value) {
  if (!value) return "not set";
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
    return "No translated request has run yet. The extension is configured, but no runtime request has been sent.";
  }

  if (provider && apiUrl) {
    const expectedProvider = provider.toLowerCase();
    const urlMatchesProvider =
      (expectedProvider === "openai" && apiUrl.includes("api.openai.com")) ||
      (expectedProvider === "gemini" && apiUrl.includes("generativelanguage.googleapis.com")) ||
      (expectedProvider === "claude" && apiUrl.includes("api.anthropic.com")) ||
      (expectedProvider === "openrouter" && apiUrl.includes("openrouter.ai"));

    if (!urlMatchesProvider) {
      return `Provider and API URL do not match. The selected provider is ${provider}, but the request is still using ${apiUrl}. This usually causes 401/403 auth errors.`;
    }
  }

  if (lower.includes("incorrect api key") || lower.includes("unauthorized") || lower.includes("401") || lower.includes("403")) {
    return "The API key is invalid for the selected provider or the wrong provider key is being used.";
  }

  if (lower.includes("unsupported") && (lower.includes("max_tokens") || lower.includes("temperature") || lower.includes("max_completion_tokens"))) {
    return "The chosen model rejects one of the request parameters. Try a different model or disable the unsupported parameter.";
  }

  if (lower.includes("rate limit") || lower.includes("429")) {
    return "The provider rejected the request because of rate limiting or temporary throttling.";
  }

  if (lower.includes("malformed json") || lower.includes("alignment failed") || lower.includes("could not be repaired")) {
    return "The model responded with an unexpected format, so the subtitle JSON could not be parsed correctly.";
  }

  if (req.success) {
    return "The request succeeded. If there is still a problem, it is likely a model or parsing mismatch rather than an API/auth failure.";
  }

  return "The request failed, but the error does not clearly point to one root cause. Check the provider, model, and API URL together.";
}

function render() {
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
      : (items.apiKey || "not set");

    document.getElementById("debug-provider").textContent = provider;
    document.getElementById("debug-model").textContent = model;
    document.getElementById("debug-api-url").textContent = apiUrl;
    document.getElementById("debug-api-key").textContent = maskKey(apiKey);

    const req = items.lastDebugRequest || {};
    const requestEl = document.getElementById("debug-request-details");
    const statusEl = document.getElementById("debug-request-status");
    const rootCauseEl = document.getElementById("debug-root-cause");

    if (!req || !req.type) {
      setStatus(statusEl, "warn", "Waiting…");
      requestEl.textContent = "No request recorded yet.";
      rootCauseEl.textContent = "No translated request has run yet. The extension is configured, but no runtime request has been sent.";
    } else {
      const state = req.success ? "success" : "error";
      setStatus(statusEl, state, req.success ? "Success" : "Failed");
      requestEl.textContent = JSON.stringify(req, null, 2);
      rootCauseEl.textContent = describeRootCause(provider, apiUrl, req);
    }

    const catalog = items.lastDebugCatalog || { provider: provider, models: [] };
    document.getElementById("debug-catalog").textContent = JSON.stringify(catalog, null, 2);
  });
}

const refreshBtn = document.getElementById("refresh-btn");
if (refreshBtn) refreshBtn.addEventListener("click", render);
render();

// Live update when translation / model load writes storage
if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const watched = ["aiProvider", "aiModel", "apiUrl", "apiKey", "providerApiKeys", "lastDebugRequest", "lastDebugCatalog"];
    if (watched.some((key) => Object.prototype.hasOwnProperty.call(changes, key))) {
      render();
    }
  });
}
