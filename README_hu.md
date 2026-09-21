# Crunchyroll AI kétnyelvű feliratok

<p align="center">
  <b>Nagy pontosságú AI kétnyelvű feliratbővítmény a Crunchyrollhoz</b><br>
  <span>Valós idejű kettős felirat, szolgáltató-tudatos LLM-ekkel, cue-alapú igazítással és külön beállítófelülettel</span>
</p>

<p align="center">
  <a href="README.md"><b>English documentation</b></a>
  &nbsp;·&nbsp;
  <a href="README_zh.md"><b>中文文档 (kínai)</b></a>
</p>

---

## Áttekintés

A **Crunchyroll AI Bilingual Subtitles** egy Chrome-bővítmény, amely valós idejű, kontextusérzékeny kétnyelvű feliratokat ad a Crunchyrollhoz. Megkerüli az oldal Content Security Policy (CSP) korlátait, több LLM-szolgáltatóval beszél, és szükség esetén a Google Fordítóra tud esni.

A fordítások **cue-index** szerint vannak kulcsolva (rövid környezettel), így ugyanaz az angol sor más jelenetben más fordítást kaphat, és az LLM batch válaszok 1:1 igazítását a megjelenítés előtt ellenőrzi a bővítmény.

---

## Funkciók

- **AI kétnyelvű felirat** — kettős nyelvű megjelenítés egyéni LLM-mel vagy Google Fordítóval.
- **Több szolgáltató, külön API-kulcsok** — OpenAI, Google Gemini, Anthropic Claude, OpenRouter és egyéni, OpenAI-kompatibilis végpontok.
- **Élő modelllista** — a beállított szolgáltatók chat-modelljeinek betöltése (szolgáltatónkénti OK / hiba státusz); hosszú listánál szűrés.
- **Popup + teljes beállítások** — gyors vezérlők az eszköztár-popupban; szolgáltató / modell / debug a teljes beállítások oldalon.
- **Fordítási módok** — hivatalos először AI visszaeséssel, kényszerített AI, vagy csak hivatalos.
- **Streaming és reasoning** — opcionális élő streaming fordítás; opcionális mélyebb reasoning a támogatott modelleknél.
- **Cue-index cache + előtöltési ablak** — cue szerint cache-el, néhány percet előre fordít, nem az egész epizódot egyszerre.
- **Lejátszón belüli stílus** — betűméret, szín, háttér átlátszóság és függőleges pozíció a videó fölött.
- **Angol felirat letöltése** — a popupból, ha van angol sáv az epizódon.
- **Debug oldal** — legutóbbi kérés / modellkatalógus hibák DevTools nélkül.
- **32 célnyelv** — fordítás 32 locale-re (magyar is).
- **Felületi lokalizáció** — 16 böngésző-locale a `_locales` alatt, plusz opcionális **Beállítások nyelve** felülírás (`auto` / magyar / angol) az options, popup és debug oldalakon.

---

## Nyelvi képességek

### Célnyelvek (32)

| Régió / család | Nyelvek |
| :--- | :--- |
| **Kelet-ázsiai** | Egyszerűsített kínai (`zh-CN`), hagyományos kínai (`zh-HK`), japán (`ja-JP`), koreai (`ko-KR`) |
| **Európai és nyugati** | Angol (`en-US`), spanyol - LA (`es-419`), spanyol - ES (`es-ES`), portugál - BR (`pt-BR`), francia (`fr-FR`), német (`de-DE`), olasz (`it-IT`), orosz (`ru-RU`), lengyel (`pl-PL`), holland (`nl-NL`), svéd (`sv-SE`), finn (`fi-FI`), norvég (`no-NO`), dán (`da-DK`), cseh (`cs-CZ`), magyar (`hu-HU`), román (`ro-RO`), ukrán (`uk-UA`), görög (`el-GR`) |
| **Közel-keleti és ázsiai** | Arab (`ar-SA`), török (`tr-TR`), héber (`he-IL`), hindi (`hi-IN`), vietnámi (`vi-VN`), thai (`th-TH`), indonéz (`id-ID`), maláj (`ms-MY`), tagalog (`tl-PH`) |

### Felületi nyelvek (16)

A `_locales` alatt (alapból a böngésző nyelve szerint):

- Angol (`en`), magyar (`hu`), egyszerűsített kínai (`zh_CN`), hagyományos kínai (`zh_TW`), japán (`ja`), koreai (`ko`)
- Spanyol (`es`), francia (`fr`), német (`de`), orosz (`ru`), portugál - BR (`pt_BR`)
- Vietnámi (`vi`), thai (`th`), indonéz (`id`), maláj (`ms`), arab (`ar`)

A **teljes beállítások** oldalon a felület nyelve felülírható: **Automatikus (böngésző)**, **Magyar** vagy **Angol**. Ez a popupra és a debug oldalra is érvényes.

---

## Telepítés

1. Klónozd vagy töltsd le a repót:
   ```bash
   git clone https://github.com/regisz/crunchyroll-bilingual-subtitles.git
   ```
2. Nyisd meg a Chrome-ban: `chrome://extensions/`.
3. Kapcsold be a **Fejlesztői módot**.
4. **Kicsomagolt bővítmény betöltése**, majd válaszd ki a projekt mappáját.

---

## Használat és beállítás

1. Az **eszköztár-popup** a gyors nyelv / mód / motor / modell vezérléshez; a **Teljes beállítások megnyitása** a részletes oldalhoz.
2. Válaszd ki a **Cél nyelvet** (feliratfordítás nyelve — 32 opció).
3. Válaszd ki a **Fordítási módot**:
   - **Elsőként hivatalos, majd AI visszaesés** — hivatalos felirat, ha van; hiányzó részeket AI pótolja.
   - **AI fordítás kényszerítése** — mindig AI.
   - **Csak hivatalos** — csak hivatalos felirat, AI nélkül.
4. Válaszd ki a **Fordítási motort**: Google ingyenes fordítás, vagy **Egyéni LLM**.
5. Egyéni LLM-hez (teljes beállítások):
   - Add meg a használt **szolgáltatók API-kulcsait** (OpenAI, Gemini, Claude, OpenRouter, Custom).
   - **Custom** esetén állíts OpenAI-kompatibilis API URL-t, ha kell.
   - **Összes modell betöltése**, válassz modellt (hosszú listánál szűrő), opcionálisan exportáld a listát.
   - Állítsd a **batch size**, **concurrency**, **reasoning** és **streaming** értékeket.
6. Opcionálisan állítsd a **Beállítások nyelvét** (csak UI: auto / magyar / angol) — váltáskor azonnal mentődik.
7. Kattints a **Mentés** gombra (és töltsd újra a Crunchyroll lapot, ha már nyitva volt). Hibánál: **Hibakeresés megnyitása**.

---

## Licenc

GNU General Public License v3.0 — lásd a [LICENSE](LICENSE) fájlt.

---

## Közreműködés

Issue-k és pull requestek szívesen fogadottak.
