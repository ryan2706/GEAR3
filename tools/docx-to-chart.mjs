#!/usr/bin/env node
// tools/docx-to-chart.mjs
//
// Converts bilingual service-pack .docx files (one H3 heading per song:
// "ENGLISH TITLE 中文標題", credit/copyright lines, "CCLI Song #:", a
// "Key: / Time: / BPM =" line, an optional Song Order table, then the chart
// body as repeating (bold chord line, English lyric line, Chinese lyric
// line) groups) into v2 chart files per BILINGUAL-SPEC.md.
//
// ── How to run ──
//
//   npm install
//   node tools/docx-to-chart.mjs <file.docx> [<file.docx> ...] [options]
//
// Options:
//   --force               Overwrite chart files that already exist under
//                          --charts-dir. Without it, an existing chart file
//                          is left untouched and skipped (idempotent).
//   --charts-dir <dir>    Where chart files are written. Default: the
//                          repo's real charts/ directory, per
//                          BILINGUAL-SPEC.md §3's charts/<LETTER>/<slug>.html
//                          layout.
//   --out-dir <dir>       Where the songs.json patch fragment and Song
//                          Order sidecars land. Default: tools/out/. These
//                          are staging artifacts (never auto-merged into
//                          data/songs.json) and are freely overwritten each
//                          run — only chart files get the idempotent guard.
//
// One docx can (and usually does) contain multiple songs; each gets its own
// chart file, its own Song Order sidecar (if it had a Song Order table),
// and one entry in the shared songs.json patch fragment for the run.
//
// The songs.json patch is never applied automatically — review
// tools/out/songs-patch.json and merge the entries you want by hand.
//
// ── Why raw OOXML instead of mammoth ──
//
// mammoth converts prose documents to semantic HTML (style-mapped headings,
// bold → <strong>) — it's the obvious library, but wrong here: chord-to-
// syllable binding depends entirely on exact whitespace and run-level bold
// fidelity, and mammoth doesn't contract to preserve that (docx→HTML
// converters in its class are known to normalize runs of spaces — exactly
// what the column math below depends on). It also has no clean way to read
// a table's cells as structured data rather than HTML. A .docx is a zip
// containing well-specified OOXML, so this reads word/document.xml
// directly via two small devDependencies (jszip for the zip container,
// @xmldom/xmldom for the XML — a real DOM, not regex, since OOXML nests and
// regex over nested tags is fragile).
//
// ── Known failure modes ──
//
// - Column math assumes chord/lyric paragraphs use a true monospace font
//   (this tool doesn't check the font; if a document uses a proportional
//   font, every binding will be wrong and none of it will be flagged,
//   because the algorithm has no way to know).
// - Hand-typed padding drifts from perfect alignment in real archives —
//   confirmed against a real 5-year-old file during design. A binding is
//   only marked confident when it lands exactly on a natural anchor (a
//   word boundary for English, a character's own visual column for
//   Chinese); anything else is flagged in the report, but still emitted as
//   a best-effort guess — always hand-check flagged lines against the
//   original docx.
// - Tab characters inside a *chord* line (not observed in testing, but
//   handled defensively) are expanded to the next multiple of
//   TAB_WIDTH columns; this is an unverified guess, not a measured value.
// - Script detection (zh-Hant vs zh-Hans) uses a hand-curated dictionary of
//   common worship-vocabulary simplified/traditional pairs — not a full
//   OpenCC-equivalent converter. A song whose Chinese text contains none of
//   the dictionary's distinguishing characters falls back to zh-Hant and is
//   flagged in the report as low-confidence, since that's a genuinely
//   undecidable case for this tool, not something to silently guess past.
// - Title splitting assumes the H3 heading is exactly
//   "ENGLISH TITLE<space>中文標題" with no other separators; a title with a
//   slash, parenthetical, or interleaved scripts may split incorrectly.
// - A chord line's bold-ness is read at the paragraph level (is the first
//   non-empty run bold), not per-character-run — a chord line that's only
//   *partially* bold in the source won't be detected as a chord line.
// - Chord-only lines are emitted as space-joined tokens; literal "|"
//   bar-line characters in the source pass through as-is, but this tool
//   never invents bar lines that aren't already in the text.
// - The Song Order sidecar's shape deviates from BILINGUAL-SPEC.md §6.3's
//   own flat `{section: mode}` illustration: real Song Order tables repeat
//   a section name with a *different* language on a later occurrence (e.g.
//   "Verse" sung in English, then again in Chinese later in the same
//   service) — a flat map would silently lose the earlier occurrence. This
//   tool's sidecar keys by section but stores an ordered array of
//   occurrences per section instead of a single value.

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { SECTION_HEADERS } from '../js/chart-constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TAB_WIDTH = 4; // unverified guess — see "Known failure modes" above

