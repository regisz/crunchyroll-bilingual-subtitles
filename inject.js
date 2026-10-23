// inject.js — MAIN world: intercept CR playback manifests and hide native Bitmovin subs
(function() {
    if (window.__CR_DUAL_SUBS_INJECTED__) return;
    window.__CR_DUAL_SUBS_INJECTED__ = true;

    console.log("[CR Bilingual Subtitles] Network interceptor loaded");

    const originalFetch = window.fetch;
    const retryBackoffs = {};
    const trackedPlayers = new Set();
    /** @type {Map<object, string[]>} */
    const disabledByPlayer = new WeakMap();
    let hideNativeEnabled = false;
    let hidePollId = null;
    let lastHideDiagJson = "";
    let canvasHooksInstalled = false;
    let suppressedCanvasOps = 0;
    /** @type {{ id: string|null, w: number, h: number, op: string, at: string }[]} */
    const recentCanvasTouches = [];
    /** @type {WeakSet<Element>} */
    let hiddenViaHookCanvases = new WeakSet();

    function slimPlaybackData(data, redactSecrets) {
        return {
            subtitles: data.subtitles || null,
            captions: data.captions || null,
            versions: (data.versions || []).map(v => ({
                guid: v.guid,
                audio_locale: v.audio_locale,
                original: !!v.original
            })),
            assetId: data.assetId || null,
            // Playback session token is sensitive — never put the raw value on a DOM attribute.
            token: redactSecrets
                ? (data.token ? "[redacted]" : null)
                : (data.token || null)
        };
    }

    function sanitizeHeadersForDom(headers) {
        const out = {};
        Object.keys(headers || {}).forEach((key) => {
            if (/^(authorization|cookie|set-cookie|proxy-authorization)$/i.test(key)) {
                out[key] = "[redacted]";
                return;
            }
            out[key] = headers[key];
        });
        return out;
    }

    function emitSubtitleData(payload) {
        const fullHeaders = (payload.options && payload.options.headers) || {};
        // Full payload for isolated content script via CustomEvent.detail (not inspectable as HTML attr).
        const full = {
            url: payload.url,
            options: { headers: fullHeaders },
            data: slimPlaybackData(payload.data, false)
        };
        // Public DOM/postMessage copies must never include bearer tokens.
        const publicSlim = {
            url: payload.url,
            options: { headers: sanitizeHeadersForDom(fullHeaders) },
            data: slimPlaybackData(payload.data, true)
        };

        try {
            const root = document.documentElement;
            root.setAttribute("data-cr-dual-subs", JSON.stringify(publicSlim));
            root.dispatchEvent(new CustomEvent("cr-dual-subs-ready", {
                bubbles: true,
                detail: full
            }));
        } catch (e) {
            console.warn("[CR Bilingual Subtitles] DOM bridge failed", e);
        }

        try {
            window.postMessage({
                source: "CR_DUAL_SUBS",
                type: "CR_SUBTITLE_DATA",
                payload: publicSlim
            }, "*");
        } catch (e) {
            console.warn("[CR Bilingual Subtitles] postMessage failed", e);
        }

        console.log("[CR Bilingual Subtitles] Playback manifest captured", {
            subs: full.data.subtitles ? Object.keys(full.data.subtitles) : [],
            caps: full.data.captions ? Object.keys(full.data.captions) : []
        });
    }

    function isPlaybackUrl(url) {
        if (!url) return false;
        const u = String(url);
        // …/playback/v3/…/play — not the returned …/manifest.mpd URLs
        return u.includes("/playback/") && /\/play(?:[?#]|$)/.test(u);
    }

    /** Last hardSubs rewrite attempt (for hideNative diagnostics). */
    let lastHardSubsInfo = null;
    /** Softsub URLs from last /play response — used to restore CR paint after hide off. */
    let lastPlaySoftTracks = [];
    let hardSubsRewrittenThisSession = false;

    /**
     * CR forced-subtitle titles put burned-in EN in hardSubs[*].url while the
     * top-level `url` is a clean (softsub-only) stream when burnedInLocale is empty.
     * Repoint hardSubs at the clean manifest so CSS/API hide is enough.
     */
    function neutralizeHardsubs(data) {
        if (!data || typeof data !== "object"
            || !data.hardSubs || typeof data.hardSubs !== "object") {
            return { data, changed: false, reason: "no_hardsubs" };
        }
        const keys = Object.keys(data.hardSubs);
        if (!keys.length) return { data, changed: false, reason: "no_hardsubs" };

        const cleanUrl = !data.burnedInLocale && typeof data.url === "string"
            ? data.url
            : null;
        if (!cleanUrl) {
            return {
                data,
                changed: false,
                reason: "no_clean_stream",
                burnedInLocale: data.burnedInLocale || null,
                hardSubKeys: keys.slice(0, 12)
            };
        }

        let changed = false;
        for (let i = 0; i < keys.length; i++) {
            const hs = data.hardSubs[keys[i]];
            if (hs && typeof hs.url === "string" && hs.url !== cleanUrl) {
                hs.url = cleanUrl;
                changed = true;
            }
        }
        return {
            data,
            changed,
            reason: changed ? "rewritten" : "already_clean",
            burnedInLocale: data.burnedInLocale || null,
            hardSubKeys: keys.slice(0, 12)
        };
    }

    function rememberPlaySoftTracks(data) {
        const out = [];
        ["subtitles", "captions"].forEach((bucket) => {
            const obj = data && data[bucket];
            if (!obj || typeof obj !== "object") return;
            Object.keys(obj).forEach((lang) => {
                const t = obj[lang];
                if (!t || !t.url) return;
                out.push({
                    id: `cr-dual-${bucket}-${lang}`,
                    lang: lang,
                    label: lang,
                    url: t.url,
                    kind: bucket === "captions" ? "caption" : "subtitle"
                });
            });
        });
        if (out.length) lastPlaySoftTracks = out;
    }

    function pickRestoreSoftTrack() {
        if (!lastPlaySoftTracks.length) return null;
        return lastPlaySoftTracks.find((t) => t.lang === "en-US")
            || lastPlaySoftTracks.find((t) => /^en/i.test(t.lang))
            || lastPlaySoftTracks[0];
    }

    window.fetch = async function(...args) {
        const response = await originalFetch.apply(this, args);

        let reqUrl = "";
        let reqOptions = {};
        let reqHeaders = null;

        if (typeof args[0] === "string") {
            reqUrl = args[0];
            reqOptions = args[1] || {};
            reqHeaders = reqOptions.headers;
        } else if (args[0] && typeof args[0] === "object") {
            reqUrl = args[0].url || args[0].href || String(args[0]);
            reqOptions = args[1] || {};
            reqHeaders = reqOptions.headers || args[0].headers;
        }

        if (reqUrl.includes("cr_cross_track=1")) {
            return response;
        }

        let safeHeaders = {};
        if (reqHeaders) {
            try {
                if (typeof reqHeaders.forEach === "function") {
                    reqHeaders.forEach((val, key) => {
                        if (key && val) safeHeaders[key] = val;
                    });
                } else if (reqHeaders instanceof Object) {
                    Object.keys(reqHeaders).forEach(key => {
                        safeHeaders[key] = reqHeaders[key];
                    });
                }
            } catch (e) { /* ignore */ }
        }

        if (isPlaybackUrl(reqUrl) && response && response.ok) {
            const retryKey = reqUrl;
            try {
                const data = await response.clone().json();
                rememberPlaySoftTracks(data);

                // Only strip burned-in streams while hide-native is on. Otherwise
                // toggling hide off leaves a clean encode with no softsub paint.
                const hideOn = hideNativeEnabled || readHideFlagFromDom();
                let hs = { data: data, changed: false, reason: "skipped_hide_off" };
                if (hideOn) {
                    hs = neutralizeHardsubs(data);
                    if (hs.changed) hardSubsRewrittenThisSession = true;
                } else {
                    hardSubsRewrittenThisSession = false;
                }

                lastHardSubsInfo = {
                    at: new Date().toISOString(),
                    reason: hs.reason,
                    changed: !!hs.changed,
                    burnedInLocale: hs.burnedInLocale || null,
                    hardSubKeys: hs.hardSubKeys || null,
                    softTrackCount: lastPlaySoftTracks.length
                };
                if (hs.changed) {
                    console.log("[CR Bilingual Subtitles] hardSubs → clean stream", {
                        keys: hs.hardSubKeys
                    });
                    publishHideDiag(true);
                }

                if (data && (data.subtitles || data.captions)) {
                    emitSubtitleData({
                        url: reqUrl,
                        options: { headers: safeHeaders },
                        data: data
                    });
                    delete retryBackoffs[retryKey];
                }

                if (hs.changed) {
                    const headers = new Headers(response.headers);
                    try { headers.delete("content-length"); } catch (e) { /* ignore */ }
                    return new Response(JSON.stringify(data), {
                        status: response.status,
                        statusText: response.statusText,
                        headers: headers
                    });
                }
            } catch (e) {
                updateBackoff(retryKey);
            }
        }

        return response;
    };

    function updateBackoff(key) {
        const current = retryBackoffs[key] || 500;
        retryBackoffs[key] = Math.min(current * 2, 4000);
    }

    // --- Hide native CR subs via Bitmovin Player API (DOM/CSS cannot reach closed shadow) ---

    function readHideFlagFromDom() {
        const root = document.documentElement;
        if (!root) return hideNativeEnabled;
        const attr = root.getAttribute("data-cr-hide-native-subs");
        if (attr === "1" || attr === "true") return true;
        if (attr === "0" || attr === "false") return false;
        return hideNativeEnabled;
    }

    function isBitmovinPlayer(obj) {
        return !!(obj && obj.subtitles && typeof obj.subtitles.list === "function"
            && typeof obj.subtitles.disable === "function");
    }

    function wrapSubtitleEnable(player) {
        if (!player || !player.subtitles || player.subtitles.__crDualHideWrapped) return;
        const subs = player.subtitles;
        const origEnable = typeof subs.enable === "function" ? subs.enable.bind(subs) : null;
        if (!origEnable) return;
        subs.enable = function(id, exclusive) {
            if (hideNativeEnabled || readHideFlagFromDom()) {
                // Keep site English "on" for UX/policy, but do not paint native cues.
                // Our extension already fetches ASS from the playback manifest URL.
                try {
                    if (typeof subs.disable === "function" && id != null) subs.disable(id);
                } catch (e) { /* ignore */ }
                return;
            }
            return origEnable(id, exclusive);
        };
        subs.__crDualHideWrapped = true;
    }

    function registerPlayer(player) {
        if (!isBitmovinPlayer(player) || trackedPlayers.has(player)) return;
        trackedPlayers.add(player);
        wrapSubtitleEnable(player);
        try {
            if (typeof player.on === "function") {
                const reapply = () => {
                    if (hideNativeEnabled || readHideFlagFromDom()) applyHideToPlayer(player);
                };
                ["subtitleenable", "subtitleenabled", "SubtitleEnabled", "cueenter", "CueEnter",
                    "sourceloaded", "SourceLoaded", "ready", "Ready"].forEach((ev) => {
                    try { player.on(ev, reapply); } catch (e) { /* ignore */ }
                });
            }
        } catch (e) { /* ignore */ }
        if (hideNativeEnabled || readHideFlagFromDom()) applyHideToPlayer(player);
        publishHideDiag(true);
    }

    function listSubtitleTracks(player) {
        try {
            const list = player.subtitles.list();
            return Array.isArray(list) ? list : [];
        } catch (e) {
            return [];
        }
    }

    function applyHideToPlayer(player) {
        if (!isBitmovinPlayer(player)) return { disabled: [], stillEnabled: [] };
        wrapSubtitleEnable(player);
        const disabled = [];
        const stillEnabled = [];
        listSubtitleTracks(player).forEach((track) => {
            if (!track || track.id == null) return;
            if (track.enabled) {
                try {
                    player.subtitles.disable(track.id);
                    disabled.push(String(track.id));
                } catch (e) { /* ignore */ }
            }
        });
        const prev = disabledByPlayer.get(player) || [];
        const merged = Array.from(new Set(prev.concat(disabled)));
        disabledByPlayer.set(player, merged);
        listSubtitleTracks(player).forEach((track) => {
            if (track && track.enabled) stillEnabled.push(String(track.id));
        });
        return { disabled, stillEnabled };
    }

    function restorePlayerSubs(player) {
        if (!isBitmovinPlayer(player)) return;
        const remembered = disabledByPlayer.get(player) || [];
        let list = listSubtitleTracks(player);
        const fromList = list
            .map((t) => (t && t.id != null ? String(t.id) : null))
            .filter(Boolean);
        const ids = Array.from(new Set(remembered.concat(fromList)));
        ids.forEach((id) => {
            try { player.subtitles.enable(id, true); } catch (e) { /* ignore */ }
        });

        // After hardSubs→clean rewrite CR often has zero Bitmovin tracks even though
        // ASS URLs exist in the play response — sideload English so native paint returns.
        list = listSubtitleTracks(player);
        const anyEnabled = list.some((t) => t && t.enabled);
        if (!anyEnabled && typeof player.subtitles.add === "function") {
            const soft = pickRestoreSoftTrack();
            if (soft) {
                const already = list.some((t) => t && (
                    String(t.id) === soft.id
                    || (t.url && soft.url && t.url === soft.url)
                    || (t.lang || t.language) === soft.lang
                ));
                if (!already) {
                    try {
                        player.subtitles.add({
                            id: soft.id,
                            lang: soft.lang,
                            language: soft.lang,
                            label: soft.label,
                            url: soft.url,
                            kind: soft.kind || "subtitle"
                        });
                        console.log("[CR Bilingual Subtitles] sideloaded softsub for restore", soft.lang);
                    } catch (e) {
                        console.warn("[CR Bilingual Subtitles] softsub sideload failed", e);
                    }
                }
                list = listSubtitleTracks(player);
                const toEnable = list.find((t) => t && (
                    String(t.id) === soft.id
                    || (t.lang || t.language) === soft.lang
                )) || list[0];
                if (toEnable && toEnable.id != null) {
                    try { player.subtitles.enable(toEnable.id, true); } catch (e) { /* ignore */ }
                }
            }
        }

        listSubtitleTracks(player).forEach((track) => {
            if (!track || track.id == null || track.enabled) return;
            try { player.subtitles.enable(track.id, true); } catch (e) { /* ignore */ }
        });
        disabledByPlayer.delete(player);
    }

    function clearForcedHideStyles(el) {
        if (!el || !el.style) return;
        try {
            el.style.removeProperty("display");
            el.style.removeProperty("visibility");
            el.style.removeProperty("opacity");
            el.style.removeProperty("pointer-events");
            el.removeAttribute("data-cr-native-sub-hidden");
        } catch (e) { /* ignore */ }
    }

    /** Undo MAIN-world inline hides (canvas hooks / shadow suppress) when toggle turns off. */
    function clearMainWorldForcedHides() {
        const visit = (root) => {
            if (!root || !root.querySelectorAll) return;
            try {
                root.querySelectorAll("[data-cr-native-sub-hidden='1']").forEach(clearForcedHideStyles);
            } catch (e) { /* ignore */ }
            let all = [];
            try { all = root.querySelectorAll("*"); } catch (e) { return; }
            all.forEach((el) => {
                if (el.shadowRoot) visit(el.shadowRoot);
            });
        };
        visit(document);
        try {
            document.querySelectorAll("iframe").forEach((frame) => {
                try {
                    const doc = frame.contentDocument;
                    if (!doc) return;
                    visit(doc);
                    const style = doc.getElementById("cr-hide-native-subs-style");
                    if (style) style.remove();
                } catch (e) { /* ignore */ }
            });
        } catch (e) { /* ignore */ }
        hiddenViaHookCanvases = new WeakSet();
    }

    function applyHideToAllPlayers() {
        const summary = {
            playerCount: trackedPlayers.size,
            disabledIds: [],
            stillEnabledIds: [],
            errors: 0
        };
        trackedPlayers.forEach((player) => {
            try {
                if (hideNativeEnabled) {
                    const r = applyHideToPlayer(player);
                    summary.disabledIds.push.apply(summary.disabledIds, r.disabled);
                    summary.stillEnabledIds.push.apply(summary.stillEnabledIds, r.stillEnabled);
                } else {
                    restorePlayerSubs(player);
                }
            } catch (e) {
                summary.errors += 1;
            }
        });
        return summary;
    }

    function scanDomForPlayers() {
        // Discover players already constructed before our hook
        const candidates = [];
        try {
            document.querySelectorAll(".bitmovinplayer-container, video").forEach((el) => {
                const keys = Object.getOwnPropertyNames(el);
                for (const k of keys) {
                    try {
                        const v = el[k];
                        if (isBitmovinPlayer(v)) candidates.push(v);
                    } catch (e) { /* ignore */ }
                }
                // React fiber walk (shallow)
                const fiberKey = keys.find((k) =>
                    k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"));
                let fiber = fiberKey ? el[fiberKey] : null;
                let depth = 0;
                while (fiber && depth < 40) {
                    const st = fiber.stateNode || fiber.memoizedState;
                    let state = st;
                    let sDepth = 0;
                    while (state && sDepth < 30) {
                        const memo = state.memoizedState;
                        if (isBitmovinPlayer(memo)) candidates.push(memo);
                        if (memo && typeof memo === "object") {
                            for (const val of Object.values(memo)) {
                                if (isBitmovinPlayer(val)) candidates.push(val);
                            }
                        }
                        state = state.next;
                        sDepth += 1;
                    }
                    if (fiber.memoizedProps) {
                        for (const val of Object.values(fiber.memoizedProps)) {
                            if (isBitmovinPlayer(val)) candidates.push(val);
                        }
                    }
                    fiber = fiber.return;
                    depth += 1;
                }
            });
        } catch (e) { /* ignore */ }

        // Global / webpack leftovers
        try {
            ["player", "__player", "bitmovinPlayer", "crPlayer"].forEach((name) => {
                if (isBitmovinPlayer(window[name])) candidates.push(window[name]);
            });
            if (window.bitmovin && window.bitmovin.player) {
                const mod = window.bitmovin.player;
                Object.keys(mod).forEach((k) => {
                    try {
                        if (isBitmovinPlayer(mod[k])) candidates.push(mod[k]);
                    } catch (e) { /* ignore */ }
                });
            }
        } catch (e) { /* ignore */ }

        candidates.forEach(registerPlayer);
    }

    function hookBitmovinPlayerConstructor() {
        const Player = window.bitmovin && window.bitmovin.player && window.bitmovin.player.Player;
        if (!Player || Player.__crDualHideHooked) return !!Player;

        const Original = Player;
        function WrappedPlayer(container, config) {
            const player = new Original(container, config);
            try { registerPlayer(player); } catch (e) { /* ignore */ }
            return player;
        }
        WrappedPlayer.prototype = Original.prototype;
        try {
            Object.setPrototypeOf(WrappedPlayer, Original);
        } catch (e) { /* ignore */ }
        Object.getOwnPropertyNames(Original).forEach((key) => {
            if (key === "prototype" || key === "length" || key === "name" || key === "caller" || key === "arguments") {
                return;
            }
            try {
                const desc = Object.getOwnPropertyDescriptor(Original, key);
                if (desc) Object.defineProperty(WrappedPlayer, key, desc);
            } catch (e) { /* ignore */ }
        });
        WrappedPlayer.__crDualHideHooked = true;
        try {
            window.bitmovin.player.Player = WrappedPlayer;
        } catch (e) {
            return false;
        }

        // Also wrap prototype.load for instances created other ways
        try {
            if (Original.prototype && typeof Original.prototype.load === "function"
                && !Original.prototype.load.__crDualHideHooked) {
                const origLoad = Original.prototype.load;
                Original.prototype.load = function(...args) {
                    try { registerPlayer(this); } catch (e) { /* ignore */ }
                    return origLoad.apply(this, args);
                };
                Original.prototype.load.__crDualHideHooked = true;
            }
        } catch (e) { /* ignore */ }

        console.log("[CR Bilingual Subtitles] Bitmovin Player hook installed");
        return true;
    }

    function countShadowHosts() {
        let open = 0;
        let closed = 0;
        try {
            document.querySelectorAll("*").forEach((el) => {
                if (el.shadowRoot) open += 1;
                else if (el.attachShadow) {
                    try {
                        if (el.tagName && /PLAYER|BITMOVIN|UI-/i.test(el.tagName)) closed += 1;
                    } catch (e) { /* ignore */ }
                }
            });
        } catch (e) { /* ignore */ }
        return { open, closedGuess: closed };
    }

    function describeOpenShadows() {
        const out = [];
        try {
            document.querySelectorAll("*").forEach((el) => {
                if (!el.shadowRoot || out.length >= 8) return;
                const root = el.shadowRoot;
                const canvases = root.querySelectorAll("canvas").length;
                const textSample = String(root.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100);
                const subish = root.querySelectorAll(
                    "[class*='subtitle' i], [class*='caption' i], [class*='bmpui' i], canvas"
                ).length;
                out.push({
                    host: `${(el.tagName || "?").toLowerCase()}${el.id ? "#" + el.id : ""}.${String(el.className || "").slice(0, 60)}`,
                    canvasCount: canvases,
                    subishCount: subish,
                    textSample: textSample || null,
                    childElementCount: root.childElementCount || 0
                });
            });
        } catch (e) { /* ignore */ }
        return out;
    }

    function suppressOpenShadowSubs() {
        if (!hideNativeEnabled) return 0;
        let n = 0;
        try {
            document.querySelectorAll("*").forEach((el) => {
                if (!el.shadowRoot) return;
                const root = el.shadowRoot;
                root.querySelectorAll(
                    "canvas, [class*='subtitle' i], [class*='Subtitle'], [class*='caption' i], [class*='bmpui-ui-subtitle']"
                ).forEach((node) => {
                    try {
                        node.style.setProperty("display", "none", "important");
                        node.style.setProperty("visibility", "hidden", "important");
                        node.style.setProperty("opacity", "0", "important");
                        node.setAttribute("data-cr-native-sub-hidden", "1");
                        n += 1;
                    } catch (e) { /* ignore */ }
                });
            });
        } catch (e) { /* ignore */ }
        return n;
    }

    function describeVideoTextTracks() {
        const videos = Array.from(document.querySelectorAll("video")).slice(0, 4);
        return videos.map((v) => {
            const tracks = [];
            try {
                for (let i = 0; i < (v.textTracks ? v.textTracks.length : 0); i++) {
                    const t = v.textTracks[i];
                    tracks.push({
                        kind: t.kind || null,
                        label: t.label || null,
                        language: t.language || null,
                        mode: t.mode || null
                    });
                }
            } catch (e) { /* ignore */ }
            return {
                id: v.id || null,
                trackCount: tracks.length,
                tracks,
                showingCount: tracks.filter((t) => t.mode === "showing").length
            };
        });
    }

    function describeIframeDocs() {
        return Array.from(document.querySelectorAll("iframe")).slice(0, 6).map((f, idx) => {
            try {
                const doc = f.contentDocument;
                if (!doc) return { idx, accessible: false };
                const bodyText = String((doc.body && doc.body.innerText) || "")
                    .replace(/\s+/g, " ").trim().slice(0, 80);
                return {
                    idx,
                    accessible: true,
                    canvasCount: doc.querySelectorAll("canvas").length,
                    bodyText: bodyText || null,
                    childElementCount: doc.body ? doc.body.childElementCount : 0
                };
            } catch (e) {
                return { idx, accessible: false };
            }
        });
    }

    function collectMainWorldCanvases() {
        const out = [];
        const visit = (root, path) => {
            if (!root || out.length >= 25) return;
            let list = [];
            try { list = root.querySelectorAll ? root.querySelectorAll("canvas") : []; } catch (e) { return; }
            list.forEach((c) => {
                if (out.length >= 25) return;
                const r = c.getBoundingClientRect();
                out.push({
                    path,
                    id: c.id || null,
                    className: String(c.className || "").slice(0, 120),
                    w: Math.round(r.width),
                    h: Math.round(r.height),
                    top: Math.round(r.top)
                });
            });
            let all = [];
            try { all = root.querySelectorAll ? root.querySelectorAll("*") : []; } catch (e) { return; }
            all.forEach((el) => {
                if (el.shadowRoot) visit(el.shadowRoot, path + ">" + (el.tagName || "?").toLowerCase() + "#shadow");
            });
        };
        visit(document, "document");
        // Same-origin iframes (CR sometimes mounts UI in blank iframes)
        try {
            document.querySelectorAll("iframe").forEach((frame, idx) => {
                try {
                    const doc = frame.contentDocument;
                    if (doc) visit(doc, `iframe[${idx}]`);
                } catch (e) { /* ignore */ }
            });
        } catch (e) { /* ignore */ }
        return out;
    }

    function describePlayerTree() {
        const root = document.querySelector(".bitmovinplayer-container");
        if (!root) return null;
        const describe = (el, depth) => {
            if (!el || depth > 2) return null;
            const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
            const kids = [];
            try {
                Array.from(el.children || []).slice(0, 12).forEach((ch) => {
                    const d = describe(ch, depth + 1);
                    if (d) kids.push(d);
                });
            } catch (e) { /* ignore */ }
            return {
                tag: (el.tagName || "?").toLowerCase(),
                id: el.id || null,
                className: String(el.className || "").slice(0, 100),
                shadow: !!el.shadowRoot,
                childCount: el.children ? el.children.length : 0,
                rect: r ? {
                    w: Math.round(r.width),
                    h: Math.round(r.height),
                    top: Math.round(r.top)
                } : null,
                kids: depth < 2 ? kids : undefined
            };
        };
        return describe(root, 0);
    }

    function getPlayerVideoRect() {
        const video = document.querySelector(".bitmovinplayer-container video")
            || document.querySelector("video");
        if (!video) return null;
        const r = video.getBoundingClientRect();
        return { w: r.width, h: r.height, top: r.top, left: r.left };
    }

    function isLikelySubtitleCanvas(canvas) {
        if (!canvas || canvas.nodeType !== 1) return false;
        if (canvas.closest && (
            canvas.closest("#my-cr-dual-sub-container")
            || canvas.closest("#cr-inplayer-controls-wrapper")
        )) {
            return false;
        }
        const id = String(canvas.id || "");
        const cls = String(canvas.className || "");
        if (/velocity|subtitle|caption|ass|libjass|softsub/i.test(`${id} ${cls}`)) return true;
        let r;
        try { r = canvas.getBoundingClientRect(); } catch (e) { return false; }
        if (!r || r.width < 240 || r.height < 120) return false;
        const vr = getPlayerVideoRect();
        if (!vr || vr.w < 200) {
            // Large canvas on a watch page is likely the ASS layer
            return r.width >= 480 && r.height >= 270;
        }
        const similarSize = Math.abs(r.width - vr.w) < 120 && Math.abs(r.height - vr.h) < 120;
        const overlapsVideo = r.bottom > vr.top && r.top < vr.top + vr.h
            && r.right > vr.left && r.left < vr.left + vr.w;
        return similarSize && overlapsVideo;
    }

    function noteCanvasTouch(canvas, op) {
        suppressedCanvasOps += 1;
        try {
            const r = canvas.getBoundingClientRect();
            recentCanvasTouches.unshift({
                id: canvas.id || null,
                w: Math.round(r.width),
                h: Math.round(r.height),
                op,
                at: new Date().toISOString()
            });
            if (recentCanvasTouches.length > 8) recentCanvasTouches.length = 8;
        } catch (e) { /* ignore */ }
    }

    function hideCanvasElement(canvas) {
        if (!canvas || hiddenViaHookCanvases.has(canvas)) return;
        try {
            canvas.style.setProperty("visibility", "hidden", "important");
            canvas.style.setProperty("opacity", "0", "important");
            canvas.style.setProperty("pointer-events", "none", "important");
            canvas.setAttribute("data-cr-native-sub-hidden", "1");
            hiddenViaHookCanvases.add(canvas);
        } catch (e) { /* ignore */ }
    }

    function installCanvasDrawHooks() {
        if (canvasHooksInstalled) return;
        canvasHooksInstalled = true;

        const wrap2d = (name) => {
            const proto = CanvasRenderingContext2D.prototype;
            const orig = proto[name];
            if (typeof orig !== "function" || orig.__crDualHideHooked) return;
            proto[name] = function(...args) {
                if ((hideNativeEnabled || readHideFlagFromDom())
                    && this && isLikelySubtitleCanvas(this.canvas)) {
                    noteCanvasTouch(this.canvas, name);
                    hideCanvasElement(this.canvas);
                    return;
                }
                return orig.apply(this, args);
            };
            proto[name].__crDualHideHooked = true;
        };

        ["fillText", "strokeText", "putImageData", "drawImage"].forEach(wrap2d);

        // WebGL path (JASSUB / some CR builds)
        const wrapGl = (Proto, name) => {
            if (!Proto || !Proto.prototype) return;
            const orig = Proto.prototype[name];
            if (typeof orig !== "function" || orig.__crDualHideHooked) return;
            Proto.prototype[name] = function(...args) {
                if ((hideNativeEnabled || readHideFlagFromDom())
                    && this && this.canvas && isLikelySubtitleCanvas(this.canvas)) {
                    noteCanvasTouch(this.canvas, `gl:${name}`);
                    hideCanvasElement(this.canvas);
                    return;
                }
                return orig.apply(this, args);
            };
            Proto.prototype[name].__crDualHideHooked = true;
        };
        wrapGl(window.WebGLRenderingContext, "drawArrays");
        wrapGl(window.WebGLRenderingContext, "drawElements");
        wrapGl(window.WebGL2RenderingContext, "drawArrays");
        wrapGl(window.WebGL2RenderingContext, "drawElements");

        console.log("[CR Bilingual Subtitles] Canvas draw hooks installed for native-sub hide");
    }

    function sweepAccessibleIframes() {
        if (!hideNativeEnabled) return;
        const hideCss = `
            canvas, [class*="subtitle" i], [class*="Subtitle"], [class*="caption" i],
            .bmpui-ui-subtitle-overlay, #velocity-canvas {
                visibility: hidden !important;
                opacity: 0 !important;
                pointer-events: none !important;
            }
        `;
        document.querySelectorAll("iframe").forEach((frame) => {
            try {
                const doc = frame.contentDocument;
                if (!doc || !doc.documentElement) return;
                let style = doc.getElementById("cr-hide-native-subs-style");
                if (!style) {
                    style = doc.createElement("style");
                    style.id = "cr-hide-native-subs-style";
                    (doc.head || doc.documentElement).appendChild(style);
                }
                style.textContent = hideCss;
                doc.querySelectorAll("canvas").forEach((c) => {
                    if (isLikelySubtitleCanvas(c)) hideCanvasElement(c);
                });
            } catch (e) { /* ignore */ }
        });
    }

    function buildHideDiag(apiSummary) {
        const tracks = [];
        trackedPlayers.forEach((player) => {
            listSubtitleTracks(player).forEach((t) => {
                tracks.push({
                    id: t && t.id != null ? String(t.id) : null,
                    lang: (t && (t.lang || t.language || t.label)) || null,
                    enabled: !!(t && t.enabled)
                });
            });
        });
        const iframes = Array.from(document.querySelectorAll("iframe")).slice(0, 10).map((f) => ({
            src: (f.src || "").slice(0, 160),
            accessible: (() => {
                try { return !!(f.contentDocument && f.contentDocument.documentElement); } catch (e) { return false; }
            })()
        }));
        const shadows = countShadowHosts();
        const openShadows = describeOpenShadows();
        const canvases = collectMainWorldCanvases();
        const videoTracks = describeVideoTextTracks();
        const iframeDocs = describeIframeDocs();
        const enabledCount = tracks.filter((t) => t.enabled).length;
        const showingTextTracks = videoTracks.reduce((n, v) => n + (v.showingCount || 0), 0);
        let status = "api_idle";
        if (!hideNativeEnabled) {
            status = "disabled";
        } else if (showingTextTracks > 0) {
            status = "texttrack_showing";
        } else if (suppressedCanvasOps > 0) {
            status = "canvas_hook_active";
        } else if (trackedPlayers.size === 0) {
            status = "api_no_player";
        } else if (enabledCount > 0) {
            status = "api_tracks_still_enabled";
        } else if (tracks.length === 0) {
            status = "api_no_tracks";
        } else {
            status = "api_ok";
        }
        return {
            at: new Date().toISOString(),
            world: "MAIN",
            hideNativeEnabled,
            status,
            hookedPlayerCount: trackedPlayers.size,
            tracks,
            enabledTrackCount: enabledCount,
            apiSummary: apiSummary || null,
            hardSubs: lastHardSubsInfo,
            hardSubsRewrittenThisSession: !!hardSubsRewrittenThisSession,
            softTrackCount: lastPlaySoftTracks.length,
            canvases,
            canvasCount: canvases.length,
            canvasHooksInstalled,
            suppressedCanvasOps,
            recentCanvasTouches: recentCanvasTouches.slice(0, 6),
            playerTree: describePlayerTree(),
            videoTextTracks: videoTracks,
            showingTextTracks,
            iframeCount: iframes.length,
            iframes,
            iframeDocs,
            shadowHostsOpen: shadows.open,
            openShadows,
            bitmovinPresent: !!(window.bitmovin && window.bitmovin.player),
            playerHooked: !!(window.bitmovin && window.bitmovin.player
                && window.bitmovin.player.Player && window.bitmovin.player.Player.__crDualHideHooked)
        };
    }

    function publishHideDiag(force) {
        const apiSummary = hideNativeEnabled ? applyHideToAllPlayers() : null;
        const diag = buildHideDiag(apiSummary);
        let json;
        try { json = JSON.stringify(diag); } catch (e) { return; }
        if (!force && json === lastHideDiagJson) return;
        lastHideDiagJson = json;
        try {
            document.documentElement.setAttribute("data-cr-hide-native-diag", json);
            document.documentElement.dispatchEvent(new CustomEvent("cr-dual-subs-hide-diag", {
                bubbles: true,
                detail: diag
            }));
        } catch (e) { /* ignore */ }
    }

    function setHideNativeEnabled(enabled) {
        hideNativeEnabled = !!enabled;
        try {
            document.documentElement.setAttribute(
                "data-cr-hide-native-subs",
                hideNativeEnabled ? "1" : "0"
            );
        } catch (e) { /* ignore */ }

        installCanvasDrawHooks();
        hookBitmovinPlayerConstructor();
        scanDomForPlayers();
        applyHideToAllPlayers();
        if (hideNativeEnabled) {
            sweepAccessibleIframes();
            suppressOpenShadowSubs();
        } else {
            clearMainWorldForcedHides();
            // Second pass: sideload/enable softsubs (CR often has empty track list)
            try {
                trackedPlayers.forEach((player) => restorePlayerSubs(player));
            } catch (e) { /* ignore */ }
            // ASS renderer sometimes mounts one frame later
            setTimeout(() => {
                if (hideNativeEnabled || readHideFlagFromDom()) return;
                clearMainWorldForcedHides();
                try {
                    trackedPlayers.forEach((player) => restorePlayerSubs(player));
                } catch (e) { /* ignore */ }
                publishHideDiag(true);
            }, 250);
        }
        publishHideDiag(true);

        if (hideNativeEnabled && !hidePollId) {
            hidePollId = setInterval(() => {
                hookBitmovinPlayerConstructor();
                scanDomForPlayers();
                applyHideToAllPlayers();
                sweepAccessibleIframes();
                suppressOpenShadowSubs();
                publishHideDiag(false);
            }, 500);
        } else if (!hideNativeEnabled && hidePollId) {
            clearInterval(hidePollId);
            hidePollId = null;
            publishHideDiag(true);
        }
    }

    document.documentElement.addEventListener("cr-dual-subs-hide-native", (ev) => {
        const detail = ev && ev.detail;
        const enabled = detail && typeof detail.enabled === "boolean"
            ? detail.enabled
            : readHideFlagFromDom();
        setHideNativeEnabled(enabled);
    });

    // Install canvas hooks early — CR may draw ASS before the user toggles hide.
    installCanvasDrawHooks();

    // Late bitmovin bundle: poll until Player exists (then stop if hide off)
    let hookPollTries = 0;
    const hookPoll = setInterval(() => {
        hookPollTries += 1;
        const ok = hookBitmovinPlayerConstructor();
        if (ok || hideNativeEnabled) scanDomForPlayers();
        if ((ok && !hideNativeEnabled) || hookPollTries > 120) {
            if (!hideNativeEnabled) clearInterval(hookPoll);
        }
        if (hideNativeEnabled) {
            sweepAccessibleIframes();
            publishHideDiag(false);
        }
    }, 500);

    // Sync flag if content script set attribute before listener
    if (readHideFlagFromDom()) setHideNativeEnabled(true);
})();
