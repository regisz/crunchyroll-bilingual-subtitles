// ==========================================
// Crunchyroll AI Bilingual Subtitles Pro - content.js
// 包含【防抢占延迟引擎】修复首播崩溃问题
// ==========================================

const FETCH_TIMEOUT_MS = 15000;
const IS_PRIME = /(^|\.)primevideo\.com$/i.test(location.hostname)
    || /(^|\.)amazon\./i.test(location.hostname);
const DEFAULT_SETTINGS = {
    secondLang: "hu-HU",
    transMode: "fallback",
    transEngine: "custom_llm",
    aiProvider: "openai",
    apiUrl: "https://api.openai.com/v1/chat/completions",
    aiModel: "gpt-5.6-luna",
    apiKey: "",
    subSize: 26,
    subBottom: 10,
    batchSize: 15,
    concurrency: 2,
    reasoningEnabled: false,
    streaming: true,
    hideNativeSubs: false,
    subColor: "",
    subBgOpacity: 65,
    subTop: "auto",
    subLeft: "0",
    subWidth: "100%"
};

const HIDE_NATIVE_SUBS_STYLE_ID = "cr-hide-native-subs-style";
let hideNativeSubsObserver = null;
let hideNativeSubsPollId = null;
let hideNativeSubsEnabled = false;
let lastHideNativeDebugWriteAt = 0;
let lastHideNativeDebugStatus = "";

const NATIVE_SUB_HIDE_SELECTORS = [
    // Prime (DOM captions)
    ".atvwebplayersdk-captions-text",
    ".atvwebplayersdk-captions-overlay",
    ".atvwebplayersdk-captions-container",
    "[class*='atvwebplayersdk-captions']",
    // Crunchyroll: custom ASS layer is often a bare child of the Bitmovin shell
    // (no class/id) — CSS class*='subtitle' never matches it.
    ".bitmovinplayer-container > div:not([class]):not([id])",
    // Legacy / alternate CR canvas renderers
    "#velocity-canvas",
    "canvas#velocity-canvas",
    "canvas[id*='velocity' i]",
    "canvas[class*='velocity' i]",
    "canvas[id*='subtitle' i]",
    "canvas[class*='subtitle' i]",
    "canvas[class*='caption' i]",
    // Crunchyroll / Bitmovin HTML UI (CC / some locales)
    ".bmpui-ui-subtitle-overlay",
    ".bmpui-ui-subtitle-label",
    ".bmpui-subtitle-region-container",
    ".bitmovinplayer-subtitle",
    ".bitmovinplayer-container .bmpui-ui-subtitle-overlay",
    "[class*='bmpui-ui-subtitle']",
    "[class*='subtitle-overlay']",
    "[class*='SubtitleOverlay']",
    "[class*='subtitle'][class*='container']",
    "[class*='subtitle'][class*='render']",
    "[class*='subtitle'][class*='wrapper']",
    "[class*='subtitle'][class*='display']",
    "[class*='CaptionRenderer']",
    "[class*='player-subtitles']",
    "[data-testid*='subtitle']",
    "[data-testid*='caption']",
    "[class*='vilos']",
    // Fallbacks
    ".vjs-text-track-display"
];

function isOurDualSubNode(el) {
    if (!el || !el.closest) return false;
    return !!(el.closest("#my-cr-dual-sub-container")
        || el.closest("#cr-inplayer-controls-wrapper")
        || el.id === "my-cr-dual-sub-container"
        || el.id === "my-cr-dual-sub-text");
}

function findNativeSubPlayerRoot() {
    return document.querySelector(".bitmovinplayer-container")
        || document.getElementById("player0")
        || document.getElementById("vilos-player")
        || document.getElementById("player-container")
        || document.querySelector("[data-testid='player']")
        || null;
}

/** Light DOM + open shadow roots (CR player sometimes nests UI). */
function queryAllDeep(selector, root) {
    const out = [];
    const visit = (node) => {
        if (!node) return;
        try {
            if (node.querySelectorAll) {
                node.querySelectorAll(selector).forEach((el) => out.push(el));
            }
        } catch (e) { /* invalid selector */ }
        const walk = node.querySelectorAll ? node.querySelectorAll("*") : [];
        for (const el of walk) {
            if (el.shadowRoot) visit(el.shadowRoot);
        }
    };
    visit(root || document);
    return out;
}

function isElementVisiblyShowing(el) {
    if (!el || el.nodeType !== 1) return false;
    const st = window.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) {
        return false;
    }
    const r = el.getBoundingClientRect();
    return r.width >= 8 && r.height >= 4
        && r.bottom > 0 && r.right > 0
        && r.top < window.innerHeight && r.left < window.innerWidth;
}

function describeNativeSubNode(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    const cls = el.className != null ? String(el.className) : "";
    const text = (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80);
    return {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        className: cls.slice(0, 160),
        text: text || null,
        markedHidden: el.getAttribute("data-cr-native-sub-hidden") === "1",
        display: st.display,
        visibility: st.visibility,
        opacity: st.opacity,
        rect: {
            top: Math.round(r.top),
            left: Math.round(r.left),
            w: Math.round(r.width),
            h: Math.round(r.height)
        }
    };
}

function forceHideNativeSubNode(el) {
    if (!el || el.nodeType !== 1 || isOurDualSubNode(el)) return;
    // display:none is required on CR: a child with visibility:visible can paint
    // through an ancestor that only has visibility:hidden.
    el.style.setProperty("display", "none", "important");
    el.style.setProperty("visibility", "hidden", "important");
    el.style.setProperty("opacity", "0", "important");
    el.style.setProperty("pointer-events", "none", "important");
    el.setAttribute("data-cr-native-sub-hidden", "1");
}

function clearForcedNativeSubHides() {
    queryAllDeep("[data-cr-native-sub-hidden='1']").forEach((el) => {
        el.style.removeProperty("display");
        el.style.removeProperty("opacity");
        el.style.removeProperty("visibility");
        el.style.removeProperty("pointer-events");
        el.removeAttribute("data-cr-native-sub-hidden");
    });
}

/** Hide CR's bare Bitmovin subtitle shell and every descendant (visibility alone leaks). */
function forceHideCrBareSubtitleShell() {
    document.querySelectorAll(".bitmovinplayer-container > div:not([class]):not([id])").forEach((shell) => {
        if (isOurDualSubNode(shell)) return;
        // Never hide a shell that actually wraps the <video>
        if (shell.querySelector("video")) return;
        forceHideNativeSubNode(shell);
        try {
            shell.querySelectorAll("*").forEach((el) => {
                if (isOurDualSubNode(el)) return;
                forceHideNativeSubNode(el);
            });
        } catch (e) { /* ignore */ }
    });
}

const nativeTextTrackCleanups = new WeakMap();

function suppressNativeTextTracks() {
    document.querySelectorAll("video").forEach((video) => {
        try {
            const tracks = video.textTracks;
            if (!tracks) return;
            for (let i = 0; i < tracks.length; i++) {
                const tr = tracks[i];
                if (!tr) continue;
                // UA cue painting ignores CSS — must disable the track itself.
                if (tr.mode !== "disabled") tr.mode = "disabled";
            }
            if (!nativeTextTrackCleanups.has(video)) {
                const onChange = () => {
                    if (!hideNativeSubsEnabled) return;
                    for (let i = 0; i < tracks.length; i++) {
                        const tr = tracks[i];
                        if (tr && tr.mode !== "disabled") tr.mode = "disabled";
                    }
                };
                const onAdd = (e) => {
                    if (!hideNativeSubsEnabled || !e.track) return;
                    try { e.track.mode = "disabled"; } catch (err) { /* ignore */ }
                };
                tracks.addEventListener("change", onChange);
                tracks.addEventListener("addtrack", onAdd);
                nativeTextTrackCleanups.set(video, () => {
                    try {
                        tracks.removeEventListener("change", onChange);
                        tracks.removeEventListener("addtrack", onAdd);
                    } catch (err) { /* ignore */ }
                });
            }
        } catch (e) { /* ignore */ }
    });
}

function sweepHideNativeSubs() {
    forceHideCrBareSubtitleShell();
    NATIVE_SUB_HIDE_SELECTORS.forEach((sel) => {
        try {
            document.querySelectorAll(sel).forEach(forceHideNativeSubNode);
        } catch (e) { /* invalid selector */ }
    });
    const player = findNativeSubPlayerRoot();
    if (player) {
        // Also pierce open shadow roots under the player shell
        NATIVE_SUB_HIDE_SELECTORS.forEach((sel) => {
            queryAllDeep(sel, player).forEach(forceHideNativeSubNode);
        });
        queryAllDeep("[class*='subtitle' i], [class*='Subtitle'], [class*='caption' i]", player).forEach((el) => {
            if (isOurDualSubNode(el)) return;
            const cls = String(el.className || "");
            if (/settings|menu|button|list|select|toggle/i.test(cls) && !/overlay|label|region|cue/i.test(cls)) {
                return;
            }
            forceHideNativeSubNode(el);
        });
        // CR ASS canvas variants (id/class rename across player versions)
        queryAllDeep("canvas", player).forEach((canvas) => {
            if (isOurDualSubNode(canvas)) return;
            const id = String(canvas.id || "");
            const cls = String(canvas.className || "");
            if (/velocity|subtitle|caption|ass|libjass|softsub/i.test(`${id} ${cls}`)) {
                forceHideNativeSubNode(canvas);
            }
        });
    }
    suppressNativeTextTracks();
    writeHideNativeDebug(false);
}

function stopHideNativeSubsEnforcer() {
    if (hideNativeSubsObserver) {
        hideNativeSubsObserver.disconnect();
        hideNativeSubsObserver = null;
    }
    if (hideNativeSubsPollId) {
        clearInterval(hideNativeSubsPollId);
        hideNativeSubsPollId = null;
    }
    document.querySelectorAll("video").forEach((video) => {
        const cleanup = nativeTextTrackCleanups.get(video);
        if (cleanup) {
            cleanup();
            nativeTextTrackCleanups.delete(video);
        }
    });
}

function startHideNativeSubsEnforcer() {
    stopHideNativeSubsEnforcer();
    sweepHideNativeSubs();
    let sweepScheduled = false;
    const scheduleSweep = () => {
        if (sweepScheduled) return;
        sweepScheduled = true;
        requestAnimationFrame(() => {
            sweepScheduled = false;
            sweepHideNativeSubs();
        });
    };
    hideNativeSubsObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.type === "attributes" && m.target
                && m.target.getAttribute
                && m.target.getAttribute("data-cr-native-sub-hidden") === "1") {
                continue;
            }
            scheduleSweep();
            return;
        }
    });
    hideNativeSubsObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style"]
    });
    const bitmovin = document.querySelector(".bitmovinplayer-container");
    if (bitmovin) {
        hideNativeSubsObserver.observe(bitmovin, { childList: true, subtree: true });
    }
    // CR remounts the anonymous subtitle shell often — poll faster than 1s
    hideNativeSubsPollId = setInterval(sweepHideNativeSubs, 300);
}

function collectHideNativeLeakCandidates() {
    const hits = [];
    const player = findNativeSubPlayerRoot();
    const nodes = player
        ? queryAllDeep("div,span,p,canvas", player)
        : Array.from(document.querySelectorAll("div,span,p,canvas"));
    for (const el of nodes) {
        if (isOurDualSubNode(el)) continue;
        if (!isElementVisiblyShowing(el)) continue;
        const r = el.getBoundingClientRect();
        // Lower half of viewport — typical caption band
        if (r.height > 240 || r.width < 40 || r.height < 8) continue;
        if (r.top < window.innerHeight * 0.4) continue;
        const cls = (el.className && String(el.className)) || "";
        const text = (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80);
        const interesting =
            /subtitle|caption|cue|bmpui|vilos|text-track|ass|libjass|velocity/i.test(`${el.id} ${cls}`)
            || el.tagName === "CANVAS"
            || (text.length >= 2 && text.length <= 80 && /[A-Za-zÀ-ÿ]/.test(text));
        if (!interesting) continue;
        hits.push(describeNativeSubNode(el));
        if (hits.length >= 20) break;
    }
    return hits;
}

