/* HSK WEB APP — JADE READER (VERSION 2)
   ============================================================
   DESIGN NOTES
   1. All dictionaries are imported ONCE, without being changed.
   2. Each dictionary analyses the same input INDEPENDENTLY.
   3. The UI switches between saved results, not between overwritten words.
   4. The view (HTML) is separate from matching and corpus handling.
   5. Settings can be changed at any time: NEVER require a reload.

   No jQuery required. The existing external dictionary arrays remain as they are.
   Classes: SettingsStore, Dictionary, DictionaryRegistry, TextAnalyser,
            CorpusIndex, ReaderView, VocabularyView, HskApp.
*/

'use strict';

const HSK_MAX_INPUT = 20000;

// THEMES: add one row here, then add a body[data-theme="..."]
// variable block in the CSS. No new event-handler code is required.
const HSK_THEMES = [
    { id:'jade',  label:'☀ Jade' },
    { id:'night', label:'☾ Night' }
];
const HSK_DEMO_TEXT = '昨天我和朋友去了图书馆。我们想找一本关于中国历史的书。\n\n图书馆里很安静，大家都在认真地学习。虽然外面下着雨，但是我们觉得很舒服。';

function byId(id) { return document.getElementById(id); }
function element(tag, cssClass = '', text = null) {
    const node = document.createElement(tag);
    if (cssClass) node.className = cssClass;
    if (text !== null) node.textContent = String(text);
    return node;
}
function clear(node) { node.replaceChildren(); }
function normalizedPinyin(text) {
    return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9üv]/g, '');
}
function isChinese(text) { return /\p{Script=Han}/u.test(text); }
function roman(n) {
    const r = ['','I','II','III','IV','V','VI','VII','VIII','IX','X'];
    return r[Number(n)] || String(n || '?');
}
function readingLetter(v) {
    if (typeof v === 'string' && /^[a-z]$/i.test(v)) return v.toLowerCase();
    if (typeof v === 'number' || /^\d+$/.test(String(v))) {
        const value = Number(v);
        if (value >= 1 && value <= 26) return String.fromCharCode(96 + value);
        if (value === 0) return 'a';
    }
    return String(v ?? 'a').replace(/[^a-z\d]/gi, '').toLowerCase() || 'a';
}
function sourceCode(book, chapter, reading) {
    const b = typeof book === 'string' && /^[IVX]+$/i.test(book) ? book.toUpperCase() : roman(book);
    return `${b}-${chapter || '?'}${readingLetter(reading)}`;
}
function trimGloss(text, max = 175) {
    let result = String(text || '').trim();
    return result.length > max ? result.slice(0, max - 1) + '…' : result;
}

/* -------- Settings: everything can change during the session -------- */
class SettingsStore {
    constructor() {
        this.values = {
            theme: 'jade', activeDictionary: 'hsk3',
            highlight: { text: false, background: false, underline: true },
            hoverHelp: true, showCorpus: true, corpusView: 'excerpt', showOtherDictionary: true,
            groupByLevel: false, hideLowerLevels: false, fontSize: 23
        };
        try {
            const saved = JSON.parse(localStorage.getItem('hsk-jade-v2-settings') || 'null');
            if (saved) {
                // Merge rather than replace: new settings can be introduced later.
                this.values = { ...this.values, ...saved,
                    highlight: { ...this.values.highlight, ...(saved.highlight || {}) } };
            }
        } catch (error) { /* Private browsing or blocked local storage: ignore. */ }
        if (!HSK_THEMES.some(t => t.id === this.values.theme)) this.values.theme = 'jade';
    }
    get(key) { return this.values[key]; }
    set(key, value) { this.values[key] = value; this.save(); }
    setHighlight(mode, enabled) { this.values.highlight[mode] = enabled; this.save(); }
    save() {
        try { localStorage.setItem('hsk-jade-v2-settings', JSON.stringify(this.values)); }
        catch (error) { /* Session settings still work in memory. */ }
    }
}

