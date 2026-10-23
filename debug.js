const storageKeys = [
  "aiProvider",
  "aiModel",
  "apiUrl",
  "apiKey",
  "providerApiKeys",
  "lastDebugRequest",
  "lastDebugCatalog",
  "lastDebugPlayback",
  "lastDebugHideNative",
  "hideNativeSubs",
  "uiLang",
  "secondLang",
  "transMode",
  "transEngine"
];

const t = (...args) => ExtI18n.t(...args);

/** Latest sanitized report for copy/download (no raw API keys). */
let latestDebugReport = null;

function maskKey(value) {
  if (!value) return t("debug_key_not_set", "not set");
  // Keep export shareable: never echo prefix/suffix that could identify a key
  return `set (${value.length} chars)`;
}

function setStatus(el, state, text) {
  el.className = `status ${state}`;
  el.textContent = text;
}

function fmtSec(v) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  return `${Math.round(Number(v) * 100) / 100}s`;
}

function describePlayback(pb) {
  if (!pb || !pb.event) {
    return t(
      "debug_playback_none",
      "No playback event recorded yet. Play a video with subtitles on, then refresh."
    );
  }

  if (pb.event === "disabled") {
    return t("debug_playback_hint_disabled", "Target language is set to none — overlay is intentionally off.");
  }
  if (pb.event === "native_unsupported") {
    return t(
      "debug_playback_hint_native",
      "Official-only mode is not supported on Prime yet. Use AI fallback or force AI, with English captions enabled."
    );
  }
  if (pb.event === "parse_empty" || pb.event === "parse_error") {
    return t(
      "debug_playback_hint_parse",
      "TTML/manifest was captured but cues could not be parsed. Check the raw snapshot sampleHead / error."
    );
  }
  if (pb.event === "waiting_for_player" || pb.videoTooSmall || pb.noPlayerVideo) {
    return t(
      "debug_playback_hint_waiting_player",
      "Waiting for a real Prime player (not the collapsed ~50px detail-page video). Click play and wait for the full player."
    );
  }
  if (pb.event === "overlay_layout_suspect" || pb.textOffVideo || pb.textOffscreen || pb.containerHugeVsVideo) {
    return t(
      "debug_playback_hint_layout",
      "Overlay is not on the video frame (wrong/page-tall container, or off-screen). Check containerH vs videoH and textTop vs videoTop."
    );
  }
  if (pb.event === "overlay_layout_ok") {
    return t(
      "debug_playback_hint_layout_ok",
      "Overlay layout looks reasonable (full player shell, not top-left)."
    );
  }
  if (pb.event === "cue_active") {
    return t(
      "debug_playback_hint_active",
      "A subtitle cue is active on the player. Pipeline looks healthy."
    );
  }
  if (pb.event === "between_cues") {
    return t(
      "debug_playback_hint_between",
      "No line at this exact moment — normal pause between dialogue cues. Not a sync failure."
    );
  }
  if (pb.event === "sync_miss") {
    return t(
      "debug_playback_hint_sync",
      "Cues are loaded but the nearest cue is far from video time. Likely a timing/base mismatch."
    );
  }
  if (pb.event === "cues_ready" && pb.overlayAttached === false) {
    return t(
      "debug_playback_hint_waiting_overlay",
      "Cues are ready; waiting for the player/video element to attach the overlay."
    );
  }
  if (pb.event === "overlay_attached" || pb.event === "cues_ready") {
    return t(
      "debug_playback_hint_ok",
      "Pipeline reached the player. If you still see no text, watch for sync_miss or check z-index / translation errors below."
    );
  }
  if (pb.event === "ttml_received" || pb.event === "manifest_received") {
    return t(
      "debug_playback_hint_received",
      "Subtitle source was captured. If this does not advance to cues_ready, parsing failed."
    );
  }
  return t("debug_playback_hint_generic", "See the raw playback snapshot for details.");
}