function readMainWorldHideDiag() {
    try {
        const raw = document.documentElement.getAttribute("data-cr-hide-native-diag");
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
}

function syncHideNativeToMainWorld(enabled) {
    try {
        document.documentElement.setAttribute("data-cr-hide-native-subs", enabled ? "1" : "0");
        document.documentElement.dispatchEvent(new CustomEvent("cr-dual-subs-hide-native", {
            bubbles: true,
            detail: { enabled: !!enabled }
        }));
    } catch (e) { /* ignore */ }
}

function collectHideNativeDiagnostics() {
    const stylePresent = !!document.getElementById(HIDE_NATIVE_SUBS_STYLE_ID);
    const player = findNativeSubPlayerRoot();
    const mainDiag = readMainWorldHideDiag();
    const known = [];
    const liveKnownVisible = [];
    const seen = new Set();
    const collectKnown = (el, sel) => {
        if (seen.has(el) || isOurDualSubNode(el)) return;
        seen.add(el);
        const brief = Object.assign({ selector: sel }, describeNativeSubNode(el));
        known.push(brief);
        if (isElementVisiblyShowing(el)) liveKnownVisible.push(brief);
    };
    NATIVE_SUB_HIDE_SELECTORS.forEach((sel) => {
        try {
            document.querySelectorAll(sel).forEach((el) => collectKnown(el, sel));
        } catch (e) { /* ignore */ }
        if (player) queryAllDeep(sel, player).forEach((el) => collectKnown(el, sel));
    });

    const canvasNodes = player
        ? queryAllDeep("canvas", player).concat(Array.from(document.querySelectorAll("canvas")))
        : Array.from(document.querySelectorAll("canvas"));
    const canvases = canvasNodes.slice(0, 20).map((c) => {
        const brief = describeNativeSubNode(c);
        let inPlayer = false;
        if (player) {
            try {
                inPlayer = player.contains(c);
                if (!inPlayer) {
                    const root = c.getRootNode && c.getRootNode();
                    if (root && root.host) inPlayer = player.contains(root.host);
                }
            } catch (e) { /* ignore */ }
        }
        return Object.assign(brief, { inPlayer });
    });

    const ourOverlay = document.getElementById("my-cr-dual-sub-container");
    const ourText = document.getElementById("my-cr-dual-sub-text");
    const leakCandidates = hideNativeSubsEnabled ? collectHideNativeLeakCandidates() : [];

    const crBareShells = Array.from(
        document.querySelectorAll(".bitmovinplayer-container > div:not([class]):not([id])")
    ).filter((el) => !el.querySelector("video") && !isOurDualSubNode(el));
    const crBareShellHidden = crBareShells.length > 0
        && crBareShells.every((el) => {
            const st = window.getComputedStyle(el);
            return st.display === "none" || !isElementVisiblyShowing(el);
        });
    // Descendants with visibility:visible can paint through visibility:hidden ancestors
    let crBareShellLeak = null;
    for (const shell of crBareShells) {
        const leak = Array.from(shell.querySelectorAll("*")).find((el) => {
            if (isOurDualSubNode(el)) return false;
            return isElementVisiblyShowing(el);
        });
        if (leak) {
            crBareShellLeak = describeNativeSubNode(leak);
            break;
        }
    }

    // CR paints ASS in a bare Bitmovin child — DOM hide is the real signal.
    // Bitmovin subtitle.list() is often empty even while ASS is visible.
    let status = "disabled";
    if (!hideNativeSubsEnabled) {
        status = "disabled";
    } else if (!stylePresent) {
        status = "style_missing";
    } else if (liveKnownVisible.length) {
        status = "known_target_visible";
    } else if (crBareShellLeak) {
        status = "bare_shell_child_leak";
    } else if (mainDiag && mainDiag.suppressedCanvasOps > 0) {
        status = "ok";
    } else if (crBareShells.length && crBareShellHidden && !crBareShellLeak) {
        status = "ok";
    } else if (known.length && !liveKnownVisible.length) {
        status = "ok";
    } else if (leakCandidates.length) {
        status = "possible_leak";
    } else if (mainDiag && mainDiag.status === "api_ok") {
        status = "ok";
    } else if (mainDiag && mainDiag.status === "api_tracks_still_enabled") {
        status = "api_tracks_still_enabled";
    } else if (!player) {
        status = "waiting_player";
    } else if (crBareShells.length === 0 && known.length === 0) {
        status = "no_known_targets";
    } else {
        status = "ok";
    }

    const iframeCount = document.querySelectorAll("iframe").length;

    return {
        at: new Date().toISOString(),
        platform: IS_PRIME ? "prime" : "crunchyroll",
        host: location.hostname,
        path: location.pathname,
        enabled: hideNativeSubsEnabled,
        status,
        stylePresent,
        enforcerActive: !!(hideNativeSubsObserver || hideNativeSubsPollId),
        playerFound: !!player,
        playerTag: player
            ? `${player.tagName.toLowerCase()}${player.id ? "#" + player.id : ""}.${String(player.className || "").slice(0, 80)}`
            : null,
        crBareShellCount: crBareShells.length,
        crBareShellHidden,
        crBareShellLeak,
        knownTargetCount: known.length,
        knownVisibleCount: liveKnownVisible.length,
        knownVisible: liveKnownVisible.slice(0, 12),
        knownHiddenSample: known.filter((k) =>
            k.markedHidden || k.visibility === "hidden" || k.display === "none").slice(0, 8),
        leakCandidateCount: leakCandidates.length,
        leakCandidates: leakCandidates.slice(0, 12),
        canvases,
        iframeCount,
        mainWorld: mainDiag,
        hardSubs: (mainDiag && mainDiag.hardSubs) || null,
        ourOverlayVisible: !!(ourOverlay && isElementVisiblyShowing(ourOverlay)),
        ourOverlayTextSample: ourText
            ? String(ourText.innerText || "").replace(/\s+/g, " ").trim().slice(0, 100)
            : null
    };
}

function writeHideNativeDebug(force) {
    const now = Date.now();
    if (!force && now - lastHideNativeDebugWriteAt < 2000) return;
    const snap = collectHideNativeDiagnostics();
    if (!force
        && snap.status === lastHideNativeDebugStatus
        && now - lastHideNativeDebugWriteAt < 5000
        && snap.status !== "known_target_visible"
        && snap.status !== "possible_leak"
        && snap.status !== "style_missing") {
        return;
    }
    lastHideNativeDebugWriteAt = now;
    lastHideNativeDebugStatus = snap.status;
    try {
        chrome.storage.local.set({ lastDebugHideNative: snap });
    } catch (e) { /* ignore */ }
}

/** Hide site-native captions visually; keep tracks enabled so sources still load. */
function applyHideNativeSubs(enabled) {
    hideNativeSubsEnabled = !!enabled;
    syncHideNativeToMainWorld(hideNativeSubsEnabled);
    let style = document.getElementById(HIDE_NATIVE_SUBS_STYLE_ID);
    if (!enabled) {
        stopHideNativeSubsEnforcer();
        clearForcedNativeSubHides();
        if (style) style.remove();
        // CR hardSubs→clean sessions need a softsub sideload (MAIN) or a reload
        // for burned-in streams; give the player a beat then re-sweep clears.
        setTimeout(() => {
            clearForcedNativeSubHides();
            writeHideNativeDebug(true);
            const main = readMainWorldHideDiag();
            if (main && main.hardSubsRewrittenThisSession) {
                showToast(
                    chrome.i18n.getMessage("toast_cr_native_restore_hint")
                        || "CR: native softsubs restored if available. Burned-in stream needs episode reload with hide off.",
                    false
                );
            }
        }, 300);
        writeHideNativeDebug(true);
        return;
    }
    if (!style) {
        style = document.createElement("style");
        style.id = HIDE_NATIVE_SUBS_STYLE_ID;
        (document.head || document.documentElement).appendChild(style);
    }
    // CR custom ASS layer: bare div under .bitmovinplayer-container (no class/id).
    // MUST use display:none — visibility:hidden on the parent leaks when a child
    // sets visibility:visible (CR subtitle renderer does this).
    style.textContent = `
        .bitmovinplayer-container > div:not([class]):not([id]),
        .bitmovinplayer-container > div:not([class]):not([id]) * {
            display: none !important;
            visibility: hidden !important;
            opacity: 0 !important;
            pointer-events: none !important;
        }
        #velocity-canvas,
        canvas#velocity-canvas,
        canvas[id*="velocity" i],
        canvas[class*="velocity" i],
        canvas[id*="subtitle" i],
        canvas[class*="subtitle" i],
        canvas[class*="caption" i] {
            display: none !important;
            visibility: hidden !important;
            opacity: 0 !important;
            pointer-events: none !important;
        }
        .atvwebplayersdk-captions-text,
        .atvwebplayersdk-captions-overlay,
        .atvwebplayersdk-captions-container,
        [class*="atvwebplayersdk-captions"],
        .bmpui-ui-subtitle-overlay,
        .bmpui-ui-subtitle-label,
        .bmpui-subtitle-region-container,
        .bitmovinplayer-subtitle,
        .bitmovinplayer-container .bmpui-ui-subtitle-overlay,
        [class*="bmpui-ui-subtitle"],
        [class*="subtitle-overlay"],
        [class*="SubtitleOverlay"],
        [class*="subtitle"][class*="container"],
        [class*="subtitle"][class*="render"],
        [class*="subtitle"][class*="wrapper"],
        [class*="subtitle"][class*="display"],
        [class*="CaptionRenderer"],
        [class*="player-subtitles"],
        [data-testid*="subtitle"],
        [data-testid*="caption"],
        [class*="vilos"],
        .vjs-text-track-display {
            display: none !important;
            visibility: hidden !important;
            opacity: 0 !important;
            pointer-events: none !important;
        }
        video::cue,
        video::-webkit-media-text-track-display,
        video::-webkit-media-text-track-container {
            display: none !important;
            opacity: 0 !important;
            color: transparent !important;
        }
    `;
    startHideNativeSubsEnforcer();
    writeHideNativeDebug(true);
}

chrome.storage.local.get({ hideNativeSubs: false }, (items) => {
    applyHideNativeSubs(!!items.hideNativeSubs);
});
if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes.hideNativeSubs) return;
        applyHideNativeSubs(!!changes.hideNativeSubs.newValue);
    });
}
document.documentElement.addEventListener("cr-dual-subs-hide-diag", () => {
    if (hideNativeSubsEnabled) writeHideNativeDebug(true);
});

// Cue-index keyed caches: same English text can need different translations by scene
const translationByCue = {};
const streamingByCue = {};
const PRELOAD_AHEAD_SEC = 240; // ~4 minutes — avoid translating the whole episode up front
const CONTEXT_LINES = 5;
let consecutiveErrors = 0;

let activeEpisodeSession = {
    id: 1,
    trackUrl: "",
    isCancelled: false
};

function resetSubtitlePipeline() {
    activeEpisodeSession.isCancelled = true;
    activeEpisodeSession = {
        id: Date.now() + Math.random(),
        trackUrl: "",
        isCancelled: false
    };

    Object.keys(translationByCue).forEach((k) => delete translationByCue[k]);
    Object.keys(streamingByCue).forEach((k) => delete streamingByCue[k]);
    consecutiveErrors = 0;

    const textEl = document.getElementById("my-cr-dual-sub-text");
    if (textEl) {
        textEl.innerHTML = "";
        textEl.style.setProperty("display", "none", "important");
    }

    document.querySelectorAll("video").forEach((v) => {
        if (v._dualSubListener) {
            v.removeEventListener("timeupdate", v._dualSubListener);
            delete v._dualSubListener;
        }
    });
}