// ───────────────────────── CLI ─────────────────────────

function parseArgs(argv) {
    const args = {
        files: [],
        force: false,
        chartsDir: path.join(REPO_ROOT, 'charts'),
        outDir: path.join(REPO_ROOT, 'tools', 'out')
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--force') args.force = true;
        else if (a === '--charts-dir') args.chartsDir = path.resolve(argv[++i]);
        else if (a === '--out-dir') args.outDir = path.resolve(argv[++i]);
        else args.files.push(a);
    }
    return args;
}

// ───────────────────────── OOXML extraction ─────────────────────────

async function loadDocumentXml(docxPath) {
    const buf = await readFile(docxPath);
    const zip = await JSZip.loadAsync(buf);
    const entry = zip.file('word/document.xml');
    if (!entry) throw new Error(`${docxPath}: not a valid .docx (no word/document.xml found in the zip)`);
    return entry.async('string');
}

function elementChildren(node, tagName) {
    const out = [];
    for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 1 && (!tagName || child.nodeName === tagName)) out.push(child);
    }
    return out;
}

function textOfRun(runEl) {
    let out = '';
    for (const child of Array.from(runEl.childNodes)) {
        if (child.nodeType !== 1) continue;
        if (child.nodeName === 'w:t') out += child.textContent;
        else if (child.nodeName === 'w:tab') out += '\t';
        else if (child.nodeName === 'w:br') out += '\n';
    }
    return out;
}

function runFlag(runEl, tag) {
    const rPr = elementChildren(runEl, 'w:rPr')[0];
    if (!rPr) return false;
    const el = elementChildren(rPr, tag)[0];
    if (!el) return false;
    const val = el.getAttribute('w:val');
    return val === null || val === '' || val === '1' || val.toLowerCase() === 'true';
}

const isRunBold = (r) => runFlag(r, 'w:b');
const isRunItalic = (r) => runFlag(r, 'w:i');

function paragraphRuns(pEl) {
    return Array.from(pEl.getElementsByTagName('w:r'));
}

function paragraphText(pEl) {
    return paragraphRuns(pEl).map(textOfRun).join('');
}

function paragraphIsBold(pEl) {
    const withText = paragraphRuns(pEl).filter(r => textOfRun(r).trim().length > 0);
    if (withText.length === 0) return false;
    return isRunBold(withText[0]);
}

function paragraphStyle(pEl) {
    const pPr = elementChildren(pEl, 'w:pPr')[0];
    if (!pPr) return null;
    const pStyle = elementChildren(pPr, 'w:pStyle')[0];
    return pStyle ? pStyle.getAttribute('w:val') : null;
}

// Direct-child paragraphs/tables of <w:body>, in document order.
function getBodyBlocks(xml) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const body = doc.getElementsByTagName('w:body')[0];
    const blocks = [];
    for (const child of Array.from(body.childNodes)) {
        if (child.nodeType !== 1) continue;
        if (child.nodeName === 'w:p') {
            blocks.push({
                type: 'p',
                el: child,
                text: paragraphText(child),
                bold: paragraphIsBold(child),
                style: paragraphStyle(child)
            });
        } else if (child.nodeName === 'w:tbl') {
            blocks.push({ type: 'tbl', el: child });
        }
        // w:sectPr and anything else at body level is page setup — ignored.
    }
    return blocks;
}

// ───────────────────────── Song Order table ─────────────────────────

function cellRuns(tcEl) {
    return Array.from(tcEl.getElementsByTagName('w:r'))
        .map(r => ({ text: textOfRun(r), bold: isRunBold(r), italic: isRunItalic(r) }))
        .filter(r => r.text.length > 0);
}

