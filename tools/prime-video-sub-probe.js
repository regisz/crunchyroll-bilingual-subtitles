/**
 * Prime Video subtitle feasibility probe (safe to paste in DevTools Console).
 * - Does NOT read cookies / Authorization headers
 * - Redacts token-like query params from URLs
 * Copy the printed JSON block back into chat.
 *
 * Usage: play video, enable English subtitles, wait ~10s, paste this, Enter.
 */
(async () => {
  const TOKENISH = /^(token|sig|signature|auth|authorization|jwt|session|cookie|key|licence|license|Certificate|Widevine|playReady|x-amz-|X-Amz-)/i;
  const SUBISH = /subtitle|caption|timedtext|ttml|dfxp|vtt|srt|webvtt|manifest|mpd|m3u8|dash|hls|forcedNarratives|subtitleUrls|timedTextUrls/i;

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

  // --- video + TextTrack ---
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

  // --- DOM candidates ---
  const selectors = [
    "track",
    "[class*='subtitle' i]",
    "[class*='caption' i]",
    "[class*='Subtitle' i]",
    "[class*='Caption' i]",
    "[data-testid*='subtitle' i]",
    "[data-testid*='caption' i]",
    ".atvwebplayersdk-captions-text",
    ".atvwebplayersdk-captions-overlay",
    ".webPlayerUIContainer"
  ];
  const domHits = [];
  for (const sel of selectors) {
    try {
      const nodes = [...document.querySelectorAll(sel)].slice(0, 8);
      if (!nodes.length) continue;
      domHits.push({
        selector: sel,
        count: document.querySelectorAll(sel).length,
        samples: nodes.map(brieflyDescribe)
      });
    } catch { /* invalid selector in older engines */ }
  }

  // visible caption-ish text near player
  const visibleCaptionish = [...document.querySelectorAll("div,span,p")]
    .filter((el) => {
      const st = getComputedStyle(el);
      if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) return false;
      const t = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (t.length < 2 || t.length > 160) return false;
      const r = el.getBoundingClientRect();
      // lower half of viewport = typical subtitle band
      return r.width > 40 && r.height > 8 && r.top > innerHeight * 0.55 && r.bottom < innerHeight;
    })
    .slice(0, 12)
    .map(brieflyDescribe);

  // --- network resources already loaded (no headers/cookies) ---
  const resources = performance.getEntriesByType("resource")
    .map((e) => ({
      name: redactUrl(e.name),
      type: e.initiatorType,
      size: e.transferSize || 0
    }))
    .filter((e) => SUBISH.test(e.name));

  // unique-ish
  const seen = new Set();
  const subtitleishResources = [];
  for (const r of resources) {
    const key = r.name.split("?")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    subtitleishResources.push(r);
    if (subtitleishResources.length >= 40) break;
  }

  // try a few cleartext GETs only for same-origin-ish / likely open subtitle URLs (no cookies sent? fetch defaults credentials:same-origin)
  // Use credentials:'omit' to avoid attaching session cookies to the probe responses we echo back.
  const probeUrls = subtitleishResources
    .map((r) => r.name)
    .filter((u) => /\.(vtt|ttml|dfxp|srt|xml)(\?|$)/i.test(u) || /timedtext|subtitle|caption/i.test(u))
    .slice(0, 5);

  const probes = [];
  for (const url of probeUrls) {
    try {
      const res = await fetch(url, { credentials: "omit", cache: "no-store" });
      const ct = res.headers.get("content-type") || "";
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf.slice(0, 200));
      const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      const looksText = /WEBVTT|<\?xml|<tt |<transcript|Dialogue:|^\d+\s*$/m.test(head) || /^[\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]{20,}/.test(head);
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

  // lightweight global clues (no secrets)
  const clueKeys = [];
  for (const k of Object.keys(window)) {
    if (SUBISH.test(k) || /atv|PVPlayer|player|webPlayer/i.test(k)) clueKeys.push(k);
    if (clueKeys.length >= 40) break;
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
    subtitleishResources,
    probes,
    windowClueKeys: clueKeys
  };

  const text = JSON.stringify(report, null, 2);
  console.log("%c=== PRIME VIDEO SUB PROBE ===", "color:#f47521;font-weight:bold");
  console.log(report);
  console.log(text);
  console.log("%c=== END PROBE ===", "color:#f47521;font-weight:bold");

  // Chrome DevTools has a privileged copy() helper; navigator.clipboard often fails here.
  let copied = false;
  try {
    if (typeof copy === "function") {
      copy(text);
      copied = true;
    }
  } catch { /* ignore */ }
  if (!copied) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch { /* ignore */ }
  }
  if (!copied) {
    try {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      a.download = `prime-sub-probe-${Date.now()}.json`;
      a.click();
      console.log("%cDownload started (prime-sub-probe-*.json).", "color:#7dcea0");
    } catch {
      console.log(
        "%cManual copy: right-click the Object above → Copy object\n" +
          "or expand the string log → Select all → Copy",
        "color:#e6b35a"
      );
    }
  } else {
    console.log("%cCopied to clipboard.", "color:#7dcea0");
  }

  return report;
})();