function logDual(...args) {
    console.log("[CR Bilingual Subtitles]", ...args);
}

/** Persist a compact playback/pipeline snapshot for the debug page (no subtitle body text). */
function writePlaybackDebug(partial) {
    const entry = Object.assign({
        at: new Date().toISOString(),
        platform: IS_PRIME ? "prime" : "crunchyroll",
        host: location.hostname,
        path: location.pathname
    }, partial || {});
    try {
        chrome.storage.local.set({ lastDebugPlayback: entry });
    } catch (e) {
        /* ignore */
    }
}

function redactDebugUrl(url) {
    if (!url) return "";
    try {
        const u = new URL(String(url), location.href);
        return `${u.origin}${u.pathname}`;
    } catch (e) {
        return String(url).split("?")[0].slice(0, 160);
    }
}

function handleSubtitlePayload(detail, via) {
    if (!detail) return;
    let parsed = detail;
    try {
        if (typeof detail === "string") parsed = JSON.parse(detail);
    } catch (e) {
        logDual("payload JSON parse failed via", via, e);
        return;
    }
    if (parsed && !parsed.url && !parsed.data) {
        parsed = { url: "", options: {}, data: { subtitles: parsed } };
    }
    if (!parsed || !parsed.data) {
        logDual("payload missing data via", via);
        return;
    }

    if (parsed.url && parsed.url === lastProcessedUrl) {
        logDual("duplicate playback url ignored");
        return;
    }
    if (parsed.url) lastProcessedUrl = parsed.url;
    latestSubtitleDetail = parsed;

    // New episode / stream: invalidate previous in-flight work and caches
    resetSubtitlePipeline();
    if (parsed.url) lastProcessedUrl = parsed.url;

    logDual("payload received via", via, {
        subs: parsed.data.subtitles ? Object.keys(parsed.data.subtitles) : [],
        caps: parsed.data.captions ? Object.keys(parsed.data.captions) : []
    });
    writePlaybackDebug({
        event: "manifest_received",
        via,
        url: redactDebugUrl(parsed.url),
        subLocales: parsed.data.subtitles ? Object.keys(parsed.data.subtitles) : [],
        captionLocales: parsed.data.captions ? Object.keys(parsed.data.captions) : []
    });

    chrome.storage.local.get(DEFAULT_SETTINGS, (settings) => {
        if (chrome.runtime.lastError) {
            logDual("storage error", chrome.runtime.lastError.message);
            showToast("Storage error: " + chrome.runtime.lastError.message, true);
            return;
        }
        logDual("settings", {
            lang: settings.secondLang,
            mode: settings.transMode,
            engine: settings.transEngine,
            model: settings.aiModel,
            hasKey: !!settings.apiKey
        });
        if (settings.secondLang !== "none") initDualSubs(parsed, settings);
        else removeExistingSubtitles();
    });
}

function readDomBridgePayload() {
    const raw = document.documentElement.getAttribute("data-cr-dual-subs");
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
}

function readPrimeDomBridgePayload() {
    const raw = document.documentElement.getAttribute("data-pv-dual-subs");
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
}

function handlePrimeSubtitlePayload(detail, via) {
    if (!detail) return;
    let parsed = detail;
    try {
        if (typeof detail === "string") parsed = JSON.parse(detail);
    } catch (e) {
        logDual("prime payload JSON parse failed via", via, e);
        return;
    }
    if (!parsed || !parsed.text) {
        logDual("prime payload missing text via", via);
        return;
    }
    if (parsed.url && parsed.url === lastProcessedUrl) {
        logDual("duplicate prime ttml url ignored");
        return;
    }
    if (parsed.url) lastProcessedUrl = parsed.url;

    resetSubtitlePipeline();
    if (parsed.url) lastProcessedUrl = parsed.url;

    logDual("prime TTML received via", via, {
        url: (parsed.url || "").slice(0, 120),
        bytes: parsed.text.length
    });
    writePlaybackDebug({
        event: "ttml_received",
        via,
        url: redactDebugUrl(parsed.url),
        bytes: parsed.text.length,
        sampleHead: String(parsed.text).replace(/\s+/g, " ").slice(0, 120)
    });

    chrome.storage.local.get(DEFAULT_SETTINGS, (settings) => {
        if (chrome.runtime.lastError) {
            logDual("storage error", chrome.runtime.lastError.message);
            showToast("Storage error: " + chrome.runtime.lastError.message, true);
            writePlaybackDebug({ event: "storage_error", error: chrome.runtime.lastError.message });
            return;
        }
        if (settings.secondLang === "none") {
            removeExistingSubtitles();
            writePlaybackDebug({ event: "disabled", secondLang: "none" });
            return;
        }
        initPrimeDualSubs(parsed, settings);
    });
}

let lastProcessedUrl = "";
let latestSubtitleDetail = null;
logDual(IS_PRIME ? "content script ready (Prime)" : "content script ready");

// Instant clear on episode navigation clicks
document.addEventListener("click", (e) => {
    const isEpisodeNav = e.target.closest('[data-testid="next-episode-button"]') ||
        e.target.closest(".erc-prev-next-episode") ||
        e.target.closest('a[href*="/watch/"]') ||
        e.target.closest('[data-t="see-more-episodes-btn"]') ||
        e.target.closest('[data-testid*="next-episode" i]') ||
        e.target.closest('a[href*="/detail/"]') ||
        e.target.closest('a[href*="/gp/video/"]');
    if (isEpisodeNav) {
        lastProcessedUrl = "";
        resetSubtitlePipeline();
    }
}, true);

let currentPathname = location.pathname;
const checkPathChange = () => {
    if (location.pathname !== currentPathname) {
        currentPathname = location.pathname;
        lastProcessedUrl = "";
        resetSubtitlePipeline();
    }
};
window.addEventListener("popstate", checkPathChange);
window.addEventListener("hashchange", checkPathChange);
setInterval(checkPathChange, 500);

/** True when DOM/postMessage bridge stripped Authorization / playback token. */
function isRedactedCrBridgePayload(payload) {
    if (!payload) return false;
    if (payload.data && payload.data.token === "[redacted]") return true;
    const headers = (payload.options && payload.options.headers) || {};
    return Object.keys(headers).some((key) =>
        /authorization/i.test(key) && String(headers[key]).toLowerCase() === "[redacted]"
    );
}

// Prefer CustomEvent.detail (full headers). Attribute / postMessage are redacted backups.
document.documentElement.addEventListener("cr-dual-subs-ready", (event) => {
    const fromDetail = event.detail;
    if (fromDetail && fromDetail.data && !isRedactedCrBridgePayload(fromDetail)) {
        handleSubtitlePayload(fromDetail, "dom-event");
        return;
    }
    const payload = readDomBridgePayload();
    if (payload && !isRedactedCrBridgePayload(payload)) {
        handleSubtitlePayload(payload, "dom-event");
    }
});

document.documentElement.addEventListener("pv-dual-subs-ready", () => {
    const payload = readPrimeDomBridgePayload();
    if (payload) handlePrimeSubtitlePayload(payload, "dom-event");
});

// Poll briefly in case the event fired before listener attach (rare)
(function pollDomBridge() {
    let tries = 0;
    const id = setInterval(() => {
        tries++;
        const payload = readDomBridgePayload();
        // Skip redacted attr — ASS fetch needs Authorization from CustomEvent.detail.
        if (payload && payload.url && payload.url !== lastProcessedUrl && !isRedactedCrBridgePayload(payload)) {
            handleSubtitlePayload(payload, "dom-poll");
        }
        const primePayload = readPrimeDomBridgePayload();
        if (primePayload && primePayload.url && primePayload.url !== lastProcessedUrl) {
            handlePrimeSubtitlePayload(primePayload, "dom-poll");
        }
        if (tries >= 40) clearInterval(id); // ~20s
    }, 500);
})();

// postMessage backup (CR payload is redacted — ignore when secrets stripped)
window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data) return;
    if (data.source === "CR_DUAL_SUBS" && data.type === "CR_SUBTITLE_DATA") {
        if (!isRedactedCrBridgePayload(data.payload)) {
            handleSubtitlePayload(data.payload, "postMessage");
        }
        return;
    }
    if (data.source === "PV_DUAL_SUBS" && data.type === "PV_SUBTITLE_DATA") {
        handlePrimeSubtitlePayload(data.payload, "postMessage");
    }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action !== "download_english_subtitle") return;

    const data = latestSubtitleDetail && latestSubtitleDetail.data;
    const englishTrack = data ? findTrackInManifest(data, "en-US", true) : null;
    if (!englishTrack) {
        sendResponse({ success: false, error: chrome.i18n.getMessage("download_english_unavailable") || "English subtitle unavailable" });
        return;
    }

    fetch(englishTrack.url)
        .then((response) => {
            if (!response.ok) throw new Error("Subtitle request failed");
            return response.text();
        })
        .then((subtitleText) => {
            const blob = new Blob([subtitleText], { type: "text/vtt;charset=utf-8" });
            const downloadUrl = URL.createObjectURL(blob);
            const link = document.createElement("a");
            const episodeName = document.title.replace(/[\\/:*?"<>|]/g, "").trim() || "crunchyroll-episode";
            link.href = downloadUrl;
            link.download = `${episodeName}-en-US.vtt`;
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
            sendResponse({ success: true });
        })
        .catch(() => sendResponse({
            success: false,
            error: chrome.i18n.getMessage("download_english_failed") || "English subtitle download failed"
        }));

    return true;
});

/** Prime detail pages leave a ~50px collapsed <video>; ignore those. */
function isPrimePlayerSized(video) {
    if (!video) return false;
    const r = video.getBoundingClientRect();
    const minH = Math.max(240, Math.floor(window.innerHeight * 0.28));
    const minW = Math.max(400, Math.floor(window.innerWidth * 0.35));
    return r.width >= minW && r.height >= minH
        && r.bottom > 40 && r.top < window.innerHeight - 40;
}

function findPrimaryVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    if (!videos.length) return null;

    if (IS_PRIME) {
        const playerSized = videos.filter(isPrimePlayerSized);
        if (playerSized.length) {
            const playing = playerSized.find((v) => !v.paused && v.readyState >= 2);
            if (playing) return playing;
            return playerSized.slice().sort((a, b) => {
                const ar = a.getBoundingClientRect();
                const br = b.getBoundingClientRect();
                return (br.width * br.height) - (ar.width * ar.height);
            })[0];
        }
        // No real player yet (detail page / play transition) — do not fall back to 50px stubs
        return null;
    }

    const visible = videos.filter((v) => {
        const r = v.getBoundingClientRect();
        return r.width >= 160 && r.height >= 90;
    });
    const pool = visible.length ? visible : videos;
    const playing = pool.find((v) => !v.paused && v.readyState >= 2);
    if (playing) return playing;
    return pool.slice().sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (br.width * br.height) - (ar.width * ar.height);
    })[0];
}

function hidePrimeOverlay(subContainer) {
    if (subContainer) subContainer.style.setProperty("display", "none", "important");
    const controls = document.getElementById("cr-inplayer-controls-wrapper");
    if (controls) controls.style.setProperty("display", "none", "important");
}

function showPrimeOverlayHost(subContainer) {
    if (subContainer) subContainer.style.setProperty("display", "flex", "important");
    const controls = document.getElementById("cr-inplayer-controls-wrapper");
    if (controls) controls.style.setProperty("display", "block", "important");
}

function elementArea(el) {
    if (!el || !el.getBoundingClientRect) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, r.width) * Math.max(0, r.height);
}