// A cell like bold("Chorus") + italic(" *Drums in") splits into a section
// name (the bold run(s)) and an optional note (the rest, cosmetic leading
// "*" stripped).
function splitSectionAndNote(tcEl) {
    const runs = cellRuns(tcEl);
    const section = runs.filter(r => r.bold).map(r => r.text).join('').trim();
    let note = runs.filter(r => !r.bold).map(r => r.text).join('').trim().replace(/^\*+\s*/, '');
    return { section, note: note || undefined };
}

function cellText(tcEl) {
    return cellRuns(tcEl).map(r => r.text).join('').trim();
}

function mapLanguageWord(word, ctx) {
    const w = word.toLowerCase();
    if (w.includes('english') && w.includes('chinese')) return 'en-zh';
    if (w.startsWith('en')) return 'en';
    if (w.startsWith('ch') || w.includes('chinese')) return 'zh';
    ctx.flag({ reason: 'unrecognized-song-order-language', detail: word });
    return null;
}

// Returns { Verse: ["en", {mode:"en", note:"Drums in"}, "zh", ...], ... } —
// keyed by section (per the task), but each value is an ordered array of
// occurrences, not a single value. See "Known failure modes" above for why:
// a real Song Order table can list the same section twice with a different
// language, which a flat {section: mode} map would silently lose.
function parseSongOrderTable(tblEl, ctx) {
    const rows = Array.from(tblEl.getElementsByTagName('w:tr'));
    const order = {};
    for (const row of rows) {
        const cells = Array.from(row.getElementsByTagName('w:tc'));
        if (cells.length < 2) continue; // the "Song Order:" header row spans both columns
        const { section, note } = splitSectionAndNote(cells[0]);
        if (!section) continue;
        const mode = mapLanguageWord(cellText(cells[1]), ctx);
        if (!mode) continue;
        const entry = note ? { mode, note } : mode;
        (order[section] ||= []).push(entry);
    }
    return Object.keys(order).length > 0 ? order : null;
}

// ───────────────────────── Front matter ─────────────────────────

const CJK_RE = /[㐀-鿿豈-﫿]/;

const TITLE_CASE_LOWER = new Set([
    'a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet',
    'at', 'by', 'in', 'of', 'on', 'to', 'up', 'as', 'is'
]);