/* -------- Dictionaries: source objects are never mutated -------- */
class Dictionary {
    constructor(id, label, levelArrays, options = {}) {
        this.hasLevels = options.hasLevels !== false;
        this.id = id;
        this.label = label;
        this.entries = new Map();
        this.trie = { next: new Map(), entries: [] };
        this.load(levelArrays || []);
    }
    load(levelArrays) {
        levelArrays.forEach((arr, levelIndex) => {
            if (!Array.isArray(arr)) return;
            for (const item of arr) {
                if (!Array.isArray(item) || typeof item[0] !== 'string') continue;
                const word = item[0].trim();
                if (!word) continue;
                const definition = this.parseDefinition(word, item[1]);
                const entry = {
                    id: this.id, source: this.label, word, level: this.hasLevels ? levelIndex + 1 : null,
                    pinyin: definition.pinyin, pinyinKey: normalizedPinyin(definition.pinyin),
                    meaning: definition.meaning, raw: String(item[1] || ''),
                    refs: Array.isArray(item[2]) ? item[2] : []
                };
                // Within one dictionary, prefer the LOWEST level for duplicate terms.
                const prior = this.entries.get(word);
                if (!prior || (entry.level !== null && entry.level < prior.level)) this.entries.set(word, entry);
                else if (prior && !prior.refs.length && entry.refs.length) prior.refs = entry.refs;
            }
        });
        // Trie avoids scanning every dictionary word against every passage.
        for (const entry of this.entries.values()) {
            let node = this.trie;
            for (const char of entry.word) {
                if (!node.next.has(char)) node.next.set(char, { next: new Map(), entries: [] });
                node = node.next.get(char);
            }
            node.entries.push(entry);
        }
    }
    parseDefinition(word, raw) {
        // Current format: "汉字<TAB>pinyin<TAB>English definition".
        // Some older files contain irregular spacing, hence these fallbacks.
        const text = String(raw || '').trim();
        const fields = text.split(/\t+/).map(s => s.trim()).filter(Boolean);
        let pinyin = '', meaning = '';
        if (fields.length >= 3) {
            const first = fields[0];
            const firstIsWord = first.includes(word) || isChinese(first);
            pinyin = fields[firstIsWord ? 1 : 0] || '';
            meaning = fields.slice(firstIsWord ? 2 : 1).join(' · ');
        } else if (fields.length === 2) {
            if (isChinese(fields[0])) {
                const rest = fields[1].match(/^([a-zA-Z\u00c0-\u01ff\s:üÜ]+?)\s{2,}(.+)$/);
                pinyin = rest ? rest[1].trim() : '';
                meaning = rest ? rest[2].trim() : fields[1];
            } else { pinyin = fields[0]; meaning = fields[1]; }
        } else if (fields.length === 1) {
            meaning = fields[0].startsWith(word) ? fields[0].slice(word.length).trim() : fields[0];
        }
        // Remove any accidental Chinese headword prefix from the English gloss.
        if (meaning.startsWith(word)) meaning = meaning.slice(word.length).trim();
        return { pinyin, meaning: meaning || '(Definition not provided)' };
    }
    find(word) { return this.entries.get(word) || null; }
    match(characters, position) {
        let node = this.trie, best = null, index = position;
        while (index < characters.length && node.next.has(characters[index])) {
            node = node.next.get(characters[index]);
            index++;
            // Longest word is preferred; a same-length tie was resolved on load.
            if (node.entries.length) best = { entry:node.entries[0], start:position, end:index };
        }
        return best;
    }
}

class DictionaryRegistry {
    constructor() { this.sources = new Map(); }
    register(id, label, levels, options = {}) {
        const dictionary = new Dictionary(id, label, levels, options);
        this.sources.set(id, dictionary);
        return dictionary;
    }
    get(id) { return this.sources.get(id); }
    otherEntries(word, activeId) {
        return [...this.sources.values()].filter(d => d.id !== activeId)
            .map(d => d.find(word)).filter(Boolean);
    }
}