function findPlayerContainer(video) {
    const v = video || findPrimaryVideo();
    if (!v) return document.body;

    const vr = v.getBoundingClientRect();
    // Never pick Amazon page wrappers (often 4000px+ tall) — stay near the video box.
    const maxH = Math.max(vr.height * 1.45, Math.min(window.innerHeight * 1.2, vr.height + 240));
    const maxW = Math.max(vr.width * 1.45, window.innerWidth * 1.2);

    const known = v.closest(".webPlayerUIContainer")
        || v.closest("[class*='webPlayerUIContainer']")
        || v.closest(".bitmovinplayer-container")
        || v.closest(".atvwebplayersdk-player-container")
        || document.getElementById("player-container");
    if (known) {
        const r = known.getBoundingClientRect();
        if (r.width >= vr.width * 0.8 && r.height >= vr.height * 0.8
            && r.height <= maxH && r.width <= maxW) {
            return known;
        }
    }

    // Largest ancestor that still covers the video but is not page-sized
    let best = v.parentElement || document.body;
    let el = v.parentElement;
    for (let i = 0; i < 16 && el && el !== document.documentElement; i++) {
        const r = el.getBoundingClientRect();
        const covers = r.width + 4 >= vr.width && r.height + 4 >= vr.height;
        const bounded = r.height <= maxH && r.width <= maxW;
        if (covers && bounded) best = el;
        else if (covers && !bounded) break;
        el = el.parentElement;
    }
    return best;
}

/** Shared Prime vertical position (% from video bottom) — slider + poll must use the same value. */
let primeOverlayBottomPct = 18;

function getPrimeBottomPct(explicit) {
    const n = Number(explicit);
    if (Number.isFinite(n)) return Math.min(Math.max(n, 0), 80);
    if (Number.isFinite(primeOverlayBottomPct)) return Math.min(Math.max(primeOverlayBottomPct, 0), 80);
    return 18;
}

function setPrimeBottomPct(value) {
    primeOverlayBottomPct = getPrimeBottomPct(value);
    return primeOverlayBottomPct;
}

/** Pin Prime overlay to the visible <video> box (fixed), avoiding page-tall wrappers. */
function syncPrimeOverlayToVideo(subContainer, video, bottomPct) {
    if (!subContainer) return null;
    const live = video && isPrimePlayerSized(video) ? video : findPrimaryVideo();
    if (!live || !isPrimePlayerSized(live)) {
        hidePrimeOverlay(subContainer);
        return { hidden: true, reason: "no_player_sized_video" };
    }
    const r = live.getBoundingClientRect();
    const pct = getPrimeBottomPct(bottomPct);
    const bottomFrac = pct / 100;
    const bottomPx = Math.max(8, (window.innerHeight - r.bottom) + (r.height * bottomFrac));
    showPrimeOverlayHost(subContainer);
    subContainer.style.setProperty("position", "fixed", "important");
    subContainer.style.setProperty("left", `${Math.round(r.left)}px`, "important");
    subContainer.style.setProperty("width", `${Math.round(r.width)}px`, "important");
    subContainer.style.setProperty("top", "auto", "important");
    subContainer.style.setProperty("bottom", `${Math.round(bottomPx)}px`, "important");
    subContainer.style.setProperty("z-index", "2147483646", "important");
    subContainer.style.setProperty("--cr-sub-top", "auto");
    subContainer.style.setProperty("--cr-sub-left", "0");
    subContainer.style.setProperty("--cr-sub-width", "100%");
    subContainer.style.setProperty("--cr-sub-bottom", "0");
    return {
        hidden: false,
        videoTop: Math.round(r.top),
        videoBottom: Math.round(r.bottom),
        videoW: Math.round(r.width),
        videoH: Math.round(r.height),
        fixedBottomPx: Math.round(bottomPx),
        bottomPct: pct
    };
}

function describeOverlayLayout(playerContainer) {
    const sub = document.getElementById("my-cr-dual-sub-container");
    const text = document.getElementById("my-cr-dual-sub-text");
    const video = findPrimaryVideo();
    const cRect = playerContainer ? playerContainer.getBoundingClientRect() : null;
    const sRect = sub ? sub.getBoundingClientRect() : null;
    const vRect = video ? video.getBoundingClientRect() : null;
    const tRect = text && getComputedStyle(text).display !== "none"
        ? text.getBoundingClientRect()
        : null;

    const suspiciousTopLeft = !!(tRect && vRect
        && tRect.top < vRect.top + 80
        && tRect.left < vRect.left + 80
        && tRect.height < 120);

    const containerTooSmall = !!(cRect && (cRect.width < 320 || cRect.height < 180));
    const containerHugeVsVideo = !!(cRect && vRect && vRect.height >= 240 && cRect.height > vRect.height * 1.6);
    const videoTooSmall = !!(vRect && vRect.height > 0 && vRect.height < 240);
    const noPlayerVideo = !vRect;
    const textOffVideo = !!(tRect && vRect && vRect.height >= 240
        && (tRect.bottom < vRect.top - 4 || tRect.top > vRect.bottom + 4));
    const textOffscreen = !!(tRect
        && (tRect.top > window.innerHeight || tRect.bottom < 0
            || tRect.left > window.innerWidth || tRect.right < 0));

    return {
        container: playerContainer
            ? String(playerContainer.className || playerContainer.id || playerContainer.tagName).slice(0, 120)
            : null,
        containerW: cRect ? Math.round(cRect.width) : null,
        containerH: cRect ? Math.round(cRect.height) : null,
        videoW: vRect ? Math.round(vRect.width) : null,
        videoH: vRect ? Math.round(vRect.height) : null,
        videoTop: vRect ? Math.round(vRect.top) : null,
        overlayTop: sRect ? Math.round(sRect.top) : null,
        overlayLeft: sRect ? Math.round(sRect.left) : null,
        overlayW: sRect ? Math.round(sRect.width) : null,
        overlayH: sRect ? Math.round(sRect.height) : null,
        textTop: tRect ? Math.round(tRect.top) : null,
        textLeft: tRect ? Math.round(tRect.left) : null,
        textVisible: !!(text && text.style.display !== "none" && text.innerHTML),
        cssBottom: sub ? sub.style.getPropertyValue("--cr-sub-bottom") || null : null,
        cssTop: sub ? sub.style.getPropertyValue("--cr-sub-top") || null : null,
        suspiciousTopLeft,
        containerTooSmall,
        containerHugeVsVideo,
        videoTooSmall,
        noPlayerVideo,
        textOffVideo,
        textOffscreen
    };
}

function layoutLooksBad(layout) {
    return !!(layout && (
        layout.suspiciousTopLeft
        || layout.containerTooSmall
        || layout.containerHugeVsVideo
        || layout.videoTooSmall
        || layout.noPlayerVideo
        || layout.textOffVideo
        || layout.textOffscreen
    ));
}

function showToast(message, isError = true) {
    let toast = document.getElementById('cr-dual-sub-toast');
    if (toast) toast.remove();
    toast = document.createElement('div');
    toast.id = 'cr-dual-sub-toast';
    const pos = IS_PRIME
        ? "position:fixed; top:20px; left:20px;"
        : "position:absolute; top:20px; left:20px;";
    toast.style.cssText = `${pos} background:${isError ? 'rgba(220, 53, 69, 0.9)' : 'rgba(40, 167, 69, 0.9)'}; color:white; padding:10px 15px; border-radius:6px; z-index:2147483647; font-weight:bold; font-family:sans-serif; pointer-events:none; box-shadow:0 4px 6px rgba(0,0,0,0.3); max-width:420px;`;
    toast.innerText = message;
    const container = IS_PRIME ? document.body : findPlayerContainer();
    container.appendChild(toast);
    setTimeout(() => { if (toast) toast.remove(); }, 8000);
}

async function initPrimeDualSubs(detail, settings) {
    const { transMode } = settings;
    // Prime exposes the active timed-text file (usually English when EN captions are on).
    // Official target-lang track discovery is not available the CR way — AI from captured TTML.
    if (transMode === "native") {
        showToast(chrome.i18n.getMessage("toast_no_official_subs") || "Official-only mode is not supported on Prime Video yet.", true);
        writePlaybackDebug({ event: "native_unsupported", transMode });
        return;
    }

    const trackKey = detail.url || ("ttml:" + detail.text.length);
    if (trackKey !== activeEpisodeSession.trackUrl) {
        activeEpisodeSession.trackUrl = trackKey;
    }

    try {
        const parsedSubs = parseTTML(detail.text);
        if (parsedSubs.length === 0) {
            showToast(chrome.i18n.getMessage("toast_no_dialogue"), true);
            writePlaybackDebug({
                event: "parse_empty",
                url: redactDebugUrl(detail.url),
                bytes: (detail.text || "").length,
                sampleHead: String(detail.text || "").replace(/\s+/g, " ").slice(0, 160)
            });
            return;
        }
        const v = findPrimaryVideo();
        const first = parsedSubs[0];
        const last = parsedSubs[parsedSubs.length - 1];
        logDual("prime cues ready", {
            count: parsedSubs.length,
            first: first && { start: first.start, end: first.end, text: first.text.slice(0, 60) },
            last: last && { start: last.start, end: last.end },
            videoTime: v ? v.currentTime : null
        });
        writePlaybackDebug({
            event: "cues_ready",
            url: redactDebugUrl(detail.url),
            cueCount: parsedSubs.length,
            firstStart: first ? first.start : null,
            firstEnd: first ? first.end : null,
            firstText: first ? first.text.slice(0, 80) : null,
            lastStart: last ? last.start : null,
            lastEnd: last ? last.end : null,
            videoTime: v ? Math.round(v.currentTime * 100) / 100 : null,
            videoPaused: v ? v.paused : null,
            transMode: settings.transMode,
            secondLang: settings.secondLang,
            engine: settings.transEngine,
            overlayAttached: false
        });
        renderSubtitlesOnVideo(parsedSubs, true, settings);
        const engineLabel = settings.transEngine === "custom_llm" ? (settings.aiModel || "AI") : "Google";
        const loadedMsg = (chrome.i18n.getMessage("toast_loaded") || "Loaded [ENGINE]!").replace("[ENGINE]", engineLabel);
        showToast(
            `${loadedMsg} (${parsedSubs.length} cues)`
                + (settings.transEngine === "custom_llm" && !settings.apiKey ? " (no API key!)" : ""),
            settings.transEngine === "custom_llm" && !settings.apiKey
        );
        if (settings.transEngine === "custom_llm" && !settings.apiKey) {
            console.warn("[CR Bilingual Subtitles] AI mode active but API key is empty");
        }
    } catch (e) {
        logDual("prime TTML init failed", e);
        writePlaybackDebug({ event: "parse_error", error: String(e && e.message || e) });
        showToast(chrome.i18n.getMessage("toast_parse_failed") || "Failed to parse subtitles", true);
    }
}

function findTrackInManifest(data, lang, preferCaptions = false) {
    const fuzzyLang = lang.split('-')[0]; 
    const checkSubtitles = () => {
        if (data.subtitles) {
            if (data.subtitles[lang] && data.subtitles[lang].url) return { url: data.subtitles[lang].url, format: data.subtitles[lang].format || 'ass' };
            const subKey = Object.keys(data.subtitles).find(k => k.startsWith(fuzzyLang) && data.subtitles[k].url);
            if (subKey) return { url: data.subtitles[subKey].url, format: data.subtitles[subKey].format || 'ass' };
        }
        return null;
    };
    const checkCaptions = () => {
        if (data.captions) {
            if (data.captions[lang] && data.captions[lang].url) return { url: data.captions[lang].url, format: data.captions[lang].format || 'vtt' };
            const capKey = Object.keys(data.captions).find(k => k.startsWith(fuzzyLang) && data.captions[k].url);
            if (capKey) return { url: data.captions[capKey].url, format: data.captions[capKey].format || 'vtt' };
        }
        return null;
    };
    return preferCaptions ? (checkCaptions() || checkSubtitles()) : (checkSubtitles() || checkCaptions());
}