function titleCase(str) {
    const words = str.toLowerCase().split(/\s+/).filter(Boolean);
    return words
        .map((w, i) => (i !== 0 && i !== words.length - 1 && TITLE_CASE_LOWER.has(w))
            ? w
            : w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

function splitTitle(rawTitle) {
    const m = rawTitle.match(CJK_RE);
    if (!m) return { titleEn: titleCase(rawTitle.trim()), titleZh: undefined };
    return {
        titleEn: titleCase(rawTitle.slice(0, m.index).trim()),
        titleZh: rawTitle.slice(m.index).trim()
    };
}

function parseCcliLine(text) {
    const m = text.match(/CCLI Song #:\s*(\S+)/i);
    return m ? m[1] : undefined;
}

function parseKeyTimeBpmLine(text) {
    const fields = text.split('\t').map(f => f.trim()).filter(Boolean);
    const out = {};
    for (const f of fields) {
        let m;
        if ((m = f.match(/^Key:\s*(.+)$/i))) out.key = m[1].trim();
        else if ((m = f.match(/^Time:\s*(.+)$/i))) out.timeSignature = `${m[1].trim()} time`;
        else if ((m = f.match(/^BPM\s*=\s*(.+)$/i))) {
            const val = m[1].trim();
            if (val && val !== '-' && val !== '?') out.bpm = val;
        }
    }
    return out;
}

// ───────────────────────── Chart-body chord grammar ─────────────────────────
// Same grammar as js/chart-parser.js / js/chart-render.js / js/app.js —
// duplicated rather than imported, matching how this regex already exists
// independently in three places in the site's own code.

const CHORD_TOKEN_SCAN = /\b([A-G](?:#|b)?)((?:m|maj|min|dim|aug|sus|add|M|2|4|5|6|7|9|11|13)*)(\/[A-G](?:#|b)?)?(?=\s|$)/g;
const CHORD_PRESENCE = /\b[A-G](?:#|b)?(?:m|maj|min|dim|aug|sus|add|7|9|11|13)*(?:\/[A-G](?:#|b)?)?\b/;

function extractChordTokens(rawLine) {
    const expanded = expandTabs(rawLine);
    const tokens = [];
    CHORD_TOKEN_SCAN.lastIndex = 0;
    let m;
    while ((m = CHORD_TOKEN_SCAN.exec(expanded)) !== null) {
        tokens.push({ col: m.index, rawToken: m[0] });
    }
    return tokens;
}

function expandTabs(text) {
    if (!text.includes('\t')) return text;
    let out = '';
    let col = 0;
    for (const ch of text) {
        if (ch === '\t') {
            const next = Math.ceil((col + 1) / TAB_WIDTH) * TAB_WIDTH;
            out += ' '.repeat(next - col);
            col = next;
        } else {
            out += ch;
            col += 1;
        }
    }
    return out;
}

const SECTION_HEADER_LINE = new RegExp(`^\\[((?:${SECTION_HEADERS.join('|')}).*?)\\]$`, 'i');
const isCjk = (text) => CJK_RE.test(text);

function classifyBodyParagraph(p) {
    const trimmed = p.text.trim();
    if (!trimmed) return { kind: 'blank' };
    if (SECTION_HEADER_LINE.test(trimmed)) return { kind: 'header', name: trimmed.match(SECTION_HEADER_LINE)[1] };
    if (!SECTION_HEADER_LINE.test(trimmed) && /^\[.+\]$/.test(trimmed)) return { kind: 'header-unrecognized', name: trimmed };
    if (p.bold) return { kind: 'chord', raw: expandTabs(p.text) };
    if (isCjk(trimmed)) return { kind: 'zh', raw: expandTabs(p.text) };
    return { kind: 'en', raw: expandTabs(p.text) };
}

// ───────────────────────── East-Asian width & Chinese binding ─────────────────────────

function eastAsianWidth(ch) {
    const cp = ch.codePointAt(0);
    if (
        (cp >= 0x1100 && cp <= 0x115F) ||
        (cp >= 0x2E80 && cp <= 0xA4CF) ||
        (cp >= 0xAC00 && cp <= 0xD7A3) ||
        (cp >= 0xF900 && cp <= 0xFAFF) ||
        (cp >= 0xFF00 && cp <= 0xFF60) ||
        (cp >= 0xFFE0 && cp <= 0xFFE6)
    ) return 2;
    return 1;
}

function visualCharMap(rawLine) {
    const chars = [];
    let col = 0;
    for (const ch of rawLine) {
        if (!/\s/.test(ch)) chars.push({ ch, col });
        col += /\s/.test(ch) ? 1 : eastAsianWidth(ch);
    }
    return chars;
}

// ───────────────────────── Binding ─────────────────────────

function bindEnglish(tokens, rawLyric, ctx) {
    const lyric = rawLyric.replace(/\s+$/, '');
    if (tokens.length === 0) return lyric;

    const wordStarts = new Set([0]);
    for (const m of lyric.matchAll(/\s+/g)) wordStarts.add(m.index + m[0].length);

    const inserts = new Map();
    let cursor = 0;
    for (const tok of tokens) {
        let col = tok.col;
        if (col > lyric.length) {
            ctx.flag({ chord: tok.rawToken, lyric, reason: 'trailing-beyond-line' });
            col = lyric.length;
        } else if (!wordStarts.has(col)) {
            const anchor = col < lyric.length ? `before ${JSON.stringify(lyric[col])}` : 'at end of line';
            ctx.flag({ chord: tok.rawToken, lyric, reason: 'mid-word', detail: `bound ${anchor}, column ${col}` });
        }
        if (col < cursor) {
            ctx.flag({ chord: tok.rawToken, lyric, reason: 'collision', detail: `column ${col} is before the previous chord's column ${cursor}` });
            col = cursor;
        }
        (inserts.get(col) || inserts.set(col, []).get(col)).push(tok.rawToken);
        cursor = col;
    }

    let out = '';
    let last = 0;
    for (const col of [...inserts.keys()].sort((a, b) => a - b)) {
        out += lyric.slice(last, col);
        out += inserts.get(col).map(c => `[${c}]`).join('');
        last = col;
    }
    out += lyric.slice(last);
    return out;
}

function bindChinese(tokens, rawLyric, ctx) {
    const chars = visualCharMap(rawLyric);
    if (tokens.length === 0 || chars.length === 0) return chars.map(c => c.ch).join('');

    const inserts = new Map();
    let lastIdx = -1;
    for (const tok of tokens) {
        let best = 0, bestDist = Infinity;
        for (let i = 0; i < chars.length; i++) {
            const d = Math.abs(chars[i].col - tok.col);
            if (d < bestDist) { bestDist = d; best = i; }
        }
        if (bestDist !== 0) {
            ctx.flag({ chord: tok.rawToken, lyric: rawLyric.trim(), reason: `chi-drift-${bestDist}`, detail: `nearest character was ${JSON.stringify(chars[best].ch)}, ${bestDist} visual column(s) off` });
        }
        if (best < lastIdx) {
            ctx.flag({ chord: tok.rawToken, lyric: rawLyric.trim(), reason: 'collision', detail: `resolved position is before the previous chord's` });
            best = lastIdx;
        }
        (inserts.get(best) || inserts.set(best, []).get(best)).push(tok.rawToken);
        lastIdx = best;
    }

    let out = '';
    for (let i = 0; i < chars.length; i++) {
        if (inserts.has(i)) out += inserts.get(i).map(c => `[${c}]`).join('');
        out += chars[i].ch;
    }
    return out;
}

// ───────────────────────── Chart-body assembly ─────────────────────────

function buildChartBody(bodyParagraphs, ctx) {
    const outputLines = [];
    let pendingChord = null;
    let pendingChordUsed = false;

    const pushBlankIfNeeded = () => {
        if (outputLines.length && outputLines[outputLines.length - 1] !== '') outputLines.push('');
    };
    const flushPendingChord = () => {
        if (pendingChord && !pendingChordUsed) {
            outputLines.push(pendingChord.tokens.map(t => t.rawToken).join(' '));
        }
        pendingChord = null;
        pendingChordUsed = false;
    };

    for (const raw of bodyParagraphs) {
        const block = classifyBodyParagraph(raw);
        switch (block.kind) {
            case 'header':
                flushPendingChord();
                pushBlankIfNeeded();
                outputLines.push(`[${block.name}]`);
                break;
            case 'header-unrecognized':
                flushPendingChord();
                ctx.flag({ reason: 'unrecognized-section-header', detail: block.name });
                pushBlankIfNeeded();
                outputLines.push(block.name);
                break;
            case 'blank':
                flushPendingChord();
                pushBlankIfNeeded();
                break;
            case 'chord':
                flushPendingChord();
                pendingChord = { tokens: extractChordTokens(block.raw), raw: block.raw };
                pendingChordUsed = false;
                break;
            case 'en':
            case 'zh': {
                const tokens = pendingChord ? pendingChord.tokens : [];
                const bound = block.kind === 'en' ? bindEnglish(tokens, block.raw, ctx) : bindChinese(tokens, block.raw, ctx);
                outputLines.push(`${block.kind}: ${bound}`);
                if (pendingChord) pendingChordUsed = true;
                break;
            }
        }
    }
    flushPendingChord();

    while (outputLines.length && outputLines[0] === '') outputLines.shift();
    while (outputLines.length && outputLines[outputLines.length - 1] === '') outputLines.pop();
    return outputLines.join('\n');
}

// ───────────────────────── Script detection ─────────────────────────
// Hand-curated, validated against characters actually present in the
// reference file — see "Known failure modes" in the header comment.

const SIMPLIFIED_TRADITIONAL_PAIRS = [
    ['为', '為'], ['万', '萬'], ['们', '們'], ['变', '變'], ['听', '聽'],
    ['圣', '聖'], ['权', '權'], ['洁', '潔'], ['赎', '贖'], ['远', '遠'],
    ['爱', '愛'], ['灵', '靈'], ['愿', '願'], ['显', '顯'], ['头', '頭'],
    ['领', '領'], ['飞', '飛'], ['马', '馬'], ['腾', '騰'], ['鹰', '鷹'],
    ['帮', '幫'], ['随', '隨'], ['时', '時'], ['门', '門'], ['开', '開'],
    ['关', '關'], ['乐', '樂'], ['个', '個'], ['见', '見'], ['现', '現'],
    ['实', '實'], ['还', '還'], ['将', '將'], ['说', '說'], ['话', '話'],
    ['认', '認'], ['识', '識'], ['护', '護'], ['宝', '寶'], ['问', '問'],
    ['对', '對'], ['发', '發'], ['长', '長'], ['亲', '親'], ['声', '聲'],
    ['岁', '歲'], ['儿', '兒'], ['苏', '穌'], ['诚', '誠'], ['丰', '豐'],
    ['风', '風'], ['颂', '頌'], ['赞', '讚'], ['荣', '榮'], ['体', '體'],
    ['兴', '興'], ['宁', '寧'], ['尽', '盡'], ['满', '滿'], ['怀', '懷'],
    ['宽', '寬'], ['写', '寫'], ['宠', '寵'], ['从', '從'], ['让', '讓'],
    ['围', '圍'], ['亚', '亞'], ['释', '釋'], ['赛', '賽'], ['启', '啟']
];
const SIMPLIFIED_ONLY = new Set(SIMPLIFIED_TRADITIONAL_PAIRS.map(([s]) => s));
const TRADITIONAL_ONLY = new Set(SIMPLIFIED_TRADITIONAL_PAIRS.map(([, t]) => t));

function detectScript(text) {
    let simp = 0, trad = 0;
    for (const ch of text) {
        if (SIMPLIFIED_ONLY.has(ch)) simp++;
        else if (TRADITIONAL_ONLY.has(ch)) trad++;
    }
    if (simp === 0 && trad === 0) return { script: 'zh-Hant', confident: false };
    return { script: simp >= trad ? 'zh-Hans' : 'zh-Hant', confident: true };
}

// ───────────────────────── Slug / filename ─────────────────────────

function slugify(title) {
    return title
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

// ───────────────────────── Front matter / body split ─────────────────────────

function splitFrontMatterAndBody(blocks) {
    let bodyStart = blocks.length;
    for (let i = 1; i < blocks.length; i++) {
        const b = blocks[i];
        if (b.type !== 'p') continue;
        const text = b.text.trim();
        if (!text) continue;
        if (SECTION_HEADER_LINE.test(text) || (b.bold && CHORD_PRESENCE.test(text))) {
            bodyStart = i;
            break;
        }
    }
    return { frontMatter: blocks.slice(1, bodyStart), body: blocks.slice(bodyStart) };
}

// ───────────────────────── Per-song processing ─────────────────────────

function processSong(songBlocks, ctx) {
    const { titleEn, titleZh } = splitTitle(songBlocks[0].text);
    ctx.song = titleEn;

    const { frontMatter, body } = splitFrontMatterAndBody(songBlocks);

    let ccli, key, timeSignature, bpm, songOrder = null;
    for (const b of frontMatter) {
        if (b.type === 'p') {
            const t = b.text.trim();
            if (!ccli) {
                const c = parseCcliLine(t);
                if (c) ccli = c;
            }
            if (!key && /Key:/i.test(t)) {
                const kt = parseKeyTimeBpmLine(b.text);
                key = kt.key;
                timeSignature = kt.timeSignature;
                bpm = kt.bpm;
            }
        } else if (b.type === 'tbl') {
            songOrder = parseSongOrderTable(b.el, ctx);
        }
    }

    const bodyParagraphs = body.filter(b => b.type === 'p');
    const bodyText = buildChartBody(bodyParagraphs, ctx);

    const allZhText = bodyParagraphs
        .map(p => p.text)
        .filter(isCjk)
        .join('');
    const { script, confident } = detectScript(allZhText || titleZh || '');
    if (!confident) {
        ctx.flag({ reason: 'script-detection-fallback', detail: `no distinguishing simplified/traditional characters found; defaulted to ${script}` });
    }

    const langs = ['en', script];
    const slug = slugify(titleEn);
    const letter = (titleEn[0] || 'Z').toUpperCase();

    const chartHtml =
        `<pre class="chord-chart"\n` +
        `     data-format="bilingual"\n` +
        `     data-key="${key || ''}"\n` +
        `     data-langs="${langs.join(',')}"\n` +
        `     data-primary="en">\n` +
        `${bodyText}\n` +
        `</pre>\n`;

    const songEntry = {
        title: titleEn,
        ...(titleZh ? { titleZh } : {}),
        url: `charts/${letter}/${slug}.html`,
        format: 'bilingual',
        langs,
        ...(ccli ? { ccli } : {}),
        ...(bpm ? { bpm } : {}),
        ...(timeSignature ? { timeSignature } : {})
    };

    return { titleEn, letter, slug, chartHtml, songEntry, songOrder };
}

// ───────────────────────── File output ─────────────────────────

async function fileExists(p) {
    try { await access(p); return true; } catch { return false; }
}

async function writeChartFile(chartsDir, letter, slug, html, force, log) {
    const dir = path.join(chartsDir, letter);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${slug}.html`);
    const exists = await fileExists(filePath);
    if (exists && !force) {
        log(`SKIP       ${path.relative(REPO_ROOT, filePath)} (already exists — pass --force to overwrite)`);
        return false;
    }
    await writeFile(filePath, html, 'utf8');
    log(`${exists ? 'OVERWRITE ' : 'WRITE     '} ${path.relative(REPO_ROOT, filePath)}`);
    return true;
}

// ───────────────────────── Main ─────────────────────────

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.files.length === 0) {
        console.error('Usage: node tools/docx-to-chart.mjs <file.docx> [<file.docx> ...] [--force] [--charts-dir <dir>] [--out-dir <dir>]');
        process.exitCode = 1;
        return;
    }

    const log = (msg) => console.log(msg);
    const allEntries = [];
    const allSongOrders = [];
    const ambiguities = [];
    let songCount = 0, writtenCount = 0, skippedCount = 0;

    for (const docxPath of args.files) {
        log(`\n=== ${docxPath} ===`);
        const xml = await loadDocumentXml(docxPath);
        const blocks = getBodyBlocks(xml);

        const songStarts = blocks
            .map((b, i) => (b.type === 'p' && b.style === 'Heading3') ? i : -1)
            .filter(i => i !== -1);

        if (songStarts.length === 0) {
            log('  no Heading3 song titles found — skipping this file');
            continue;
        }

        for (let s = 0; s < songStarts.length; s++) {
            const start = songStarts[s];
            const end = s + 1 < songStarts.length ? songStarts[s + 1] : blocks.length;
            const songBlocks = blocks.slice(start, end);

            const ctx = { song: null, flag(entry) { ambiguities.push({ song: ctx.song, ...entry }); } };
            const result = processSong(songBlocks, ctx);
            songCount++;

            const written = await writeChartFile(args.chartsDir, result.letter, result.slug, result.chartHtml, args.force, log);
            written ? writtenCount++ : skippedCount++;

            allEntries.push(result.songEntry);
            if (result.songOrder) {
                allSongOrders.push({ title: result.titleEn, slug: result.slug, songOrder: result.songOrder });
            }
        }
    }

    await mkdir(args.outDir, { recursive: true });
    await mkdir(path.join(args.outDir, 'song-order'), { recursive: true });

    for (const { slug, songOrder } of allSongOrders) {
        await writeFile(
            path.join(args.outDir, 'song-order', `${slug}.json`),
            JSON.stringify(songOrder, null, 2) + '\n',
            'utf8'
        );
    }

    const patchPath = path.join(args.outDir, 'songs-patch.json');
    await writeFile(patchPath, JSON.stringify(allEntries, null, 2) + '\n', 'utf8');

    log(`\n--- Ambiguity report (${ambiguities.length} item(s)) ---`);
    if (ambiguities.length === 0) {
        log('(none — every binding landed on a confident anchor)');
    } else {
        for (const a of ambiguities) {
            const parts = [`[${a.song}]`, a.reason];
            if (a.chord) parts.push(`chord=${a.chord}`);
            if (a.lyric) parts.push(`lyric=${JSON.stringify(a.lyric)}`);
            if (a.detail) parts.push(a.detail);
            log('  ' + parts.join('  '));
        }
    }

    log(`\n--- Summary ---`);
    log(`songs processed: ${songCount}`);
    log(`chart files written: ${writtenCount}`);
    log(`chart files skipped (already existed, use --force): ${skippedCount}`);
    log(`songs.json patch fragment: ${path.relative(REPO_ROOT, patchPath)} (${allEntries.length} entries — review and merge by hand)`);
    log(`Song Order sidecars: ${allSongOrders.length} written under ${path.relative(REPO_ROOT, path.join(args.outDir, 'song-order'))}/`);
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