/* -------- Reading analysis (one complete pass per dictionary) -------- */
class TextAnalyser {
    cleanInput(raw) {
        const lines = String(raw).replace(/\r\n?/g, '\n').split('\n');
        const result = [];
        let pendingBlank = false;
        for (const original of lines) {
            if (!original.trim()) { if (result.length) pendingBlank = true; continue; }
            const cleaned = original.replace(/\p{Script=Latin}+(?:['’\-]\p{Script=Latin}+)*/gu, '')
                .replace(/[ \t]{2,}/g, ' ').trim();
            if (!isChinese(cleaned)) continue;
            if (result.length) result.push(pendingBlank ? '\n\n' : '\n');
            result.push(cleaned);
            pendingBlank = false;
        }
        return result.join('').slice(0, HSK_MAX_INPUT);
    }
    analyse(text, dictionary) {
        const characters = Array.from(text);
        const tokens = [], distinct = new Map(), levelCounts = new Map();
        const unknown = new Set();
        for (let i = 0; i < characters.length;) {
            const found = dictionary.match(characters, i);
            if (found) {
                const { entry, start, end } = found;
                tokens.push({ kind:'word', entry, start, end, text:characters.slice(start,end).join('') });
                if (!distinct.has(entry.word)) {
                    distinct.set(entry.word, { entry, firstAt:start, occurrences:1 });
                    levelCounts.set(entry.level, (levelCounts.get(entry.level) || 0) + 1);
                } else distinct.get(entry.word).occurrences++;
                i = end;
            } else {
                const char = characters[i];
                tokens.push({ kind:isChinese(char) ? 'unknown' : 'plain', text:char, start:i, end:i+1 });
                if (isChinese(char)) unknown.add(char);
                i++;
            }
        }
        return { id: dictionary.id, text, tokens, distinct, levelCounts, unknown,
            totalWords: tokens.filter(t => t.kind === 'word').length };
    }
}

/* -------- Corpus: index book/chapter/readings once, on demand --------
   Enriched dictionary refs are arrays [book, chapter, reading, count].
   The fourth value is only the count of occurrences: never display it.

   Corpus records can be strings, nested arrays, or objects containing
   book/chapter/reading/text fields. Your corpus files aren't embedded
   in this package, so the adapter tolerates several legacy shapes.
*/
class CorpusIndex {
    constructor(raw) {
        this.records = [];
        this.cache = new Map();
        this.createIndex(raw);
    }
    createIndex(raw) {
        const seen = new Set();
        const add = (text, location = {}) => {
            if (typeof text !== 'string' || !isChinese(text) || text.length < 8) return;
            const key = `${location.book}|${location.chapter}|${location.reading}|${text}`;
            if (seen.has(key)) return;
            seen.add(key);
            this.records.push({ text, book:location.book, chapter:location.chapter,
                reading:location.reading, key });
        };
        const walk = (node, meta = {}, depth = 0) => {
            if (depth > 14 || node == null) return;
            if (typeof node === 'string') { add(node, meta); return; }
            if (Array.isArray(node)) {
                // Common record form: [book, chapter, reading, passage].
                if (node.length >= 4 && node.slice(0,3).every(x => typeof x === 'number' || typeof x === 'string')
                    && typeof node[3] === 'string' && isChinese(node[3])) {
                    add(node[3], { book:node[0], chapter:node[1], reading:node[2] });
                    return;
                }
                node.forEach((item,index) => {
                    const m = { ...meta };
                    // When only three corpus books were loaded, entries 0/1/2
                    // correspond to the HSK L3/L4/L5 texts.
                    if (depth === 0 && m.book == null) m.book = node.length === 3 ? index+3 : index;
                    if (depth === 1 && m.chapter == null) m.chapter = index+1;
                    if (depth === 2 && m.reading == null) m.reading = index+1;
                    walk(item, m, depth+1);
                });
                return;
            }
            if (typeof node === 'object') {
                const m = { ...meta, book:node.book ?? node.bookNumber ?? node.level ?? meta.book,
                    chapter:node.chapter ?? node.chapterNumber ?? meta.chapter,
                    reading:node.reading ?? node.section ?? node.readingNumber ?? meta.reading };
                for (const field of ['text','content','passage','chinese','body']) {
                    if (typeof node[field] === 'string') { add(node[field],m); return; }
                }
                // Skip non-corpus metadata but allow arbitrary chapters/sections.
                for (const [key,value] of Object.entries(node)) {
                    if (['book','bookNumber','level','chapter','chapterNumber','reading','readingNumber','section','count','occurrences','english','translation','pinyin'].includes(key)) continue;
                    walk(value,m,depth+1);
                }
            }
        };
        walk(raw);
    }
    formatRef(ref) {
        if (!Array.isArray(ref)) return null;
        const [book,chapter,reading] = ref;  // Ignore ref[3], the occurrence count.
        if (book == null || chapter == null || reading == null) return null;
        return { book, chapter, reading, code:sourceCode(book,chapter,reading) };
    }
    snippet(text, word) {
        // Show one sentence either side where possible, but keep line breaks.
        const pieces = text.split(/(?<=[。！？!?；;])|\n+/u).map(s => s.trim()).filter(Boolean);
        const at = pieces.findIndex(s => s.includes(word));
        if (at < 0) return trimGloss(text,240);
        return pieces.slice(Math.max(0,at-1),Math.min(pieces.length,at+2)).join('\n');
    }
    find(word, references = []) {
        const refs = (Array.isArray(references) ? references : []).map(ref => this.formatRef(ref)).filter(Boolean);
        const cacheKey = word + '|' + refs.map(ref => ref.code).join(',');
        if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
        const all = [], ids = new Set();
        for (const rec of this.records) {
            if (!rec.text.includes(word)) continue;
            // Prefer explicit linked metadata for the same book/chapter/reading.
            const matchingRef = refs.find(r => String(r.book) === String(rec.book)
                && String(r.chapter) === String(rec.chapter)
                && readingLetter(r.reading) === readingLetter(rec.reading));
            const ref = matchingRef || { book:rec.book,chapter:rec.chapter,reading:rec.reading };
            const code = sourceCode(ref.book,ref.chapter,ref.reading);
            const snippet = this.snippet(rec.text,word);
            const id = code + '|' + snippet;
            if (!ids.has(id)) { ids.add(id); all.push({ ...ref, code, text:snippet, fullText:rec.text }); }
        }
        // Even where the texts cannot be read, retain accurate enriched refs.
        for (const ref of refs) {
            if (all.some(x => x.code === ref.code)) continue;
            all.push({ ...ref, text:'', fullText:'' });
        }
        all.sort((a,b) => Number(a.book)-Number(b.book) || Number(a.chapter)-Number(b.chapter)
            || String(a.reading).localeCompare(String(b.reading)));
        this.cache.set(cacheKey,all);
        return all;
    }
}

/* -------- Reading pane -------- */
class ReaderView {
    constructor(app) { this.app = app; this.node = byId('chineseOutput'); }
    render(result) {
        clear(this.node);
        if (!result || !result.text) {
            this.node.append(element('p','empty-reader','Paste Chinese text and select Analyse text.'));
            return;
        }
        const fragment = document.createDocumentFragment();
        // Adjacent plain characters are collected to keep DOM size manageable.
        let plain = '';
        const flush = () => { if (plain) { fragment.append(document.createTextNode(plain));plain=''; } };
        for (const token of result.tokens) {
            if (token.kind === 'plain') { plain += token.text; continue; }
            flush();
            const span = element('span',token.kind === 'word'?'reading-word':'reading-unknown',token.text);
            span.tabIndex = 0;
            span.dataset.word = token.entry?.word || token.text;
            if (token.entry) {
                if (token.entry.level !== null) span.dataset.level = Math.min(7,token.entry.level);
                span.dataset.pinyin = token.entry.pinyinKey;
                span.dataset.position = token.start;
                span.setAttribute('aria-label',`${token.entry.word}, ${token.entry.level === null ? 'general dictionary' : 'level ' + token.entry.level}`);
            } else span.title = 'Not found in the active dictionary';
            fragment.append(span);
        }
        flush();
        this.node.append(fragment);
        this.refreshSelected();
    }
    refreshSelected() {
        const selected = this.app.selectedWord;
        this.node.querySelectorAll('.reading-word,.reading-unknown').forEach(node => {
            node.classList.toggle('selected', Boolean(selected && node.dataset.word === selected));
        });
    }
    applySearch(query) {
        let total = 0;
        this.node.querySelectorAll('.reading-word').forEach(node => {
            const match = Boolean(query && node.dataset.pinyin.includes(query));
            node.classList.toggle('search-match',match);
            if (match) total++;
        });
        return total;
    }
}

/* -------- Vocabulary pane: selected word + full list -------- */
class VocabularyView {
    constructor(app) { this.app = app; this.inspector = byId('wordInspector'); this.list = byId('definitionsList'); }
    renderList(result) {
        clear(this.list);
        if (!result) return;
        let entries = [...result.distinct.values()];
        if (this.app.settings.get('hideLowerLevels')) entries = entries.filter(x => x.entry.level === null || x.entry.level > 2);
        const group = this.app.settings.get('groupByLevel');
        if (group) entries.sort((a,b) => (a.entry.level ?? 99) - (b.entry.level ?? 99) || a.firstAt - b.firstAt);
        let currentLevel = 0;
        entries.forEach((item,index) => {
            const ent = item.entry;
            if (group && ent.level !== currentLevel) {
                this.list.append(element('div','level-group-heading',`${this.app.registry.get(result.id).label} — ${ent.level === null ? 'Unclassified' : 'Level ' + ent.level}`));
                currentLevel = ent.level;
            }
            const card = element('button','definition-card');
            card.type = 'button';card.dataset.word = ent.word;card.dataset.pinyin = ent.pinyinKey;
            card.id = 'word-entry-' + index;
            card.setAttribute('aria-label',`Select ${ent.word}`);
            const number = element('span','entry-index',String(index+1).padStart(2,'0'));
            const content = element('div','entry-content');
            const line = element('div','entry-title');
            line.append(element('span','entry-word',ent.word),element('span','entry-pinyin',ent.pinyin));
            content.append(line,element('div','entry-meaning',trimGloss(ent.meaning,150)));
            card.append(number,content,element('span','entry-level',ent.level === null ? 'Extra' : 'L'+ent.level));
            this.list.append(card);
        });
        byId('definitionCount').textContent = `${entries.length} words`;
        this.refreshSelected();
    }
    refreshSelected() {
        this.list.querySelectorAll('.definition-card').forEach(card => {
            card.classList.toggle('selected',card.dataset.word === this.app.selectedWord);
        });
        byId('scrollToSelected').disabled = !this.list.querySelector('.definition-card.selected');
    }
    appendDictionary(entry, primary = false) {
        const block = element('section','dict-block '+(primary?'primary':'secondary'));
        const heading = element('div','dict-heading');
        heading.append(element('span','',`${entry.source}${entry.level === null ? ' · Unclassified' : ' · Level ' + entry.level}`),
            element('span','meta-badge',primary ? 'ACTIVE DICTIONARY' : 'ALTERNATIVE'));
        block.append(heading);
        const detail = element('div','dict-detail');
        if (entry.pinyin) detail.append(element('strong','',entry.pinyin+'  ·  '));
        detail.append(document.createTextNode(entry.meaning));
        block.append(detail);
        return block;
    }
    renderInspector(entry, explicit = false) {
        clear(this.inspector);
        if (!entry) {
            this.inspector.append(element('div','inspector-placeholder','Click a word in the reading passage to see its definition and corpus examples.'));
            return;
        }
        const header = element('div','inspector-header');
        const wordWrap = element('div');
        wordWrap.append(element('div','inspector-word',entry.word),element('small','inspector-pinyin',entry.pinyin || 'Pinyin unavailable'));
        header.append(wordWrap,element('span','pin-pill',explicit ? 'PINNED WORD' : 'SELECTED WORD'));
        this.inspector.append(header,element('p','inspector-meaning',entry.meaning));
        this.inspector.append(this.appendDictionary(entry,true));
        const others = this.app.registry.otherEntries(entry.word,entry.id);
        if (this.app.settings.get('showOtherDictionary')) {
            if (others.length) others.forEach(other => this.inspector.append(this.appendDictionary(other,false)));
            else this.inspector.append(element('div','corpus-empty','No matching entry in the other loaded dictionary.'));
        }
        const actions = element('div','inspector-actions');
        const find = element('button','','↓ Find in vocabulary list');
        find.type = 'button';find.addEventListener('click',()=>this.scrollToSelected());
        const findText = element('button','','↗ Find in reading text');
        findText.type='button';findText.addEventListener('click',()=>this.app.scrollToReadingWord());
        actions.append(find,findText);
        this.inspector.append(actions);
        if (this.app.settings.get('showCorpus')) this.renderCorpus(entry,others);
    }
    renderCorpus(entry,others) {
        const section = element('section','corpus-section');
        const title = element('div','corpus-topline');
        title.append(element('span','','CONTEXT & EXAMPLES'),element('small','','From available corpus'));
        section.append(title);
        const references = [...entry.refs,...others.flatMap(x => x.refs)];
        const hits = this.app.corpus.find(entry.word,references);
        if (!hits.length) {
            section.append(element('p','corpus-empty','No corpus passage was found for this word in the loaded corpus files.'));
        } else {
            const groups = new Map();
            for (const hit of hits) {
                const key = String(hit.book ?? '?');
                if (!groups.has(key)) groups.set(key,[]);
                groups.get(key).push(hit);
            }
            for (const [book,records] of groups) {
                const group = element('div','corpus-group');
                group.append(element('div','corpus-group-title',`BOOK ${roman(book)} · ${records.length} references`));
                const cards = [];
                for (const [index,hit] of records.entries()) {
                    const card = element('div','example-card');
                    if (index >= 5) card.hidden = true;
                    card.append(element('div','ref-heading',hit.code));
                    if (hit.text) this.appendHighlightedText(card,
                        this.app.settings.get('corpusView') === 'full' ? hit.fullText : hit.text, entry.word);
                    else card.append(element('div','corpus-empty','Reference available; passage text not resolved in the corpus index.'));
                    group.append(card);cards.push(card);
                }
                if (records.length > 5) {
                    const button = element('button','example-expand','Show 5 more');
                    button.type = 'button';
                    let visible = 5;
                    button.addEventListener('click',()=>{
                        visible = visible === records.length ? 5 : Math.min(records.length,visible+5);
                        cards.forEach((c,i)=>{c.hidden=i>=visible;});
                        button.textContent = visible === records.length ? 'Show fewer' : 'Show 5 more';
                    });
                    group.append(button);
                }
                section.append(group);
            }
        }
        this.inspector.append(section);
    }
    appendHighlightedText(container,text,word) {
        const line = element('div','example-chinese');
        let cursor = 0, at;
        while ((at=text.indexOf(word,cursor)) !== -1) {
            if (at>cursor) line.append(document.createTextNode(text.slice(cursor,at)));
            line.append(element('mark','',word));
            cursor = at+word.length;
        }
        line.append(document.createTextNode(text.slice(cursor)));
        container.append(line);
    }
    scrollToSelected() {
        const card = [...this.list.querySelectorAll('.definition-card')]
            .find(node => node.dataset.word === this.app.selectedWord);
        if (card) card.scrollIntoView({behavior:'smooth',block:'center'});
    }
    applySearch(query) {
        this.list.querySelectorAll('.definition-card').forEach(card => {
            card.classList.toggle('search-match',Boolean(query && card.dataset.pinyin.includes(query)));
        });
    }
}

/* -------- Main controller: event handling and coordination -------- */
class HskApp {
    constructor() {
        this.settings = new SettingsStore();
        this.registry = new DictionaryRegistry();
        this.analyser = new TextAnalyser();
        this.corpus = new CorpusIndex(typeof hskCorpusTexts !== 'undefined' ? hskCorpusTexts : []);
        this.results = new Map();
        this.text = '';
        this.selectedWord = null;
        this.explicitlySelected = false;
        this.matchPositions = []; this.matchIndex = -1;
        this.reader = new ReaderView(this);
        this.vocab = new VocabularyView(this);
        this.loadDictionaries();
        this.buildThemeButtons();
        this.bindEvents();
        this.refreshControls();
        this.renderEverything();
        this.showReadiness();
    }
    buildThemeButtons() {
        const holder = byId('themeOptions');
        clear(holder);
        for (const theme of HSK_THEMES) {
            const button = element('button','segment',theme.label);
            button.type = 'button';
            button.dataset.themeChoice = theme.id;
            holder.append(button);
        }
    }
    loadDictionaries() {
        const data2012 = typeof hsk2012LxWordPlusDefnList !== 'undefined' ? hsk2012LxWordPlusDefnList : [];
        const data3 = typeof hsk3LxWordPlusDefnList !== 'undefined' ? hsk3LxWordPlusDefnList : [];
        this.registry.register('hsk2012','HSK 2012',data2012);
        this.registry.register('hsk3','HSK 3.0',data3);
    }
    /* FUTURE EXTENSION:
       app.registerDictionary('extra','Extended Dictionary',[yourNewEntries]);
       Existing analyses and UI will re-render. No matching engine changes. */
    registerDictionary(id,label,levelArrays) {
        // General dictionaries have no HSK level colours or L1/L2 labels.
        this.registry.register(id,label,levelArrays,{hasLevels:false});
        const button = element('button','segment',label);
        button.type='button';button.dataset.dictionary=id;
        button.addEventListener('click',()=>this.setDictionary(id));
        byId('dictionaryOptions').append(button);
        if (this.text) this.results.set(id,this.analyser.analyse(this.text,this.registry.get(id)));
        this.renderEverything();
    }
    get result() { return this.results.get(this.settings.get('activeDictionary')) || null; }
    showReadiness() {
        const counts = [...this.registry.sources.values()].map(d=>`${d.label}: ${d.entries.size}`).join(' · ');
        byId('analysisStatus').textContent = counts.includes(': 0')
            ? `Some dictionary files are missing or empty. ${counts}. Keep the original data files beside this HTML.`
            : `Dictionaries ready. ${counts} words indexed. ${this.corpus.records.length} corpus passages available.`;
    }
    analyseText() {
        this.text = this.analyser.cleanInput(byId('textInput').value);
        if (!this.text) { byId('analysisStatus').textContent='Please enter some Chinese text first.';return; }
        this.results.clear();
        for (const dictionary of this.registry.sources.values()) {
            this.results.set(dictionary.id,this.analyser.analyse(this.text,dictionary));
        }
        this.selectedWord = this.result?.tokens.find(t=>t.kind==='word')?.entry.word || null;
        this.explicitlySelected = false;
        byId('textInput').classList.add('hidden');
        byId('analyzeButton').classList.add('hidden');
        byId('newTextButton').classList.remove('hidden');
        byId('inputCount').parentElement.classList.add('hidden');
        byId('analysisStatus').textContent=`Passage analysed in ${this.registry.sources.size} independent dictionaries. You can switch instantly.`;
        this.renderEverything();
    }
    editText() {
        byId('textInput').classList.remove('hidden');
        byId('analyzeButton').classList.remove('hidden');
        byId('newTextButton').classList.add('hidden');
        byId('inputCount').parentElement.classList.remove('hidden');
        byId('textInput').focus();
    }
    setDictionary(id) {
        if (!this.registry.get(id)) return;
        this.settings.set('activeDictionary',id);
        // Keep selection if possible; otherwise select the first match in new pass.
        if (this.result && !this.result.distinct.has(this.selectedWord)) {
            this.selectedWord = this.result.tokens.find(t=>t.kind==='word')?.entry.word || null;
            this.explicitlySelected = false;
        }
        this.renderEverything();
    }
    selectWord(word, explicit = true) {
        const entry = this.result?.distinct.get(word)?.entry || this.registry.get(this.settings.get('activeDictionary'))?.find(word);
        if (!entry) {
            this.selectedWord = null;
            this.vocab.renderInspector(null);
            this.reader.refreshSelected();
            this.vocab.refreshSelected();
            return;
        }
        this.selectedWord = word;this.explicitlySelected = explicit;
        this.reader.refreshSelected();this.vocab.refreshSelected();
        this.vocab.renderInspector(entry,explicit);
        this.vocab.applySearch(normalizedPinyin(byId('pinyinSearchBox').value));
    }
    renderEverything() {
        const result = this.result;
        const active = this.registry.get(this.settings.get('activeDictionary'));
        this.refreshControls();
        this.reader.render(result);
        this.vocab.renderList(result);
        const entry = result?.distinct.get(this.selectedWord)?.entry || null;
        this.vocab.renderInspector(entry,this.explicitlySelected);
        byId('readingWordCount').textContent = `${result?.distinct.size || 0} distinct words matched`;
        byId('activeDictionaryLabel').textContent = `${active?.label || 'Dictionary'} active`;
        byId('vocabDictionaryLabel').textContent = active?.label || '';
        byId('listOrderLabel').textContent = this.settings.get('groupByLevel') ? 'Grouped by level' : 'In text order';
        byId('unfoundOutput').textContent = result?.unknown.size
            ? `${result.unknown.size} distinct Chinese characters not found in ${active.label}; an extra dictionary can be added later.` : '';
        this.renderCounts();
        this.performSearch();
    }
    renderCounts() {
        const holder=byId('statsOutput');clear(holder);
        for (const dict of this.registry.sources.values()) {
            const result=this.results.get(dict.id);
            const counts=result?.levelCounts || new Map();
            const total=[...counts.values()].reduce((a,b)=>a+b,0);
            const panel=element('div','stat-section');
            const head=element('div','stat-heading');
            head.append(element('span','',dict.label),element('span','',`${total} distinct`));panel.append(head);
            if (!dict.hasLevels) {
                panel.append(element('div','help-text',`${total} unclassified words`));
                holder.append(panel);
                continue;
            }
            for (let level=1;level<=(dict.id==='hsk3'?7:6);level++) {
                const number=counts.get(level)||0;
                const row=element('div','stat-row');
                row.append(element('span','','L'+(level===7 && dict.id==='hsk3'?'7–9':level)));
                const track=element('div','stat-track'),fill=element('div','stat-fill');
                fill.style.width=(total ? number/Math.max(...counts.values(),1)*100 : 0)+'%';
                track.append(fill);row.append(track,element('b','',number));panel.append(row);
            }
            holder.append(panel);
        }
    }
    renderLegend() {
        for (const [id,max] of [['legend3',7],['legend2012',6]]) {
            const box=byId(id);clear(box);
            for(let level=1;level<=max;level++) {
                const chip=element('span','level-chip',level===7?'L7–9':'L'+level);
                chip.dataset.level=level;box.append(chip);
            }
        }
    }
    refreshControls() {
        const state=this.settings.values;
        document.body.dataset.theme=state.theme;
        document.documentElement.style.setProperty('--reader-font-size',state.fontSize+'px');
        for (const mode of ['text','background','underline']) {
            document.body.setAttribute('data-mode-'+mode,String(state.highlight[mode]));
        }
        document.querySelectorAll('[data-theme-choice]').forEach(b=>this.markButton(b,b.dataset.themeChoice===state.theme));
        document.querySelectorAll('[data-dictionary]').forEach(b=>this.markButton(b,b.dataset.dictionary===state.activeDictionary));
        document.querySelectorAll('[data-highlight]').forEach(b=>this.markButton(b,Boolean(state.highlight[b.dataset.highlight])));
        document.querySelectorAll('[data-corpus-view]').forEach(b=>this.markButton(b,b.dataset.corpusView===state.corpusView));
        document.querySelectorAll('[data-setting]').forEach(b=>this.markButton(b,Boolean(state[b.dataset.setting])));
        if (!byId('legend3').children.length) this.renderLegend();
    }
    markButton(button,selected) {
        button.classList.toggle('selected',selected);
        if(button.classList.contains('setting-button')) button.classList.toggle('active',selected);
        button.setAttribute('aria-pressed',String(selected));
    }
    performSearch() {
        const query=normalizedPinyin(byId('pinyinSearchBox').value);
        const found=this.reader.applySearch(query);
        this.vocab.applySearch(query);
        this.matchPositions=[...byId('chineseOutput').querySelectorAll('.reading-word.search-match')];
        this.matchIndex=-1;
        byId('matchStatus').textContent=query?`${found} occurrences highlighted in the passage.`:'Search both the passage and vocabulary list.';
        byId('previousMatch').disabled=byId('nextMatch').disabled=!found;
    }
    navigateMatch(step) {
        if(!this.matchPositions.length)return;
        this.matchIndex=(this.matchIndex+step+this.matchPositions.length)%this.matchPositions.length;
        const node=this.matchPositions[this.matchIndex];
        node.scrollIntoView({behavior:'smooth',block:'center'});
        this.selectWord(node.dataset.word);
        byId('matchStatus').textContent=`Match ${this.matchIndex+1} of ${this.matchPositions.length}.`;
    }
    scrollToReadingWord() {
        const word = [...byId('chineseOutput').querySelectorAll('.reading-word')]
            .find(node=>node.dataset.word===this.selectedWord);
        if(word)word.scrollIntoView({behavior:'smooth',block:'center'});
    }
    showTooltip(target) {
        if(!this.settings.get('hoverHelp'))return;
        const entry=this.registry.get(this.settings.get('activeDictionary')).find(target.dataset.word);
        if(!entry)return;
        const tip=byId('wordTooltip');clear(tip);
        const heading=element('div');
        heading.append(element('span','hover-word',entry.word),element('span','hover-pinyin',entry.pinyin));
        tip.append(heading,element('div','hover-meaning',trimGloss(entry.meaning,110)),
            element('div','hover-caption','CLICK FOR BOTH DICTIONARIES & CORPUS'));
        tip.hidden=false;
        const rect=target.getBoundingClientRect(),r=tip.getBoundingClientRect();
        const left=Math.max(12,Math.min(innerWidth-r.width-12,rect.left+rect.width/2-r.width/2));
        const below=rect.top-r.height<12;
        const top=below?Math.min(innerHeight-r.height-12,rect.bottom+10):rect.top-r.height-9;
        tip.style.left=left+'px';tip.style.top=top+'px';
    }
    hideTooltip() {byId('wordTooltip').hidden=true;}
    bindEvents() {
        byId('analyzeButton').addEventListener('click',()=>this.analyseText());
        byId('newTextButton').addEventListener('click',()=>this.editText());
        byId('textInput').addEventListener('input',()=>byId('inputCount').textContent=String(byId('textInput').value.length));
        byId('pinyinSearchBox').addEventListener('input',()=>this.performSearch());
        byId('previousMatch').addEventListener('click',()=>this.navigateMatch(-1));
        byId('nextMatch').addEventListener('click',()=>this.navigateMatch(1));
        byId('scrollToSelected').addEventListener('click',()=>this.vocab.scrollToSelected());
        document.querySelectorAll('[data-theme-choice]').forEach(b=>b.addEventListener('click',()=>{
            this.settings.set('theme',b.dataset.themeChoice);this.refreshControls();
        }));
        document.querySelectorAll('[data-dictionary]').forEach(b=>b.addEventListener('click',()=>this.setDictionary(b.dataset.dictionary)));
        document.querySelectorAll('[data-highlight]').forEach(b=>b.addEventListener('click',()=>{
            const mode=b.dataset.highlight;
            this.settings.setHighlight(mode,!this.settings.get('highlight')[mode]);this.refreshControls();
        }));
        document.querySelectorAll('[data-corpus-view]').forEach(b=>b.addEventListener('click',()=>{
            this.settings.set('corpusView',b.dataset.corpusView);
            this.renderEverything();
        }));
        document.querySelectorAll('[data-setting]').forEach(b=>b.addEventListener('click',()=>{
            const key=b.dataset.setting;
            this.settings.set(key,!this.settings.get(key));
            if(['showCorpus','showOtherDictionary','groupByLevel','hideLowerLevels'].includes(key)) this.renderEverything();
            else {this.refreshControls();this.hideTooltip();}
        }));
        byId('fontSmaller').addEventListener('click',()=>{this.settings.set('fontSize',Math.max(17,this.settings.get('fontSize')-1));this.refreshControls();});
        byId('fontLarger').addEventListener('click',()=>{this.settings.set('fontSize',Math.min(36,this.settings.get('fontSize')+1));this.refreshControls();});
        byId('chineseOutput').addEventListener('click',event=>{
            const word=event.target.closest('[data-word]');if(word)this.selectWord(word.dataset.word);
        });
        byId('chineseOutput').addEventListener('keydown',event=>{
            const word=event.target.closest('[data-word]');
            if(word && (event.key==='Enter'||event.key===' ')){event.preventDefault();this.selectWord(word.dataset.word);}
        });
        byId('definitionsList').addEventListener('click',event=>{
            const card=event.target.closest('.definition-card');if(card)this.selectWord(card.dataset.word);
        });
        byId('chineseOutput').addEventListener('pointerover',event=>{
            const node=event.target.closest('.reading-word');if(node)this.showTooltip(node);
        });
        byId('chineseOutput').addEventListener('pointerout',event=>{
            if(event.target.closest('.reading-word'))this.hideTooltip();
        });
        for(const id of ['text-pane','vocab-pane','sidebar'])byId(id).addEventListener('scroll',()=>this.hideTooltip(),{passive:true});
        window.addEventListener('resize',()=>this.hideTooltip());
        this.bindResizer();
    }
    bindResizer() {
        const grip=byId('dragMe'),reader=byId('text-pane'),main=byId('main-content');
        let activeId=null;
        const release=()=>{if(activeId!==null){try{grip.releasePointerCapture(activeId);}catch(e){}activeId=null;grip.classList.remove('dragging');}};
        grip.addEventListener('pointerdown',event=>{
            if(window.matchMedia('(max-width:650px)').matches)return;
            activeId=event.pointerId;grip.setPointerCapture(activeId);grip.classList.add('dragging');event.preventDefault();
        });
        grip.addEventListener('pointermove',event=>{
            if(activeId!==event.pointerId)return;
            const r=main.getBoundingClientRect(),width=event.clientX-r.left;
            if(width>=250 && width<=r.width-270){reader.style.flex=`0 0 ${width}px`;reader.style.width=width+'px';}
        });
        grip.addEventListener('pointerup',release);grip.addEventListener('pointercancel',release);
        grip.addEventListener('keydown',event=>{
            if(event.key!=='ArrowLeft'&&event.key!=='ArrowRight')return;
            event.preventDefault();const width=reader.getBoundingClientRect().width+(event.key==='ArrowRight'?25:-25);
            if(width>=250&&width<=main.clientWidth-270){reader.style.flex=`0 0 ${width}px`;reader.style.width=width+'px';}
        });
    }
}

window.addEventListener('DOMContentLoaded',()=>{
    window.HSK_JADE_APP=new HskApp();
});