async function initDualSubs(detail, settings) {
    const { secondLang: targetLang, transMode } = settings;
    const { url, options, data } = detail;
    let targetTrack = null;
    let useAI = false;
    let hasWaitedForCrossTrack = false; // ✨ 记录是否已经为防抢占做过延迟

    const findCrossTrack = async (lang, preferCaptions = false, targetAudioLocale = null) => {
        const versions = data.versions ||[];
        let targetVersion = null;
        
        if (targetAudioLocale === 'original') {
            targetVersion = versions.find(v => v.original === true);
        } else if (targetAudioLocale) {
            targetVersion = versions.find(v => v.audio_locale === targetAudioLocale);
        }
        
        if (!targetVersion) {
            targetVersion = versions.find(v => v.original === true) || versions.find(v => v.audio_locale === 'ja-JP');
        }
        if (!targetVersion || !targetVersion.guid || !url) return null;
        
        const currentGuidMatch = url.match(/\/v3\/([^\/]+)\//);
        if (currentGuidMatch && currentGuidMatch[1] === targetVersion.guid) {
            return findTrackInManifest(data, lang, preferCaptions);
        }

        // ✨ 核心修复：防抢占竞态！如果是首次执行跨轨，强制休眠 2.5 秒，让主视频先稳定加载画面和 Token，避免被顶号
        if (!hasWaitedForCrossTrack) {
            hasWaitedForCrossTrack = true;
            await new Promise(r => setTimeout(r, 2500));
        }

        const newUrl = url.replace(/\/v3\/[^\/]+\//, `/v3/${targetVersion.guid}/`);
        const fetchUrl = newUrl.includes('?') ? newUrl + '&cr_cross_track=1' : newUrl + '?cr_cross_track=1';
        
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
            const safeHeaders = new Headers(options.headers || {});
            
            const res = await fetch(fetchUrl, { headers: safeHeaders, signal: controller.signal });
            clearTimeout(timeout);
            if (!res.ok) return null; 
            
            const originalData = await res.json();

            // 阅后即焚，销毁并发后台 Token
            if (originalData.assetId && originalData.token) {
                const deleteUrl = `https://www.crunchyroll.com/playback/v1/token/${originalData.assetId}/${originalData.token}`;
                fetch(deleteUrl, { method: 'DELETE', headers: safeHeaders }).catch(()=>{});
            }

            return findTrackInManifest(originalData, lang, preferCaptions);
        } catch (e) { return null; }
    };

    if (transMode !== 'force_ai') {
        targetTrack = findTrackInManifest(data, targetLang, false);
        if (!targetTrack) targetTrack = await findCrossTrack(targetLang, false, 'original'); 
        if (!targetTrack) targetTrack = await findCrossTrack(targetLang, false, 'ja-JP');
    }

    if (!targetTrack && (transMode === 'fallback' || transMode === 'force_ai')) {
        useAI = true;
        targetTrack = findTrackInManifest(data, 'en-US', true); 

        if (!targetTrack) targetTrack = await findCrossTrack('en-US', true, 'en-US'); 
        if (!targetTrack) targetTrack = await findCrossTrack('en-US', true, 'original'); 
        if (!targetTrack) targetTrack = await findCrossTrack('en-US', true, 'ja-JP'); 
    }

    if (!targetTrack) {
        showToast(transMode === 'native' ? chrome.i18n.getMessage("toast_no_official_subs") : chrome.i18n.getMessage("toast_parse_failed"));
        return;
    }

    if (targetTrack.url !== activeEpisodeSession.trackUrl) {
        activeEpisodeSession.trackUrl = targetTrack.url;
    }

    try {
        const response = await fetch(targetTrack.url);
        const subText = await response.text();
        let parsedSubs = targetTrack.format === 'vtt' ? parseVTT(subText) : parseASS(subText);
        if (parsedSubs.length === 0) return showToast(chrome.i18n.getMessage("toast_no_dialogue"), true);
        writePlaybackDebug({
            event: "cues_ready",
            url: redactDebugUrl(targetTrack.url),
            cueCount: parsedSubs.length,
            firstStart: parsedSubs[0].start,
            lastEnd: parsedSubs[parsedSubs.length - 1].end,
            useAI: !!useAI,
            format: targetTrack.format || null,
            overlayAttached: false
        });
        renderSubtitlesOnVideo(parsedSubs, useAI, settings);
        const engineLabel = useAI
            ? (settings.transEngine === "custom_llm" ? (settings.aiModel || "AI") : "Google")
            : "Official";
        const loadedMsg = (chrome.i18n.getMessage("toast_loaded") || "Loaded [ENGINE]!").replace("[ENGINE]", engineLabel);
        showToast(loadedMsg + (useAI && !settings.apiKey && settings.transEngine === "custom_llm" ? " (no API key!)" : ""), useAI && settings.transEngine === "custom_llm" && !settings.apiKey);
        if (useAI && settings.transEngine === "custom_llm" && !settings.apiKey) {
            console.warn("[CR Bilingual Subtitles] AI mode active but API key is empty");
        }
    } catch (e) { showToast(chrome.i18n.getMessage("toast_download_failed")); }
}

function describeTranslationFailure(rawMessage) {
    const msg = String(rawMessage || "").trim();
    const lower = msg.toLowerCase();

    if (!msg) return "A fordítási kérés sikertelen volt. Próbáld meg újra, vagy válassz egy másik modellt.";
    if (lower.includes("api-kulcs") || lower.includes("unauthorized") || lower.includes("forbidden") || lower.includes("401") || lower.includes("403")) {
        return "Az API-kulcs nem működik vagy nem engedélyezett. Ellenőrizd a kulcsot és a provider beállításait. Ha a kulcs jó, érdemes másik modellt próbálni.";
    }
    if (lower.includes("rate limit") || lower.includes("429") || lower.includes("too many requests")) {
        return "A szolgáltató túl sok kérés miatt ideiglenesen elutasította a fordítást. Kérlek várj egy kicsit, vagy próbálj ki egy stabilabb, olcsóbb modellt.";
    }
    if (lower.includes("json") || lower.includes("malformed") || lower.includes("alignment failed") || lower.includes("escaped character")) {
        return "A modell nem adta vissza a várt JSON formátumot. Ez általában a modell válaszának formátumából adódik. Javaslat: próbálj ki egy stabilabb modellt, például OpenAI gpt-4o-mini vagy Gemini 2.5 flash-lite.";
    }
    if (lower.includes("http 400") || lower.includes("unsupported") || lower.includes("temperature") || lower.includes("max_tokens") || lower.includes("max_completion_tokens")) {
        return "A modell nem tudja használni az aktuális paramétereket. Javaslat: válassz egy kompatibilisebb modellt.";
    }
    return "A fordítási modell nem tudott értelmes subtitle JSON-t adni vissza. Javaslat: próbálj ki egy másik modellt.";
}

async function fetchAIBatchTranslation(cues, settings, contextLines = []) {
    const linesArray = cues.map(c => c.text);
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({
            action: "translate_batch",
            lines: linesArray,
            contextLines,
            settings: settings
        }, (response) => {
            if (chrome.runtime.lastError) {
                consecutiveErrors++;
                resolve(linesArray.map(() => chrome.i18n.getMessage("toast_connection_lost")));
                return;
            }
            if (response && response.success) {
                consecutiveErrors = 0;
                response.data.forEach((translated, index) => {
                    const cue = cues[index];
                    if (cue) translationByCue[cue.index] = translated;
                });
                resolve(response.data);
            } else {
                consecutiveErrors++;
                const errDetail = (response && response.error) ? String(response.error) : "";
                showToast(describeTranslationFailure(errDetail), true);
                resolve(linesArray.map(() => chrome.i18n.getMessage("toast_translation_missing")));
            }
        });
    });
}

// ✨ 流式通道：打开长连接到 background，实时接收逐行(partial)与最终(done)翻译
// onPartial(translationsMap) / onDone(data, success, error)
function openTranslationStream(cues, settings, callbacks, contextLines = []) {
    const linesArray = cues.map(c => c.text);
    const { onPartial, onDone } = callbacks;
    const port = chrome.runtime.connect({ name: 'translate_stream' });
    let settled = false;
    const finish = (data, success, error) => {
        if (settled) return;
        settled = true;
        try { port.disconnect(); } catch (e) {}
        if (onDone) onDone(data, success, error);
    };
    port.onMessage.addListener((msg) => {
        if (!msg) return;
        if (msg.type === 'partial') {
            if (onPartial) onPartial(msg.translations || {});
        } else if (msg.type === 'done') {
            finish(msg.translations, msg.success, msg.error);
        }
    });
    port.onDisconnect.addListener(() => finish(null, false, "stream disconnected"));
    port.postMessage({ action: 'translate_stream', lines: linesArray, contextLines, settings });
    return port;
}

function parseVTT(vttText) {
    const lines = vttText.split(/\r?\n/); const result =[]; let i = 0;
    const timeToSeconds = (timeStr) => {
        const parts = timeStr.trim().split(':'); let secs = 0;
        if (parts.length === 3) secs = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
        else if (parts.length === 2) secs = parseInt(parts[0]) * 60 + parseFloat(parts[1]);
        return secs;
    };
    while (i < lines.length) {
        const line = lines[i].trim();
        if (line.includes('-->')) {
            const times = line.split('-->');
            const start = timeToSeconds(times[0]); const end = timeToSeconds(times[1].trim().split(' ')[0]); 
            let text = ""; i++;
            while (i < lines.length && lines[i].trim() !== '') {
                let cleanLine = lines[i].replace(/<[^>]+>/g, '').trim();
                if (cleanLine) text += (text ? '\n' : '') + cleanLine;
                i++;
            }
            if (text) result.push({ start, end, text, index: result.length });
        } else i++;
    }
    return result;
}

function parseASS(assText) {
    const lines = assText.split(/\r?\n/); const result =[];
    const timeToSeconds = (timeStr) => {
        if (!timeStr) return 0; const parts = timeStr.split(':');
        return (parseFloat(parts[0]) || 0) * 3600 + (parseFloat(parts[1]) || 0) * 60 + (parseFloat(parts[2]) || 0);
    };
    for (const line of lines) {
        if (!line.startsWith('Dialogue:')) continue;
        const parts = line.split(','); if (parts.length < 10) continue;
        const cleanText = parts.slice(9).join(',').replace(/\{[^}]+\}/g, '').replace(/\\N/g, '\n').trim();
        if (cleanText) result.push({ start: timeToSeconds(parts[1]), end: timeToSeconds(parts[2]), text: cleanText, index: result.length });
    }
    return result;
}

function ttmlGetParam(root, localName) {
    if (!root) return null;
    return root.getAttribute(localName)
        || root.getAttribute("ttp:" + localName)
        || root.getAttributeNS("http://www.w3.org/ns/ttml#parameter", localName)
        || root.getAttributeNS("http://www.w3.org/2006/10/ttaf1#parameter", localName);
}

