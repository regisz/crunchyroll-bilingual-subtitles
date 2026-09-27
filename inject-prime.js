// inject-prime.js — MAIN world: intercept Prime Video cleartext TTML2 timed text
(function() {
    if (window.__PV_DUAL_SUBS_INJECTED__) return;
    window.__PV_DUAL_SUBS_INJECTED__ = true;

    console.log("[Prime Bilingual Subtitles] Network interceptor loaded");

    function isTimedTextUrl(url) {
        if (!url) return false;
        const u = String(url);
        return /\.ttml2?(?:\?|$)/i.test(u)
            || /\.dfxp(?:\?|$)/i.test(u)
            || /cf-timedtext/i.test(u)
            || (/pv-cdn\.net/i.test(u) && /timedtext|subtitle|caption/i.test(u));
    }

    function emitTtml(payload) {
        const slim = {
            platform: "prime",
            url: payload.url || "",
            text: payload.text || "",
            contentType: payload.contentType || ""
        };
        if (!slim.text || slim.text.length < 40) return;
        if (!/<\s*tt[\s>]|<\s*p[\s>]/i.test(slim.text)) return;

        const serialized = JSON.stringify(slim);

        try {
            const root = document.documentElement;
            root.setAttribute("data-pv-dual-subs", serialized);
            root.dispatchEvent(new Event("pv-dual-subs-ready", { bubbles: true }));
        } catch (e) {
            console.warn("[Prime Bilingual Subtitles] DOM bridge failed", e);
        }

        try {
            window.postMessage({
                source: "PV_DUAL_SUBS",
                type: "PV_SUBTITLE_DATA",
                payload: slim
            }, "*");
        } catch (e) {
            console.warn("[Prime Bilingual Subtitles] postMessage failed", e);
        }

        console.log("[Prime Bilingual Subtitles] TTML captured", {
            url: slim.url.slice(0, 120),
            bytes: slim.text.length
        });
    }

    function handleResponseText(url, text, contentType) {
        try {
            emitTtml({ url, text, contentType });
        } catch (e) {
            console.warn("[Prime Bilingual Subtitles] emit failed", e);
        }
    }

    // --- fetch ---
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const response = await originalFetch.apply(this, args);

        let reqUrl = "";
        if (typeof args[0] === "string") {
            reqUrl = args[0];
        } else if (args[0] && typeof args[0] === "object") {
            reqUrl = args[0].url || args[0].href || String(args[0]);
        }

        if (isTimedTextUrl(reqUrl) && response && response.ok) {
            const clone = response.clone();
            clone.text().then((text) => {
                handleResponseText(reqUrl, text, response.headers.get("content-type") || "");
            }).catch(() => {});
        }

        return response;
    };

    // --- XHR (Prime may use either) ---
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this.__pvDualSubsUrl = typeof url === "string" ? url : (url && url.url) || "";
        return originalOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function(...args) {
        if (isTimedTextUrl(this.__pvDualSubsUrl)) {
            this.addEventListener("load", function() {
                if (this.status >= 200 && this.status < 300) {
                    handleResponseText(
                        this.__pvDualSubsUrl,
                        this.responseText || "",
                        this.getResponseHeader("content-type") || ""
                    );
                }
            });
        }
        return originalSend.apply(this, args);
    };
})();