function describeHideNative(hn) {
  if (!hn || !hn.status) {
    return t(
      "debug_hide_native_none",
      "No hide-native snapshot yet. Open a player page, toggle the setting, wait a few seconds, then refresh."
    );
  }
  switch (hn.status) {
    case "disabled":
      return t(
        "debug_hide_native_hint_disabled",
        "Hide original subtitles is off. Turn it on in the popup/options, keep site English captions enabled."
      );
    case "ok": {
      const hs = hn.hardSubs || (hn.mainWorld && hn.mainWorld.hardSubs) || null;
      if (hs && hs.reason === "rewritten") {
        return t(
          "debug_hide_native_hint_ok_hardsubs_rewritten",
          "Softsubs are suppressed, and hardSubs streams were repointed to the clean (no burned-in text) manifest. Reload the episode once after enabling hide so the player fetches the new stream. If English remains after reload, it is game UI burned into every encode."
        );
      }
      if (hs && hs.reason === "no_clean_stream") {
        return t(
          "debug_hide_native_hint_ok_hardsubs_no_clean",
          "Softsubs are suppressed, but this title has no clean video stream (only hardsubs). English dialogue in the picture cannot be removed by CSS — only the extension overlay can show a translation on top."
        );
      }
      return t(
        "debug_hide_native_hint_ok",
        "Native softsub layer looks fully suppressed (shell display:none, no DOM leak). On-screen extension text is ourOverlayTextSample (not playback.activeText). If you still see English in the picture itself — especially game UI / skill popups — that is burned into the video frames and cannot be hidden by CSS. After an extension update, hard-reload the watch page so hardSubs→clean stream rewrite can run."
      );
    }
    case "texttrack_showing":
      return t(
        "debug_hide_native_hint_texttrack",
        "A native HTML TextTrack is still in mode=showing. See mainWorld.videoTextTracks."
      );
    case "dom_hidden_waiting_canvas_hook":
      return t(
        "debug_hide_native_hint_waiting_canvas",
        "DOM subtitle shell is hidden, but no ASS canvas draw was intercepted yet. Play while dialogue is on screen, then refresh — suppressedCanvasOps should rise if the hook is working."
      );
    case "bare_shell_child_leak":
      return t(
        "debug_hide_native_hint_bare_leak",
        "A child inside the CR subtitle shell is still visible (visibility:visible can override a hidden parent). See crBareShellLeak — display:none on the shell should stop this."
      );
    case "api_ok":
      return t(
        "debug_hide_native_hint_api_ok",
        "Bitmovin subtitle tracks were disabled via the player API (MAIN world). Native ASS should no longer paint."
      );
    case "api_no_player":
      return t(
        "debug_hide_native_hint_api_no_player",
        "Hide is on, but no Bitmovin player instance was hooked yet. Wait for playback to start, or reload the watch page after enabling the extension."
      );
    case "api_no_tracks":
      return t(
        "debug_hide_native_hint_api_no_tracks",
        "Player hooked, but subtitle track list is empty. Enable English captions in the CR player, then wait a moment."
      );
    case "api_tracks_still_enabled":
      return t(
        "debug_hide_native_hint_api_still",
        "Player API disable ran, but at least one subtitle track is still enabled. See mainWorld.tracks in the raw snapshot."
      );
    case "no_known_targets_dom_api_pending":
      return t(
        "debug_hide_native_hint_dom_api_pending",
        "No light-DOM caption nodes (normal on modern CR). Waiting on Bitmovin API hide — see mainWorld in the raw snapshot."
      );
    case "style_missing":
      return t(
        "debug_hide_native_hint_style_missing",
        "Setting is on but the hide CSS was removed from the page — content script may not be running on this tab."
      );
    case "known_target_visible":
      return t(
        "debug_hide_native_hint_known_visible",
        "Hide is on, but a known caption target is still visible. See knownVisible in the raw snapshot (selector / id / canvas)."
      );
    case "possible_leak":
      return t(
        "debug_hide_native_hint_leak",
        "Hide is on and known selectors look hidden, but other lower-screen nodes still look like captions. See leakCandidates — that is the next selector to add."
      );
    case "no_known_targets":
      return t(
        "debug_hide_native_hint_no_targets",
        "Player found, but none of our known caption selectors matched. Native UI may have renamed nodes — use leakCandidates / canvases."
      );
    case "waiting_player":
      return t(
        "debug_hide_native_hint_waiting",
        "Hide is on, waiting for a recognizable player shell. Start playback and wait a moment."
      );
    default:
      return t("debug_hide_native_hint_generic", "See the raw hide-native snapshot for details.");
  }
}

