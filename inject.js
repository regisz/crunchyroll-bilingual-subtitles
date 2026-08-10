// inject.js — MAIN world: intercept CR playback manifests and bridge to content.js
(function() {
    if (window.__CR_DUAL_SUBS_INJECTED__) return;
    window.__CR_DUAL_SUBS_INJECTED__ = true;

    console.log("[CR Bilingual Subtitles] Network interceptor loaded");

    const originalFetch = window.fetch;
    const retryBackoffs = {};

    function slimPlaybackData(data) {
        return {
            subtitles: data.subtitles || null,
            captions: data.captions || null,
            versions: (data.versions || []).map(v => ({
                guid: v.guid,
                audio_locale: v.audio_locale,
                original: !!v.original
            })),
            assetId: data.assetId || null,
            token: data.token || null
        };
    }

    function emitSubtitleData(payload) {
        const slim = {
            url: payload.url,
            options: { headers: payload.options && payload.options.headers ? payload.options.headers : {} },
            data: slimPlaybackData(payload.data)
        };
        const serialized = JSON.stringify(slim);

        // 1) DOM attribute + Event — most reliable across isolated worlds
        try {
            const root = document.documentElement;
            root.setAttribute("data-cr-dual-subs", serialized);
            root.dispatchEvent(new Event("cr-dual-subs-ready", { bubbles: true }));
        } catch (e) {
            console.warn("[CR Bilingual Subtitles] DOM bridge failed", e);
        }

        // 2) postMessage backup
        try {
            window.postMessage({
                source: "CR_DUAL_SUBS",
                type: "CR_SUBTITLE_DATA",
                payload: slim
            }, "*");
        } catch (e) {
            console.warn("[CR Bilingual Subtitles] postMessage failed", e);
        }

        console.log("[CR Bilingual Subtitles] Playback manifest captured", {
            subs: slim.data.subtitles ? Object.keys(slim.data.subtitles) : [],
            caps: slim.data.captions ? Object.keys(slim.data.captions) : []
        });
    }

    function isPlaybackUrl(url) {
        if (!url) return false;
        const u = String(url);
        return u.includes("/playback/") && u.includes("/play");
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
            const clone = response.clone();
            const retryKey = reqUrl;

            clone.json().then(data => {
                if (data && (data.subtitles || data.captions)) {
                    emitSubtitleData({
                        url: reqUrl,
                        options: { headers: safeHeaders },
                        data: data
                    });
                    delete retryBackoffs[retryKey];
                }
            }).catch(() => {
                updateBackoff(retryKey);
            });
        }

        return response;
    };

    function updateBackoff(key) {
        const current = retryBackoffs[key] || 500;
        retryBackoffs[key] = Math.min(current * 2, 4000);
    }
})();
