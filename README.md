# HSK Web App — Jade Reader v2

## Install:
1. Download all files
2. Put them all into the same folder
3. Double click the file HSK-Jade-Reader.html. It should open in a web browser. This is a web app and it just analyses Chinese text you input.


## Features to try

- **Jade / Night**: top-right. Theme setting persists in browsers that permit local storage.
- **Text / Fill / Underline**: independent toggle buttons. Underline is the initial default; several may be enabled together or all disabled.
- **HSK 3.0 / HSK 2012**: both dictionaries are independently matched when you analyse; changing the active dictionary only changes the view, NOT the saved results.
- **Click a Chinese word**: pins the word to the inspector at the top-right, shows both dictionary entries (if the word exists in both), and the corpus examples.
- **Find in vocabulary list**: moves the scrollable vocabulary list to the selected word while keeping the word inspector visible.
- **Corpus Excerpt / Full passage**: controls how much source text appears. References are rendered `III-15a` (book III, chapter 15, section a). The final item of `[book, chapter, section, occurrence]` is ignored. The matched word is highlighted in the passage, including repeated occurrences.
- **Pinyin search**: finds all matching word occurrences in the active reader and matching dictionary cards; Previous/Next navigates the occurrences.
- **Group by level**, **Hide L1/L2 in word list**, **Show alternative dictionary**, **Show corpus**, **Quick hover meaning**, and **reading text size** can all change without refreshing or reanalysing.
- **New text / Reanalyse**: collapses input after analysis but lets you return and analyse again.
- **Counts for both dictionaries**: displayed independently in the sidebar, including levels.

Note: the sidebar is scrollable. The selected-word inspector and longer vocabulary list have their own scroll areas. The reading pane can be resized with the narrow divider.

## How independent dictionary passes work

`TextAnalyser.analyse()` takes the *same cleaned input text* and a *single dictionary*. `HskApp.analyseText()` calls it once per source. Both results are kept in `HskApp.results`, a `Map` keyed by dictionary id. No dictionary ever overwrites another's tokens. Within each dictionary, longest available word wins; duplicate words prefer the lowest HSK level.

There is intentionally **no fallback from HSK 3.0 into HSK 2012** when an HSK 3.0 word is missing. Change dictionaries to see the second analysis. Exact matches from the other source are still shown for a selected word.



## Adding another colour theme

1. Add a new item to `HSK_THEMES` near the top of `HSK-Jade.js`:
   ```js
   { id:'sepia', label:'Sepia' }
   ```
2. Add a `body[data-theme="sepia"] { ... }` block in `HSK-Jade.css`, defining the same colour variables as Jade and Night.
3. No changes to the theme button event handlers are needed. The new button is generated automatically.

The Chinese font is declared **once**, independently of the themes: `--chinese-font: 'Noto Serif SC', serif;`. Noto Serif SC is loaded from Google Fonts when an Internet connection is available. This package contains no font files; with no font connection the browser must use its serif fallback.

## Adding your future unclassified dictionary

The app is ready to register a new source (but **does not load or fake that source now**). When the new file is available, load it before `HSK-Jade.js` and after the array is declared, then add the registration after app initialization, for example:

```js
window.addEventListener('load', function () {
    window.HSK_JADE_APP.registerDictionary(
        'extra',
        'Extended dictionary',
        [extraWordPlusDefnList] // one unclassified list, with [word, definition] rows
    );
});
```

A new dictionary selector appears automatically. These extra words receive an `Unclassified` label **not a misleading HSK level**. As with the two HSK dictionaries, it has its own independent analysis. If you later want a merged/fallback view, that could be a separate composite dictionary strategy without changing the existing source data.

## Main code structure

| Class | Responsibility |
|---|---|
| `SettingsStore` | All user options and optional local persistence |
| `Dictionary` | Source entries, pinyin parsing, longest-match trie |
| `DictionaryRegistry` | All independent dictionaries and exact cross-source lookup |
| `TextAnalyser` | Cleans the input and tokenises once per dictionary |
| `CorpusIndex` | Reads source passages and enriched book/chapter/reading references |
| `ReaderView` | Safe HTML output, level styling, active-word highlighting |
| `VocabularyView` | Inspector, dual definitions, examples and scrollable word list |
| `HskApp` | Event handling, switching, state and rendering |

All options are live; none need `location.reload()`.

## Testing performed

- JavaScript syntax check via Node.js.
- Chromium DOM integration with representative HSK and corpus data; no page errors.
- Independent dictionary result counts; switch between sources.
- Corpus reference `III-15a`, matched passage highlights and full/excerpt toggle.
- Theme toggle, live HSK display options, filtering and grouping, new text controls.
- Registration and display of a third non-HSK source.

The program is a practical version 2, not yet a proof against every irregular record in your external dictionaries.