function slimCatalog(catalog) {
  if (!catalog || typeof catalog !== "object") return catalog || null;
  const out = { ...catalog };
  if (Array.isArray(out.models) && out.models.length > 40) {
    out.models = out.models.slice(0, 40);
    out.modelsTruncated = true;
    out.modelCount = catalog.models.length;
  }
  if (Array.isArray(out.providers)) {
    out.providers = out.providers.map((p) => {
      if (!p || typeof p !== "object") return p;
      const copy = { ...p };
      if (Array.isArray(copy.models) && copy.models.length > 20) {
        copy.models = copy.models.slice(0, 20);
        copy.modelsTruncated = true;
        copy.modelCount = p.models.length;
      }
      return copy;
    });
  }
  return out;
}

function buildDebugReport(items) {
  const provider = items.aiProvider || "openai";
  const apiKey = items.providerApiKeys && items.providerApiKeys[provider]
    ? items.providerApiKeys[provider]
    : (items.apiKey || "");
  const req = items.lastDebugRequest || null;
  const pb = items.lastDebugPlayback || null;
  const hn = items.lastDebugHideNative || null;
  const catalog = items.lastDebugCatalog || null;

  return {
    exportedAt: new Date().toISOString(),
    extension: "crunchyroll-bilingual-subtitles",
    config: {
      provider,
      model: items.aiModel || null,
      apiUrl: items.apiUrl || null,
      apiKey: maskKey(apiKey),
      hasApiKey: !!apiKey,
      secondLang: items.secondLang || null,
      transMode: items.transMode || null,
      transEngine: items.transEngine || null,
      hideNativeSubs: !!items.hideNativeSubs,
      uiLang: items.uiLang || "auto"
    },
    playback: pb && pb.event ? pb : null,
    playbackHint: describePlayback(pb || {}),
    hideNative: hn && hn.status ? hn : null,
    hideNativeHint: describeHideNative(hn || {}),
    latestRequest: req && req.type ? req : null,
    rootCause: describeRootCause(provider, items.apiUrl || "", req || {}),
    catalog: slimCatalog(catalog)
  };
}

function setExportStatus(ok, message) {
  const el = document.getElementById("export-status");
  if (!el) return;
  el.className = ok ? "ok" : "err";
  el.textContent = message;
  clearTimeout(setExportStatus._timer);
  setExportStatus._timer = setTimeout(() => {
    el.textContent = "";
    el.className = "";
  }, 3500);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    /* fallback */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (e2) {
    return false;
  }
}

async function copyDebugReport() {
  if (!latestDebugReport) {
    setExportStatus(false, t("debug_export_empty", "Nothing to export yet."));
    return;
  }
  const text = JSON.stringify(latestDebugReport, null, 2);
  const ok = await copyText(text);
  setExportStatus(
    ok,
    ok
      ? t("debug_copied", "Copied to clipboard.")
      : t("debug_copy_failed", "Copy failed — use Download JSON instead.")
  );
}