/** Parse Amazon / W3C TTML (and DFXP-like) timed text into cue objects. */
function parseTTML(ttmlText) {
    const result = [];
    if (!ttmlText || typeof ttmlText !== "string") return result;

    let doc;
    try {
        doc = new DOMParser().parseFromString(ttmlText, "application/xml");
    } catch (e) {
        return parseTTMLRegexFallback(ttmlText);
    }
    if (!doc || doc.querySelector("parsererror")) {
        return parseTTMLRegexFallback(ttmlText);
    }

    const root = doc.documentElement;
    const frameRate = Math.max(1, parseFloat(ttmlGetParam(root, "frameRate") || "25") || 25);
    const tickRate = Math.max(1, parseFloat(ttmlGetParam(root, "tickRate") || "1") || 1);
    const subFrameRate = Math.max(1, parseFloat(ttmlGetParam(root, "subFrameRate") || "1") || 1);

    const timeToSeconds = (raw) => {
        if (raw == null) return null;
        const timeStr = String(raw).trim();
        if (!timeStr) return null;

        // ticks: 12345678t  (Prime/Amazon often uses this)
        const ticks = timeStr.match(/^(\d+(?:\.\d+)?)t$/i);
        if (ticks) return parseFloat(ticks[1]) / tickRate;

        const offset = timeStr.match(/^(\d+(?:\.\d+)?)(h|m|s|ms|f)$/i);
        if (offset) {
            const n = parseFloat(offset[1]);
            const unit = offset[2].toLowerCase();
            if (unit === "h") return n * 3600;
            if (unit === "m") return n * 60;
            if (unit === "s") return n;
            if (unit === "ms") return n / 1000;
            if (unit === "f") return n / frameRate;
        }

        // HH:MM:SS.mmm (clock with fraction)
        if (/^\d+:\d{2}:\d{2}\.\d+$/.test(timeStr)) {
            const parts = timeStr.split(":");
            return (parseInt(parts[0], 10) * 3600)
                + (parseInt(parts[1], 10) * 60)
                + parseFloat(parts[2]);
        }

        // HH:MM:SS:FF(.subframes)
        if (/^\d+:\d{2}:\d{2}:\d{1,2}(?:\.\d+)?$/.test(timeStr)) {
            const parts = timeStr.split(":");
            const frames = parseFloat(parts[3]);
            return (parseInt(parts[0], 10) * 3600)
                + (parseInt(parts[1], 10) * 60)
                + parseInt(parts[2], 10)
                + (frames / frameRate / subFrameRate);
        }

        // HH:MM:SS
        if (/^\d+:\d{2}:\d{2}$/.test(timeStr)) {
            const parts = timeStr.split(":").map((p) => parseInt(p, 10));
            return parts[0] * 3600 + parts[1] * 60 + parts[2];
        }

        // bare number — only accept small values (seconds), avoid misreading tick strings
        if (/^\d+(?:\.\d+)?$/.test(timeStr)) {
            const asNum = parseFloat(timeStr);
            return Number.isFinite(asNum) ? asNum : null;
        }
        return null;
    };

    const cueText = (el) => {
        const clone = el.cloneNode(true);
        clone.querySelectorAll("br").forEach((br) => br.replaceWith(document.createTextNode("\n")));
        return (clone.textContent || "")
            .replace(/\u00a0/g, " ")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n[ \t]+/g, "\n")
            .replace(/[ \t]{2,}/g, " ")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    };

    const pushCue = (beginRaw, endRaw, durRaw, text) => {
        const start = timeToSeconds(beginRaw);
        let endSec = timeToSeconds(endRaw);
        if (endSec == null && durRaw != null && start != null) {
            const dur = timeToSeconds(durRaw);
            if (dur != null) endSec = start + dur;
        }
        if (start == null || endSec == null || endSec <= start || !text) return;
        result.push({ start, end: endSec, text, index: result.length });
    };

    const seen = new Set();
    const timed = Array.from(doc.getElementsByTagName("*")).filter((el) => {
        const tag = el.tagName && el.tagName.toLowerCase();
        return (tag === "p" || tag === "span") && el.hasAttribute("begin");
    });

    timed.forEach((el) => {
        const begin = el.getAttribute("begin");
        const end = el.getAttribute("end");
        const dur = el.getAttribute("dur");
        // Prefer <p>; skip nested timed <span> when parent <p> already has begin
        if ((el.localName || el.tagName).toLowerCase() === "span") {
            let parentP = el.parentElement;
            while (parentP && (parentP.localName || parentP.tagName).toLowerCase() !== "p") {
                parentP = parentP.parentElement;
            }
            if (parentP && parentP.hasAttribute("begin")) return;
        }
        const text = cueText(el);
        if (!text) return;
        const key = begin + "|" + end + "|" + dur + "|" + text;
        if (seen.has(key)) return;
        seen.add(key);
        pushCue(begin, end, dur, text);
    });

    if (result.length === 0) {
        return parseTTMLRegexFallback(ttmlText, timeToSeconds);
    }

    result.sort((a, b) => a.start - b.start || a.end - b.end);
    result.forEach((cue, i) => { cue.index = i; });
    return result;
}

