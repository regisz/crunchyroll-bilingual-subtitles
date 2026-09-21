/**
 * Shared UI i18n with optional language override (chrome.storage.local.uiLang).
 * chrome.i18n cannot be overridden, so we load _locales/{lang}/messages.json when needed.
 */
(function (global) {
    let uiLangOverride = "auto"; // auto | hu | en
    let messageCatalog = null;

    function formatCatalogMessage(entry, substitutions) {
        if (!entry) return "";
        let msg = String(entry.message || "");
        const subs = Array.isArray(substitutions) ? substitutions : [];
        if (entry.placeholders && typeof entry.placeholders === "object") {
            Object.keys(entry.placeholders).forEach((name) => {
                const content = String((entry.placeholders[name] && entry.placeholders[name].content) || "");
                const m = content.match(/\$(\d+)/);
                if (!m) return;
                const val = subs[Number(m[1]) - 1];
                if (val == null) return;
                msg = msg.replace(new RegExp("\\$" + name + "\\$", "gi"), String(val));
            });
        }
        subs.forEach((val, i) => {
            msg = msg.replace(new RegExp("\\$" + (i + 1) + "(?!\\d)", "g"), String(val));
        });
        return msg;
    }

    function resolveCatalogLang(override) {
        const ov = override || "auto";
        if (ov === "hu" || ov === "en") return ov;
        const ui = (chrome.i18n && chrome.i18n.getUILanguage ? chrome.i18n.getUILanguage() : "en") || "en";
        const lower = String(ui).toLowerCase();
        if (lower.startsWith("hu")) return "hu";
        if (lower.startsWith("en")) return "en";
        return null; // other browser locales → fall back to chrome.i18n / default_locale
    }

    function t(key, fallback, substitutions) {
        if (messageCatalog && messageCatalog[key]) {
            const formatted = formatCatalogMessage(messageCatalog[key], substitutions);
            if (formatted) return formatted;
        }
        if (!global.chrome || !chrome.i18n) return fallback || key;
        const msg = substitutions
            ? chrome.i18n.getMessage(key, substitutions)
            : chrome.i18n.getMessage(key);
        return msg || fallback || key;
    }

    async function loadMessageCatalog(lang) {
        if (!lang) {
            messageCatalog = null;
            return;
        }
        const url = chrome.runtime.getURL(`_locales/${lang}/messages.json`);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to load locale ${lang} (${res.status})`);
        messageCatalog = await res.json();
    }

    function applyStaticI18n(root) {
        (root || document).querySelectorAll("[data-i18n]").forEach((el) => {
            const msg = t(el.getAttribute("data-i18n"), el.textContent);
            if (el.tagName === "TITLE") document.title = msg;
            else el.textContent = msg;
        });
        (root || document).querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
            el.placeholder = t(el.getAttribute("data-i18n-placeholder"), el.placeholder);
        });
        (root || document).querySelectorAll("[data-i18n-title]").forEach((el) => {
            el.title = t(el.getAttribute("data-i18n-title"), el.title);
        });
    }

    function applySelectLabels() {
        const langSelect = document.getElementById("lang-select");
        const modeSelect = document.getElementById("mode-select");
        const engineSelect = document.getElementById("engine-select");
        const uiLangSelect = document.getElementById("ui-lang-select");
        if (langSelect) {
            Array.from(langSelect.options).forEach((opt) => {
                const msg = t("lang_" + opt.value.replace(/-/g, "_").toLowerCase(), opt.textContent);
                if (msg) opt.textContent = msg;
            });
        }
        if (modeSelect) {
            Array.from(modeSelect.options).forEach((opt) => {
                const msg = t("mode_" + opt.value, opt.textContent);
                if (msg) opt.textContent = msg;
            });
        }
        if (engineSelect) {
            Array.from(engineSelect.options).forEach((opt) => {
                const msg = t("engine_" + opt.value.replace("_llm", ""), opt.textContent);
                if (msg) opt.textContent = msg;
            });
        }
        if (uiLangSelect) {
            Array.from(uiLangSelect.options).forEach((opt) => {
                const key = opt.getAttribute("data-i18n");
                if (key) opt.textContent = t(key, opt.textContent);
            });
        }
    }

    async function applyUiLanguage(lang, extraApply) {
        uiLangOverride = lang || "auto";
        const catalogLang = resolveCatalogLang(uiLangOverride);
        await loadMessageCatalog(catalogLang);
        if (document.documentElement) {
            document.documentElement.lang = catalogLang || (chrome.i18n.getUILanguage() || "en");
        }
        applyStaticI18n(document);
        applySelectLabels();
        if (typeof extraApply === "function") extraApply();
    }

    async function loadUiLangFromStorage() {
        const stored = await new Promise((resolve) => {
            chrome.storage.local.get({ uiLang: "auto" }, resolve);
        });
        return stored.uiLang || "auto";
    }

    global.ExtI18n = {
        t,
        applyStaticI18n,
        applySelectLabels,
        applyUiLanguage,
        loadUiLangFromStorage,
        getUiLangOverride: () => uiLangOverride
    };
})(typeof globalThis !== "undefined" ? globalThis : window);
