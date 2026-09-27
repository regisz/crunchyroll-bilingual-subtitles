/**
 * Netflix subtitle feasibility probe (safe to paste in DevTools Console).
 * - Does NOT read cookies / Authorization headers
 * - Redacts token-like query params from URLs
 *
 * Usage: play a title, enable English subtitles, wait ~10s, paste this, Enter.
 * Prefer DevTools copy(): right-click the logged Object → Copy object
 *   or run:  copy(window.__NF_SUB_PROBE__)
 */
(async () => {
  const TOKENISH = /^(token|sig|signature|auth|authorization|jwt|session|cookie|key|licence|license|Certificate|Widevine|playReady|x-amz-|X-Amz-|nfc|flvurl)/i;
  const SUBISH = /subtitle|caption|timedtext|ttml|dfxp|vtt|srt|webvtt|manifest|mpd|m3u8|dash|hls|nflxvideo|occ|cadmium|bif/i;

  function redactUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      const kept = [];
      u.searchParams.forEach((v, k) => {
        if (TOKENISH.test(k) || String(v).length > 80) kept.push(`${k}=<redacted>`);
        else kept.push(`${k}=${v}`);
      });
      return `${u.origin}${u.pathname}${kept.length ? "?" + kept.join("&") : ""}`;
    } catch {
      return String(raw).slice(0, 180);
    }
  }

  function brieflyDescribe(node) {
    if (!node || node.nodeType !== 1) return null;
    const id = node.id ? `#${node.id}` : "";
    const cls = (node.className && typeof node.className === "string")
      ? "." + node.className.trim().split(/\s+/).slice(0, 4).join(".")
      : "";
    const tag = node.tagName.toLowerCase();
    const text = (node.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80);
    return { tag: tag + id + cls, text: text || null };
  }

  const videos = [...document.querySelectorAll("video")].map((v, i) => {
    const tracks = [];
    try {
      for (const t of v.textTracks || []) {
        let cueCount = null;
        try { cueCount = t.cues ? t.cues.length : null; } catch { cueCount = "blocked"; }
        tracks.push({
          kind: t.kind,
          mode: t.mode,
          label: t.label || null,
          language: t.language || null,
          cueCount
        });
      }
    } catch (e) {
      tracks.push({ error: String(e.message || e) });
    }
    return {
      index: i,
      src: v.currentSrc ? redactUrl(v.currentSrc) : null,
      paused: v.paused,
      currentTime: Math.round(v.currentTime * 10) / 10,
      textTracks: tracks
    };
  });

  const selectors = [
    "track",
    "[class*='subtitle' i]",
    "[class*='caption' i]",
    "[class*='Subtitle' i]",
    "[class*='Caption' i]",
    ".player-timedtext",
    ".player-timedtext-text-container",
    "[data-uia*='subtitle' i]",
    "[data-uia*='timedtext' i]",
    ".watch-video--player-view"
  ];
  const domHits = [];
  for (const sel of selectors) {
    try {
      const all = document.querySelectorAll(sel);
      if (!all.length) continue;
      domHits.push({
        selector: sel,
        count: all.length,
        samples: [...all].slice(0, 8).map(brieflyDescribe)
      });
    } catch { /* ignore */ }
  }

  const visibleCaptionish = [...document.querySelectorAll("div,span,p")]
    .filter((el) => {
      const st = getComputedStyle(el);
      if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) return false;
      const t = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (t.length < 2 || t.length > 160) return false;
      const r = el.getBoundingClientRect();
      return r.width > 40 && r.height > 8 && r.top > innerHeight * 0.45 && r.bottom < innerHeight;
    })
    .slice(0, 12)
    .map(brieflyDescribe);

  const resources = performance.getEntriesByType("resource")
    .map((e) => ({
      name: redactUrl(e.name),
      type: e.initiatorType,
      size: e.transferSize || 0
    }))
    .filter((e) => SUBISH.test(e.name));

  const seen = new Set();
  const subtitleishResources = [];
  for (const r of resources) {
    const key = r.name.split("?")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    subtitleishResources.push(r);
    if (subtitleishResources.length >= 50) break;
  }

  // Also keep a raw short list of timedtext-ish URLs (path only) for spotting
  const timedtextUrls = performance.getEntriesByType("resource")
    .map((e) => e.name)
    .filter((u) => /timedtext|ttml|dfxp|vtt|subtitle|caption|\.xml(\?|$)/i.test(u))
    .map(redactUrl)
    .filter((u, i, a) => a.indexOf(u) === i)
    .slice(0, 20);

  const probeUrls = timedtextUrls.slice(0, 6);
  const probes = [];
  for (const url of probeUrls) {
    try {
      const res = await fetch(url, { credentials: "omit", cache: "no-store" });
      const ct = res.headers.get("content-type") || "";
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf.slice(0, 220));
      const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      const looksText = /WEBVTT|<\?xml|<tt |<transcript|Dialogue:|<div|<p |nflx/i.test(head)
        || /^[\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]{20,}/.test(head);
      probes.push({
        url: redactUrl(url),
        status: res.status,
        contentType: ct,
        byteLength: buf.byteLength,
        cleartextLikely: looksText,
        headSample: looksText ? head.replace(/\s+/g, " ").slice(0, 160) : "<binary-or-opaque>"
      });
    } catch (e) {
      probes.push({ url: redactUrl(url), error: String(e.message || e) });
    }
  }

  const clueKeys = [];
  for (const k of Object.keys(window)) {
    if (SUBISH.test(k) || /netflix|cadmium|player|NFPlayer|uiMode/i.test(k)) clueKeys.push(k);
    if (clueKeys.length >= 50) break;
  }

  const report = {
    collectedAt: new Date().toISOString(),
    page: {
      host: location.host,
      path: location.pathname,
      title: document.title
    },
    videos,
    domHits,
    visibleCaptionish,
    timedtextUrls,
    subtitleishResources,
    probes,
    windowClueKeys: clueKeys
  };

  window.__NF_SUB_PROBE__ = report;
  const text = JSON.stringify(report, null, 2);

  console.log("%c=== NETFLIX SUB PROBE ===", "color:#e50914;font-weight:bold");
  console.log(report);
  console.log(text);
  console.log("%cTip: copy(window.__NF_SUB_PROBE__)  OR right-click Object → Copy object", "color:#7dcea0");

  try {
    if (typeof copy === "function") {
      copy(text);
      console.log("%cCopied via DevTools copy().", "color:#7dcea0");
    }
  } catch { /* ignore */ }

  try {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = `netflix-sub-probe-${Date.now()}.json`;
    a.click();
  } catch { /* ignore */ }

  return report;
})();