function parseTTMLRegexFallback(ttmlText, timeToSeconds) {
    const result = [];
    const tickRateMatch = ttmlText.match(/tickRate\s*=\s*["'](\d+(?:\.\d+)?)["']/i);
    const frameRateMatch = ttmlText.match(/frameRate\s*=\s*["'](\d+(?:\.\d+)?)["']/i);
    const tickRate = Math.max(1, parseFloat(tickRateMatch && tickRateMatch[1]) || 1);
    const frameRate = Math.max(1, parseFloat(frameRateMatch && frameRateMatch[1]) || 25);

    const convert = timeToSeconds || ((raw) => {
        if (raw == null) return null;
        const timeStr = String(raw).trim();
        const ticks = timeStr.match(/^(\d+(?:\.\d+)?)t$/i);
        if (ticks) return parseFloat(ticks[1]) / tickRate;
        const offset = timeStr.match(/^(\d+(?:\.\d+)?)(h|m|s|ms|f)$/i);
        if (offset) {
            const n = parseFloat(offset[1]);
            const unit = offset[2].toLowerCase();
            if (unit === "h") return n * 3600;
            if (unit === "m") return n * 60;
            if (unit === "s") return n;
            if (unit === "ms") return n / 1000;
            if (unit === "f") return n / frameRate;
        }
        if (/^\d+:\d{2}:\d{2}\.\d+$/.test(timeStr)) {
            const parts = timeStr.split(":");
            return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
        }
        if (/^\d+:\d{2}:\d{2}:\d{1,2}$/.test(timeStr)) {
            const parts = timeStr.split(":").map((p) => parseInt(p, 10));
            return parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / frameRate;
        }
        if (/^\d+:\d{2}:\d{2}$/.test(timeStr)) {
            const parts = timeStr.split(":").map((p) => parseInt(p, 10));
            return parts[0] * 3600 + parts[1] * 60 + parts[2];
        }
        if (/^\d+(?:\.\d+)?$/.test(timeStr)) return parseFloat(timeStr);
        return null;
    });

    const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = re.exec(ttmlText)) !== null) {
        const attrs = m[1] || "";
        const begin = (attrs.match(/\bbegin\s*=\s*["']([^"']+)["']/i) || [])[1];
        const end = (attrs.match(/\bend\s*=\s*["']([^"']+)["']/i) || [])[1];
        const dur = (attrs.match(/\bdur\s*=\s*["']([^"']+)["']/i) || [])[1];
        if (begin == null) continue;
        const start = convert(begin);
        let endSec = convert(end);
        if (endSec == null && dur) {
            const d = convert(dur);
            if (d != null && start != null) endSec = start + d;
        }
        const text = m[2]
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\s+/g, " ")
            .trim();
        if (start == null || endSec == null || endSec <= start || !text) continue;
        result.push({ start, end: endSec, text, index: result.length });
    }
    result.sort((a, b) => a.start - b.start || a.end - b.end);
    result.forEach((cue, i) => { cue.index = i; });
    return result;
}

function renderSubtitlesOnVideo(parsedSubs, useAI, settings) {
    let attachedContainer = null;
    let lastWaitDebugAt = 0;

    const attachTo = (playerContainer, video) => {
        const layout = describeOverlayLayout(playerContainer);
        const containerLabel = playerContainer.className || playerContainer.id || playerContainer.tagName;
        logDual("subtitle overlay attached", {
            container: containerLabel,
            videoTime: video.currentTime,
            cueCount: parsedSubs.length,
            layout
        });
        writePlaybackDebug(Object.assign({
            event: layoutLooksBad(layout) ? "overlay_layout_suspect" : "overlay_attached",
            cueCount: parsedSubs.length,
            videoTime: Math.round(video.currentTime * 100) / 100,
            videoPaused: video.paused,
            overlayAttached: true,
            firstStart: parsedSubs[0] ? parsedSubs[0].start : null,
            lastEnd: parsedSubs.length ? parsedSubs[parsedSubs.length - 1].end : null,
            useAI: !!useAI
        }, layout));
        setupContainerAndListen(video, playerContainer, parsedSubs, useAI, settings);
        setupInPlayerControls(playerContainer, settings);
        attachedContainer = playerContainer;
    };

    const tryAttach = (allowBody) => {
        // Prime: wait for a real player-sized <video> (detail-page stubs are ~50px tall)
        const video = IS_PRIME
            ? findPrimaryVideo()
            : (findPrimaryVideo() || document.querySelector("video"));
        if (!video) {
            if (IS_PRIME) {
                const sub = document.getElementById("my-cr-dual-sub-container");
                if (sub) hidePrimeOverlay(sub);
                const stub = document.querySelector("video");
                const stubR = stub && stub.getBoundingClientRect();
                if (Date.now() - lastWaitDebugAt > 3000) {
                    lastWaitDebugAt = Date.now();
                    writePlaybackDebug({
                        event: "waiting_for_player",
                        overlayAttached: !!attachedContainer,
                        cueCount: parsedSubs.length,
                        stubVideoW: stubR ? Math.round(stubR.width) : null,
                        stubVideoH: stubR ? Math.round(stubR.height) : null,
                        videoTooSmall: !!(stubR && stubR.height < 240),
                        noPlayerVideo: true
                    });
                }
            }
            return false;
        }
        const playerContainer = findPlayerContainer(video);
        if (!playerContainer) return false;
        if (playerContainer === document.body && !allowBody && !IS_PRIME) return false;

        // Re-parent if we find a tighter (closer to video) shell — not a taller page wrapper
        if (attachedContainer) {
            if (playerContainer === attachedContainer) {
                // Still refresh fixed pin (player may have resized after click-to-play)
                const sub = document.getElementById("my-cr-dual-sub-container");
                if (IS_PRIME && sub) {
                    syncPrimeOverlayToVideo(sub, video, primeOverlayBottomPct);
                }
                return true;
            }
            const vr = video.getBoundingClientRect();
            const oldR = attachedContainer.getBoundingClientRect();
            const newR = playerContainer.getBoundingClientRect();
            const oldDelta = Math.abs(oldR.height - vr.height) + Math.abs(oldR.width - vr.width);
            const newDelta = Math.abs(newR.height - vr.height) + Math.abs(newR.width - vr.width);
            if (newDelta >= oldDelta * 0.85) return true;
            logDual("reparenting overlay to tighter player shell");
        }

        attachTo(playerContainer, video);
        return true;
    };

    tryAttach(false);

    // Prime click-to-play can take several seconds to mount the real player
    const waitMs = IS_PRIME ? 45000 : 20000;
    const intervalId = setInterval(() => {
        tryAttach(IS_PRIME);
    }, 400);

    setTimeout(() => {
        clearInterval(intervalId);
        tryAttach(true);
        const sub = document.getElementById("my-cr-dual-sub-container");
        const host = (sub && sub.parentElement) || findPlayerContainer(findPrimaryVideo());
        const layout = describeOverlayLayout(host);
        writePlaybackDebug(Object.assign({
            event: !findPrimaryVideo() && IS_PRIME
                ? "waiting_for_player"
                : (layoutLooksBad(layout)
                    ? "overlay_layout_suspect"
                    : (attachedContainer ? "overlay_layout_ok" : "overlay_missing")),
            overlayAttached: !!attachedContainer,
            cueCount: parsedSubs.length
        }, layout));
    }, waitMs);
}

function setupInPlayerControls(playerContainer, settings) {
    const mount = IS_PRIME ? document.body : playerContainer;
    let wrapper = document.getElementById('cr-inplayer-controls-wrapper');
    if (wrapper) {
        if (wrapper.parentElement !== mount) mount.appendChild(wrapper);
        if (IS_PRIME) {
            const live = findPrimaryVideo();
            if (live) {
                const r = live.getBoundingClientRect();
                wrapper.style.cssText = `position:fixed; top:${Math.round(r.top + 16)}px; left:${Math.round(r.left + 16)}px; z-index:2147483647;`;
            }
        }
        return;
    }
    wrapper = document.createElement('div');
    wrapper.id = 'cr-inplayer-controls-wrapper';
    if (IS_PRIME) {
        const live = findPrimaryVideo();
        const r = live ? live.getBoundingClientRect() : { top: 20, left: 20 };
        wrapper.style.cssText = `position:fixed; top:${Math.round(r.top + 16)}px; left:${Math.round(r.left + 16)}px; z-index:2147483647;`;
    }
    wrapper.innerHTML = `
        <div id="cr-inplayer-btn">${chrome.i18n.getMessage("style_adjust_btn") || "⚙️ Style Settings"}</div>
        <div id="cr-inplayer-panel">
            <div class="cr-panel-row">
                <label>${chrome.i18n.getMessage("font_size_label") || "Font Size"} <span id="cr-val-size">${settings.subSize}px</span></label>
                <input type="range" id="cr-range-size" min="14" max="50" value="${settings.subSize}">
            </div>
            <div class="cr-panel-row">
                <label>${chrome.i18n.getMessage("vertical_pos_label") || "Vertical Position"} <span id="cr-val-bottom">${settings.subBottom}%</span></label>
                <input type="range" id="cr-range-bottom" min="0" max="100" value="${settings.subBottom}">
            </div>
            <div class="cr-panel-row" style="display:flex; justify-content:space-between; align-items:center;">
                <label style="margin:0; font-size:13px; color:#ccc;">${chrome.i18n.getMessage("font_color_label") || "Font Color"}</label>
                <input type="color" id="cr-color-picker" value="${settings.subColor || '#ffffff'}">
            </div>
            <div class="cr-panel-row">
                <label>${chrome.i18n.getMessage("bg_opacity_label") || "Background Opacity"} <span id="cr-val-opacity">${settings.subBgOpacity}%</span></label>
                <input type="range" id="cr-range-opacity" min="0" max="100" value="${settings.subBgOpacity}">
            </div>
            <div class="cr-panel-row">
                <button id="cr-reset-pos" style="width:100%; padding:6px; background:#f47521; color:#fff; border:none; border-radius:4px; cursor:pointer; font-weight:bold;">${chrome.i18n.getMessage("reset_style_btn") || "Reset Style & Pos"}</button>
            </div>
        </div>
    `;
    mount.appendChild(wrapper);

    const btn = document.getElementById('cr-inplayer-btn');
    const panel = document.getElementById('cr-inplayer-panel');
    const rangeSize = document.getElementById('cr-range-size');
    const rangeBottom = document.getElementById('cr-range-bottom');
    const valSize = document.getElementById('cr-val-size');
    const valBottom = document.getElementById('cr-val-bottom');
    const colorPicker = document.getElementById('cr-color-picker');
    const rangeOpacity = document.getElementById('cr-range-opacity');
    const valOpacity = document.getElementById('cr-val-opacity');
    const resetBtn = document.getElementById('cr-reset-pos');
    
    const subContainer = document.getElementById('my-cr-dual-sub-container');
    const subText = document.getElementById('my-cr-dual-sub-text');

    if (subContainer) {
        subContainer.style.setProperty('--cr-sub-bottom', settings.subBottom !== 'auto' ? `${settings.subBottom}%` : 'auto');
        subContainer.style.setProperty('--cr-sub-top', settings.subTop);
        subContainer.style.setProperty('--cr-sub-left', settings.subLeft);
        subContainer.style.setProperty('--cr-sub-width', settings.subWidth);
    }
    if (subText) {
        subText.style.setProperty('--cr-sub-size', `${settings.subSize}px`);
        if (settings.subColor) subText.style.setProperty('--cr-sub-color', settings.subColor);
        subText.style.setProperty('--cr-sub-bg', `rgba(0, 0, 0, ${settings.subBgOpacity / 100})`);
    }

    btn.addEventListener('click', () => { panel.style.display = panel.style.display === 'block' ? 'none' : 'block'; });

    rangeSize.addEventListener('input', (e) => {
        const v = e.target.value;
        valSize.innerText = `${v}px`;
        if (subText) subText.style.setProperty('--cr-sub-size', `${v}px`);
        chrome.storage.local.set({ subSize: v });
    });

    rangeBottom.addEventListener('input', (e) => {
        const v = e.target.value;
        valBottom.innerText = `${v}%`;
        settings.subBottom = v;
        settings.subTop = "auto";
        settings.subLeft = "0";
        settings.subWidth = "100%";
        if (subContainer) {
            if (IS_PRIME) {
                setPrimeBottomPct(v);
                const live = findPrimaryVideo();
                if (live) syncPrimeOverlayToVideo(subContainer, live, primeOverlayBottomPct);
            } else {
                subContainer.style.setProperty('--cr-sub-bottom', `${v}%`);
                subContainer.style.setProperty('--cr-sub-top', 'auto');
                subContainer.style.setProperty('--cr-sub-left', '0');
                subContainer.style.setProperty('--cr-sub-width', '100%');
            }
        }
        chrome.storage.local.set({ subBottom: v, subTop: 'auto', subLeft: '0', subWidth: '100%' });
    });

    colorPicker.addEventListener('input', (e) => {
        const v = e.target.value;
        if (subText) subText.style.setProperty('--cr-sub-color', v);
        chrome.storage.local.set({ subColor: v });
    });

    rangeOpacity.addEventListener('input', (e) => {
        const v = e.target.value;
        valOpacity.innerText = `${v}%`;
        if (subText) subText.style.setProperty('--cr-sub-bg', `rgba(0, 0, 0, ${v / 100})`);
        chrome.storage.local.set({ subBgOpacity: v });
    });

    resetBtn.addEventListener('click', () => {
        chrome.storage.local.set({
            subBottom: 10, subTop: 'auto', subLeft: '0', subWidth: '100%',
            subColor: "", subBgOpacity: 65, subSize: 26
        }, () => {
            rangeBottom.value = 10; valBottom.innerText = '10%';
            rangeSize.value = 26; valSize.innerText = '26px';
            rangeOpacity.value = 65; valOpacity.innerText = '65%';
            colorPicker.value = '#ffffff';
            if (subContainer) {
                if (IS_PRIME) {
                    setPrimeBottomPct(10);
                    const live = findPrimaryVideo();
                    if (live) syncPrimeOverlayToVideo(subContainer, live, 10);
                } else {
                    subContainer.style.setProperty('--cr-sub-bottom', '10%');
                    subContainer.style.setProperty('--cr-sub-top', 'auto');
                    subContainer.style.setProperty('--cr-sub-left', '0');
                    subContainer.style.setProperty('--cr-sub-width', '100%');
                }
            }
            if (subText) {
                subText.style.setProperty('--cr-sub-size', '26px');
                subText.style.removeProperty('--cr-sub-color'); // Let it fallback to useAI logic
                subText.style.setProperty('--cr-sub-bg', `rgba(0, 0, 0, 0.65)`);
            }
        });
    });
}

function setupContainerAndListen(video, playerContainer, parsedSubs, useAI, settings) {
    try {
        const pos = window.getComputedStyle(playerContainer).position;
        if (pos === "static") playerContainer.style.position = "relative";
    } catch (e) { /* ignore */ }

    let subContainer = document.getElementById('my-cr-dual-sub-container');
    if (!subContainer) {
        subContainer = document.createElement('div');
        subContainer.id = 'my-cr-dual-sub-container';
    }

    // Prime: mount on <body> + position:fixed to the video box (page wrappers break absolute %).
    const mountParent = IS_PRIME ? document.body : playerContainer;
    if (subContainer.parentElement !== mountParent) {
        mountParent.appendChild(subContainer);
    }

    let textElement = document.getElementById('my-cr-dual-sub-text');
    if (!textElement) {
        textElement = document.createElement('div');
        textElement.id = 'my-cr-dual-sub-text';
        subContainer.appendChild(textElement);
    }

    if (settings.subBottom !== "auto" && settings.subBottom != null) {
        setPrimeBottomPct(settings.subBottom);
    } else if (IS_PRIME) {
        setPrimeBottomPct(18);
    }

    if (IS_PRIME) {
        subContainer.setAttribute("data-pv-overlay", "1");
        syncPrimeOverlayToVideo(subContainer, video, primeOverlayBottomPct);
        if (video._pvOverlaySync) {
            window.removeEventListener("resize", video._pvOverlaySync);
            window.removeEventListener("scroll", video._pvOverlaySync, true);
        }
        video._pvOverlaySync = () => {
            const live = findPrimaryVideo() || video;
            // Always read shared primeOverlayBottomPct (slider updates it live)
            syncPrimeOverlayToVideo(subContainer, live, primeOverlayBottomPct);
            const controls = document.getElementById("cr-inplayer-controls-wrapper");
            if (controls && live && isPrimePlayerSized(live)) {
                const r = live.getBoundingClientRect();
                controls.style.top = `${Math.round(r.top + 16)}px`;
                controls.style.left = `${Math.round(r.left + 16)}px`;
            }
        };
        window.addEventListener("resize", video._pvOverlaySync);
        window.addEventListener("scroll", video._pvOverlaySync, true);
    } else {
        subContainer.style.removeProperty("position");
        subContainer.style.removeProperty("left");
        subContainer.style.removeProperty("width");
        subContainer.style.removeProperty("top");
        subContainer.style.removeProperty("bottom");
    }

    if (settings.subColor) {
        textElement.style.setProperty('--cr-sub-color', settings.subColor);
    } else {
        textElement.style.setProperty('--cr-sub-color', useAI ? (settings.transEngine === 'custom_llm' ? '#00FFFF' : '#55FF55') : '#FFFF00');
    }
    
    textElement.style.setProperty('--cr-sub-bg', `rgba(0, 0, 0, ${settings.subBgOpacity / 100})`);

    if (!IS_PRIME) {
        let posTop = settings.subTop;
        let posLeft = settings.subLeft;
        let posWidth = settings.subWidth;
        let posBottom = settings.subBottom;
        subContainer.style.setProperty("--cr-sub-top", posTop);
        subContainer.style.setProperty("--cr-sub-left", posLeft);
        subContainer.style.setProperty("--cr-sub-width", posWidth);
        if (posBottom !== "auto") {
            subContainer.style.setProperty("--cr-sub-bottom", `${posBottom}%`);
        } else {
            subContainer.style.setProperty("--cr-sub-bottom", "auto");
        }
    }

    makeDraggable(textElement, subContainer, IS_PRIME ? subContainer : playerContainer);

    if (video._dualSubListener) video.removeEventListener('timeupdate', video._dualSubListener);
    if (video._dualSubPollId) {
        clearInterval(video._dualSubPollId);
        delete video._dualSubPollId;
    }

    const currentSessionId = activeEpisodeSession.id;

    // Ensure every cue has a stable index (also for older parsed payloads)
    parsedSubs.forEach((sub, i) => {
        if (typeof sub.index !== "number") sub.index = i;
    });

    // ✨ 实时流式开关：仅 custom_llm 引擎支持逐字流式
    const streamingEnabled = useAI && settings.streaming && settings.transEngine === 'custom_llm';

    let currentDisplayedSourceText = "";
    let currentActiveCues = []; // active subtitle cues (index + text)

    const inFlight = new Set(); // cue indexes
    const BATCH_SIZE = settings.batchSize || 15;
    const MAX_CONCURRENCY = settings.concurrency || 2;
    let isPreloading = false;

    const sessionAlive = () => currentSessionId === activeEpisodeSession.id && !activeEpisodeSession.isCancelled;

    const escapeHtml = (s) => String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    const contextBeforeCue = (cueIndex) => {
        const start = Math.max(0, cueIndex - CONTEXT_LINES);
        return parsedSubs.slice(start, cueIndex).map(s => s.text);
    };

    // ✨ 渲染当前正在显示的字幕行：优先用最终译文，其次用流式中的部分译文，未开始则显示省略号占位
    const renderActive = () => {
        if (!sessionAlive()) return;
        if (!currentDisplayedSourceText) {
            textElement.style.setProperty('display', 'none', 'important');
            textElement.innerHTML = '';
            return;
        }
        const cues = currentActiveCues;
        const fmt = (t) => escapeHtml(t).replace(/\n/g, '<br>').replace(/\\n/g, '<br>');
        const parts = cues.map(cue => {
            if (translationByCue[cue.index]) return fmt(translationByCue[cue.index]);
            const sp = streamingByCue[cue.index];
            if (sp != null) return fmt(sp) + '▌';
            // Show source immediately so sync/visibility issues are obvious while AI catches up
            if (IS_PRIME) return fmt(cue.text);
            return `<span style="color:#888;font-size:16px;">…</span>`;
        });
        textElement.innerHTML = parts.join('<br>');
        textElement.style.setProperty('display', 'inline-block', 'important');
    };

    // chunk = array of { index, text }
    function requestBatch(chunk) {
        if (!sessionAlive()) return Promise.resolve();
        chunk.forEach(c => inFlight.add(c.index));
        const contextLines = chunk.length ? contextBeforeCue(chunk[0].index) : [];

        if (streamingEnabled) {
            return new Promise((resolve) => {
                openTranslationStream(chunk, settings, {
                    onPartial: (tr) => {
                        if (!sessionAlive()) return;
                        const activeIndexes = currentActiveCues.map(c => c.index);
                        let hitsActive = false;
                        Object.keys(tr).forEach(k => {
                            const cue = chunk[Number(k)];
                            if (cue) {
                                streamingByCue[cue.index] = tr[k];
                                if (activeIndexes.includes(cue.index)) hitsActive = true;
                            }
                        });
                        if (hitsActive) renderActive();
                    },
                    onDone: (data, success, error) => {
                        chunk.forEach(c => inFlight.delete(c.index));
                        if (!sessionAlive()) {
                            resolve(data);
                            return;
                        }
                        if (success && data) {
                            consecutiveErrors = 0;
                            data.forEach((t, i) => {
                                const cue = chunk[i];
                                if (cue) {
                                    translationByCue[cue.index] = t;
                                    delete streamingByCue[cue.index];
                                }
                            });
                        } else {
                            consecutiveErrors++;
                            const errDetail = error ? String(error).slice(0, 120) : "";
                            showToast((chrome.i18n.getMessage("toast_api_error") || "API error: ") + errDetail, true);
                            chunk.forEach(c => delete streamingByCue[c.index]);
                        }
                        if (currentDisplayedSourceText) renderActive();
                        resolve(data);
                    }
                }, contextLines);
            });
        }

        return fetchAIBatchTranslation(chunk, settings, contextLines).then(data => {
            chunk.forEach(c => inFlight.delete(c.index));
            if (!sessionAlive()) return data;
            if (currentDisplayedSourceText) renderActive();
            return data;
        }).catch(() => {
            chunk.forEach(c => inFlight.delete(c.index));
        });
    }

    const runContinuousPreload = async () => {
        if (!useAI || isPreloading || !sessionAlive()) return;
        isPreloading = true;

        while (consecutiveErrors <= 3) {
            if (!sessionAlive()) break;
            const v = document.querySelector('video');
            if (!v) break;
            const actualTime = v.currentTime;

            const currentIndex = parsedSubs.findIndex(sub => sub.end >= actualTime);
            if (currentIndex === -1) break;

            const horizon = actualTime + PRELOAD_AHEAD_SEC;
            const futureSubs = parsedSubs
                .slice(currentIndex)
                .filter(s => s.start <= horizon && s.text && translationByCue[s.index] == null && !inFlight.has(s.index));

            if (futureSubs.length === 0) break;

            const targetCues = futureSubs.slice(0, BATCH_SIZE * MAX_CONCURRENCY);
            const chunks = [];
            for (let i = 0; i < targetCues.length; i += BATCH_SIZE) {
                chunks.push(targetCues.slice(i, i + BATCH_SIZE));
            }

            const promises = chunks.map(chunk => requestBatch(chunk));
            await Promise.all(promises);
            if (!sessionAlive()) break;
            await new Promise(r => setTimeout(r, 1000));
        }

        isPreloading = false;
    };

    let lastSyncLogAt = 0;
    video._dualSubListener = () => {
        if (!sessionAlive()) return;
        if (settings.secondLang === "none") return;

        // Re-resolve playing video periodically (Prime may swap media elements)
        const liveVideo = findPrimaryVideo() || video;
        const currentTime = liveVideo.currentTime;

        if (useAI) runContinuousPreload();

        const activeSubs = parsedSubs.filter(sub => currentTime >= sub.start && currentTime <= sub.end);

        if (activeSubs.length > 0) {
            const cueKey = activeSubs.map(s => s.index).join(",");
            const combinedSourceText = activeSubs.map(s => s.text).join('\n');

            if (currentDisplayedSourceText !== combinedSourceText + "#" + cueKey) {
                currentDisplayedSourceText = combinedSourceText + "#" + cueKey;
                currentActiveCues = activeSubs.map(s => ({ index: s.index, text: s.text }));
                renderActive();

                const layout = describeOverlayLayout(
                    document.getElementById("my-cr-dual-sub-container")
                        && document.getElementById("my-cr-dual-sub-container").parentElement
                );
                writePlaybackDebug(Object.assign({
                    event: layoutLooksBad(layout) ? "overlay_layout_suspect" : "cue_active",
                    videoTime: Math.round(currentTime * 100) / 100,
                    cueCount: parsedSubs.length,
                    activeIndexes: activeSubs.map((s) => s.index),
                    activeText: combinedSourceText.slice(0, 120),
                    hasTranslation: activeSubs.every((s) => !!translationByCue[s.index]),
                    overlayAttached: true,
                    firstCueStart: parsedSubs[0] && parsedSubs[0].start,
                    lastCueEnd: parsedSubs[parsedSubs.length - 1] && parsedSubs[parsedSubs.length - 1].end
                }, layout));

                const needTranslation = currentActiveCues.filter(c => translationByCue[c.index] == null && !inFlight.has(c.index));
                if (useAI && needTranslation.length > 0) {
                    requestBatch(needTranslation);
                }
            }
        } else {
            if (currentDisplayedSourceText !== "") {
                currentDisplayedSourceText = "";
                currentActiveCues = [];
                textElement.style.setProperty('display', 'none', 'important');
                textElement.innerHTML = '';
            }
            // Only flag real clock skew — short gaps between dialogue lines are normal
            if (IS_PRIME && currentTime > 1 && Date.now() - lastSyncLogAt > 8000) {
                lastSyncLogAt = Date.now();
                const firstStart = parsedSubs[0] && parsedSubs[0].start;
                const lastEnd = parsedSubs[parsedSubs.length - 1] && parsedSubs[parsedSubs.length - 1].end;
                const nearest = parsedSubs.reduce((best, cue) => {
                    const d = Math.min(Math.abs(cue.start - currentTime), Math.abs(cue.end - currentTime));
                    if (!best || d < best.d) return { d, cue };
                    return best;
                }, null);
                const gap = nearest ? nearest.d : null;
                const outsideRange = firstStart != null && lastEnd != null
                    && (currentTime < firstStart - 2 || currentTime > lastEnd + 2);
                const suspiciousSkew = gap != null && gap > 20;

                if (outsideRange || suspiciousSkew) {
                    const syncInfo = {
                        event: "sync_miss",
                        videoTime: Math.round(currentTime * 100) / 100,
                        nearestGapSec: gap != null ? Math.round(gap * 100) / 100 : null,
                        nearestStart: nearest && nearest.cue.start,
                        nearestEnd: nearest && nearest.cue.end,
                        firstCueStart: firstStart,
                        lastCueEnd: lastEnd,
                        cueCount: parsedSubs.length,
                        overlayAttached: !!document.getElementById("my-cr-dual-sub-container")
                    };
                    logDual("prime sync miss", syncInfo);
                    writePlaybackDebug(syncInfo);
                } else if (gap != null) {
                    writePlaybackDebug({
                        event: "between_cues",
                        videoTime: Math.round(currentTime * 100) / 100,
                        nearestGapSec: Math.round(gap * 100) / 100,
                        nearestStart: nearest.cue.start,
                        nearestEnd: nearest.cue.end,
                        firstCueStart: firstStart,
                        lastCueEnd: lastEnd,
                        cueCount: parsedSubs.length,
                        overlayAttached: !!document.getElementById("my-cr-dual-sub-container")
                    });
                }
            }
        }
    };
    video.addEventListener('timeupdate', video._dualSubListener);
    // Prime players sometimes throttle timeupdate; poll as backup + keep fixed overlay aligned
    if (IS_PRIME) {
        video._dualSubPollId = setInterval(() => {
            if (!sessionAlive()) {
                clearInterval(video._dualSubPollId);
                return;
            }
            if (typeof video._pvOverlaySync === "function") video._pvOverlaySync();
            video._dualSubListener();
        }, 250);
    }
    // Kick once immediately
    video._dualSubListener();
}

function removeExistingSubtitles() {
    const c = document.getElementById('my-cr-dual-sub-container');
    const w = document.getElementById('cr-inplayer-controls-wrapper');
    const t = document.getElementById('cr-dual-sub-toast');
    if (c) c.remove();
    if (w) w.remove();
    if (t) t.remove();
}

function makeDraggable(textEl, containerEl, videoContainer) {
    if (textEl._dragInitialized) return;
    textEl._dragInitialized = true;

    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    textEl.addEventListener('mousedown', (e) => {
        isDragging = true;
        
        const rect = containerEl.getBoundingClientRect();
        const parentRect = videoContainer.getBoundingClientRect();
        
        if (containerEl.style.getPropertyValue('--cr-sub-width') === '' || containerEl.style.getPropertyValue('--cr-sub-width') === '100%') {
            containerEl.style.setProperty('--cr-sub-width', 'auto');
            containerEl.style.setProperty('--cr-sub-bottom', 'auto');
            initialLeft = rect.left - parentRect.left;
            initialTop = rect.top - parentRect.top;
            containerEl.style.setProperty('--cr-sub-left', `${initialLeft}px`);
            containerEl.style.setProperty('--cr-sub-top', `${initialTop}px`);
        } else {
            initialLeft = parseFloat(containerEl.style.getPropertyValue('--cr-sub-left')) || (rect.left - parentRect.left);
            initialTop = parseFloat(containerEl.style.getPropertyValue('--cr-sub-top')) || (rect.top - parentRect.top);
        }

        startX = e.clientX;
        startY = e.clientY;
        e.preventDefault(); 
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        
        const newLeft = initialLeft + dx;
        const newTop = initialTop + dy;
        
        containerEl.style.setProperty('--cr-sub-left', `${newLeft}px`);
        containerEl.style.setProperty('--cr-sub-top', `${newTop}px`);
    });

    document.addEventListener('mouseup', (e) => {
        if (!isDragging) return;
        isDragging = false;
        
        const rect = containerEl.getBoundingClientRect();
        const parentRect = videoContainer.getBoundingClientRect();
        
        const leftPct = ((rect.left - parentRect.left) / parentRect.width) * 100;
        const topPct = ((rect.top - parentRect.top) / parentRect.height) * 100;
        
        containerEl.style.setProperty('--cr-sub-left', `${leftPct}%`);
        containerEl.style.setProperty('--cr-sub-top', `${topPct}%`);
        
        chrome.storage.local.set({
            subLeft: `${leftPct}%`,
            subTop: `${topPct}%`,
            subWidth: 'auto',
            subBottom: 'auto'
        });
    });
}
