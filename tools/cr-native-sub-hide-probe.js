/**
 * Paste in DevTools on crunchyroll.com while English subs are visible.
 * Finds likely native subtitle nodes (excludes our dual-sub overlay).
 */
(() => {
  const ours = (el) =>
    !!(el.closest && (
      el.closest("#my-cr-dual-sub-container") ||
      el.closest("#cr-inplayer-controls-wrapper") ||
      el.id === "my-cr-dual-sub-container" ||
      el.id === "my-cr-dual-sub-text"
    ));

  const hits = [];
  const all = document.querySelectorAll("div,span,p,canvas,video");
  for (const el of all) {
    if (ours(el)) continue;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 8 || r.height > 220) continue;
    if (r.top < innerHeight * 0.45 || r.bottom > innerHeight - 8) continue;
    const cls = (el.className && String(el.className)) || "";
    const text = (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const interesting =
      /subtitle|caption|cue|bmpui|vilos|text-track|ass|libjass/i.test(cls) ||
      el.tagName === "CANVAS" ||
      (text.length >= 2 && text.length <= 80 && /[A-Za-zÀ-ÿ]/.test(text));
    if (!interesting) continue;
    hits.push({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      className: cls.slice(0, 160),
      text: text || null,
      rect: {
        top: Math.round(r.top),
        left: Math.round(r.left),
        w: Math.round(r.width),
        h: Math.round(r.height)
      },
      inPlayer: !!(el.closest(".bitmovinplayer-container") || el.closest("#player-container"))
    });
    if (hits.length >= 25) break;
  }

  const canvases = [...document.querySelectorAll("canvas")].map((c) => {
    const r = c.getBoundingClientRect();
    return {
      className: String(c.className || "").slice(0, 120),
      w: Math.round(r.width),
      h: Math.round(r.height),
      top: Math.round(r.top),
      parent: c.parentElement
        ? (c.parentElement.className || c.parentElement.tagName).toString().slice(0, 120)
        : null
    };
  });

  const report = {
    host: location.host,
    path: location.pathname,
    hits,
    canvases: canvases.slice(0, 15),
    hasBmpuiSubtitle: !!document.querySelector(".bmpui-ui-subtitle-overlay, [class*='bmpui-ui-subtitle']"),
    hasOurOverlay: !!document.getElementById("my-cr-dual-sub-container"),
    hideStylePresent: !!document.getElementById("cr-hide-native-subs-style")
  };
  console.log("%c=== CR NATIVE SUB HIDE PROBE ===", "color:#f47521;font-weight:bold");
  console.log(report);
  try {
    if (typeof copy === "function") copy(JSON.stringify(report, null, 2));
  } catch (e) { /* ignore */ }
  return report;
})();