function downloadDebugReport() {
  if (!latestDebugReport) {
    setExportStatus(false, t("debug_export_empty", "Nothing to export yet."));
    return;
  }
  try {
    const text = JSON.stringify(latestDebugReport, null, 2);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = `dual-subs-debug-${stamp}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    setExportStatus(true, t("debug_downloaded", "JSON download started."));
  } catch (e) {
    setExportStatus(false, t("debug_download_failed", "Download failed."));
  }
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

    const pb = items.lastDebugPlayback || {};
    const pbStatusEl = document.getElementById("debug-playback-status");
    document.getElementById("debug-platform").textContent = pb.platform
      ? `${pb.platform}${pb.host ? " · " + pb.host : ""}`
      : "—";
    document.getElementById("debug-playback-event").textContent = pb.event || "—";
    document.getElementById("debug-cue-count").textContent =
      pb.cueCount != null ? String(pb.cueCount) : "—";
    document.getElementById("debug-video-time").textContent =
      pb.videoTime != null
        ? `${fmtSec(pb.videoTime)}${pb.videoPaused ? " (paused)" : ""}`
        : "—";
    const rangeStart = pb.firstStart != null ? pb.firstStart : pb.firstCueStart;
    const rangeEnd = pb.lastEnd != null ? pb.lastEnd : pb.lastCueEnd;
    document.getElementById("debug-cue-range").textContent =
      rangeStart != null || rangeEnd != null
        ? `${fmtSec(rangeStart)} → ${fmtSec(rangeEnd)}`
        : "—";
    document.getElementById("debug-overlay").textContent =
      pb.overlayAttached === true
        ? t("debug_overlay_yes", "attached")
        : pb.overlayAttached === false
          ? t("debug_overlay_no", "not yet")
          : "—";
    document.getElementById("debug-playback-hint").textContent = describePlayback(pb);
    document.getElementById("debug-playback").textContent = pb.event
      ? JSON.stringify(pb, null, 2)
      : t("debug_playback_none", "No playback event recorded yet.");

    if (!pb.event) {
      setStatus(pbStatusEl, "warn", t("debug_waiting", "Waiting…"));
    } else if (
      pb.event === "sync_miss"
      || pb.event === "parse_empty"
      || pb.event === "parse_error"
      || pb.event === "overlay_layout_suspect"
      || pb.event === "overlay_missing"
    ) {
      setStatus(pbStatusEl, "error", pb.event);
    } else if (pb.event === "waiting_for_player") {
      setStatus(pbStatusEl, "warn", pb.event);
    } else if (
      pb.event === "overlay_attached"
      || pb.event === "overlay_layout_ok"
      || pb.event === "cues_ready"
      || pb.event === "cue_active"
      || pb.event === "between_cues"
    ) {
      setStatus(pbStatusEl, "success", pb.event);
    } else {
      setStatus(pbStatusEl, "warn", pb.event);
    }

    const hn = items.lastDebugHideNative || {};
    const hnStatusEl = document.getElementById("debug-hide-native-status");
    document.getElementById("debug-hide-native-enabled").textContent = hn.status
      ? (hn.enabled ? t("debug_yes", "yes") : t("debug_no", "no"))
      : (items.hideNativeSubs ? t("debug_yes", "yes") : t("debug_no", "no"));
    document.getElementById("debug-hide-native-status-code").textContent = hn.status || "—";
    document.getElementById("debug-hide-native-targets").textContent = hn.status
      ? `${hn.knownVisibleCount != null ? hn.knownVisibleCount : "—"} visible / ${hn.knownTargetCount != null ? hn.knownTargetCount : "—"} found`
      : "—";
    document.getElementById("debug-hide-native-leaks").textContent =
      hn.leakCandidateCount != null ? String(hn.leakCandidateCount) : "—";
    document.getElementById("debug-hide-native-hint").textContent = describeHideNative(hn);
    document.getElementById("debug-hide-native").textContent = hn.status
      ? JSON.stringify(hn, null, 2)
      : t("debug_hide_native_none", "No hide-native snapshot yet.");

    if (!hn.status) {
      setStatus(hnStatusEl, "warn", t("debug_waiting", "Waiting…"));
    } else if (
      hn.status === "known_target_visible"
      || hn.status === "style_missing"
      || hn.status === "possible_leak"
      || hn.status === "api_tracks_still_enabled"
      || hn.status === "bare_shell_child_leak"
    ) {
      setStatus(hnStatusEl, "error", hn.status);
    } else if (hn.status === "ok" || hn.status === "api_ok" || hn.status === "canvas_hook_active") {
      setStatus(hnStatusEl, "success", hn.status);
    } else if (hn.status === "dom_hidden_waiting_canvas_hook") {
      setStatus(hnStatusEl, "warn", hn.status);
    } else {
      setStatus(hnStatusEl, "warn", hn.status);
    }

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

    latestDebugReport = buildDebugReport(items);
  });
}

const refreshBtn = document.getElementById("refresh-btn");
if (refreshBtn) refreshBtn.addEventListener("click", render);
const copyBtn = document.getElementById("copy-debug-btn");
if (copyBtn) copyBtn.addEventListener("click", copyDebugReport);
const downloadBtn = document.getElementById("download-debug-btn");
if (downloadBtn) downloadBtn.addEventListener("click", downloadDebugReport);
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
    const watched = [
      "aiProvider", "aiModel", "apiUrl", "apiKey", "providerApiKeys",
      "lastDebugRequest", "lastDebugCatalog", "lastDebugPlayback",
      "lastDebugHideNative", "hideNativeSubs", "uiLang"
    ];
    if (watched.some((key) => Object.prototype.hasOwnProperty.call(changes, key))) {
      render();
    }
  });
}
