#!/usr/bin/env node
// tools/build-index.mjs
//
// Two generated-content jobs, both driven by titleZh / zh-* content that
// already exists in the source:
//
//  1. Rewrites data/songs.json with three generated fields for every record
//     that has titleZh: titleZhAlt (opposite script), pinyin, and
//     pinyinInitials. Per BILINGUAL-SPEC.md §7/§9.
//  2. Writes a py: line beneath every zh-* lyric line in every v2
//     (data-format="bilingual") chart under charts/ — the generated-pinyin
//     reading-aid layer BILINGUAL-SPEC.md §5.6 defines, so team members who
//     read pinyin but not Han characters can follow along.
//
// ── How to run ──
//
//   npm install
//   node tools/build-index.mjs
//
// No flags. Always reads and rewrites data/songs.json in full, and rewrites
// (in place) any chart file whose py: lines are missing or out of date.
//
// ── DO NOT HAND-EDIT titleZhAlt, pinyin, pinyinInitials, or any py: line ──
//
// All of these are always recomputed and overwritten on every run — that's
// what makes this idempotent (same input -> same output) and it's also the
// enforcement mechanism for the rule: a hand-edit to any of them is
// silently clobbered the next time this script runs. If a generated value
// looks wrong:
//   - Wrong titleZhAlt/pinyin/pinyinInitials -> fix titleZh, re-run.
//   - Wrong py: reading -> add/fix an entry in tools/pinyin-exceptions.json
//     (character or whole phrase -> correct reading), re-run. Don't patch
//     the chart file by hand — see BILINGUAL-SPEC.md §5.6's own framing of
//     this ("fix it in the build script's exception map, not the chart").
// See also the data/songs.json section of CLAUDE.md.
//
// tools/pinyin-exceptions.json is loaded once at startup via pinyin-pro's
// own customPinyin() (character *and* phrase-level overrides, in one flat
// map — pinyin-pro does the longest-match itself) and applies globally, so
// it also corrects any songs.json titleZh pinyin that happens to contain
// one of the same characters — one exception map, both generators.
// Starter entries: 祢 (the reverential "You" used for God in worship
// lyrics) defaults to the surname reading "mí" in pinyin-pro's own
// dictionary — a real, confirmed miss, not a hypothetical; 的/了/得 default
// to their least-common-in-lyrics polyphonic readings ("dí/liǎo/dé")
// rather than the overwhelmingly common sung-Mandarin ones. These are
// starter corrections, not an exhaustive table — grow the file as real
// readings turn up wrong.
//
// Known limitation: py: generation assumes the zh-* line's text (after
// stripping [chord] brackets) has no literal whitespace — pinyin-pro emits
// exactly one space-separated token per input character *including*
// punctuation, which is what lets the renderer zip pinyin syllables
// 1:1 against Han characters for ruby annotation, but a literal space
// inside the lyric text would collapse against the token separators and
// break that count. Not a real concern for this corpus (Chinese lyric text
// doesn't use inter-word spacing) but worth knowing if it ever changes.
//
// Records without titleZh, and chart files that aren't data-format
// "bilingual", are left completely untouched.
//
// ── Script detection: opencc-js's own tables, not a hand list ──
//
// titleZh is converted through opencc-js in both directions (cn->tw and
// tw->cn). Whichever direction actually changes the string tells you which
// script titleZh is already in; the other direction's output becomes
// titleZhAlt. If neither direction changes it (every character is shared
// between scripts), titleZhAlt is set equal to titleZh and it's noted on
// stdout — an honest fallback, and harmless for search: an identical
// "alternate" still matches trivially.
//
// This only classifies titleZh itself, independent of the langs field
// (which tools/docx-to-chart.mjs sets from the chart *body*'s dominant
// script — a different, wider piece of text). The two can legitimately
// disagree on a song where the title was typed in one script out of habit
// but the body was transcribed in the other; this script doesn't try to
// reconcile that, since it only ever touches title-derived fields.
//
// ── Whole-file rewrite ──
//
// This does a full parse + JSON.stringify(data, null, 2), not a surgical
// per-record patch, so it also normalizes this file's inconsistent legacy
// spacing (some records use "ccli": "x", others "ccli":"x" — years of
// hand-editing). That's a deliberate one-time cost the first time this runs;
// every run after stays clean since the file is already normalized.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenCC from 'opencc-js';
import { pinyin, customPinyin } from 'pinyin-pro';
import { extractPre } from './lib/chart-file.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SONGS_PATH = path.join(REPO_ROOT, 'data', 'songs.json');
const CHARTS_DIR = path.join(REPO_ROOT, 'charts');
const EXCEPTIONS_PATH = path.join(__dirname, 'pinyin-exceptions.json');

const toTraditional = OpenCC.Converter({ from: 'cn', to: 'tw' });
const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' });

function generateAltTitle(titleZh, log) {
    const asTraditional = toTraditional(titleZh);
    const asSimplified = toSimplified(titleZh);

    if (asTraditional !== titleZh) return asTraditional; // titleZh was Simplified
    if (asSimplified !== titleZh) return asSimplified;    // titleZh was Traditional

    log(`  note: "${titleZh}" has no characters that distinguish Simplified from Traditional — titleZhAlt set equal to titleZh`);
    return titleZh;
}

function generatePinyinFields(titleZh) {
    return {
        pinyin: pinyin(titleZh, { toneType: 'none' }),
        pinyinInitials: pinyin(titleZh, { pattern: 'first', toneType: 'none' }).replace(/\s+/g, '')
    };
}

// ── chart-file py: injection (BILINGUAL-SPEC.md §5.6) ──

const ZH_LINE_RE = /^(zh(?:-[A-Za-z]+)?):\s*(.*)$/i;
const PY_LINE_RE = /^py:\s*(.*)$/i;

function stripChordBrackets(text) {
    return text.replace(/\[[^\]]*\]/g, '');
}

// One toned syllable per input character, punctuation included as its own
// pass-through token — see the "known limitation" note in the file header
// on why that property matters (it's what lets the renderer zip pinyin
// against Han characters 1:1 for ruby annotation).
function generateLinePinyin(zhLyricText) {
    return pinyin(stripChordBrackets(zhLyricText), { toneType: 'symbol' });
}

async function walkFiles(dir) {
    const out = [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...await walkFiles(full));
        else if (entry.isFile()) out.push(full);
    }
    return out;
}

// Walks a chart body line by line, writing a fresh py: line beneath every
// zh-* line — replacing one that's already there (regeneration, so a
// changed lyric or a new exception-map entry gets picked up on the next
// run) or inserting a new one if there isn't. Returns the possibly-modified
// body plus how many py: lines were written or changed, so the caller can
// skip rewriting files that didn't need it.
function injectPinyin(bodyText) {
    const lines = bodyText.split('\n');
    const output = [];
    let changedCount = 0;

    for (let i = 0; i < lines.length; i++) {
        output.push(lines[i]);

        const zhMatch = lines[i].trim().match(ZH_LINE_RE);
        if (!zhMatch) continue;

        const pyLine = `py: ${generateLinePinyin(zhMatch[2])}`;
        const next = i + 1 < lines.length ? lines[i + 1] : null;

        if (next !== null && PY_LINE_RE.test(next.trim())) {
            if (next !== pyLine) changedCount++;
            lines[i + 1] = pyLine; // picked up by the loop on the next iteration
        } else {
            output.push(pyLine);
            changedCount++;
        }
    }

    return { text: output.join('\n'), changedCount };
}

async function updateChartFile(filePath, log) {
    const content = await readFile(filePath, 'utf8');
    const pre = extractPre(content);
    if (!pre || pre.format !== 'bilingual') return 0;

    const { text: newBody, changedCount } = injectPinyin(pre.body);
    if (changedCount === 0) return 0;

    const newContent = content.slice(0, pre.openEnd) + newBody + content.slice(pre.closeIdx);
    await writeFile(filePath, newContent, 'utf8');
    log(`${path.relative(REPO_ROOT, filePath)}: ${changedCount} py: line(s) written/updated`);
    return changedCount;
}

// Explicit key order so the rewritten file reads (and diffs) predictably,
// regardless of the order fields happened to be in on disk.
const FIELD_ORDER = [
    'title', 'titleZh', 'titleZhAlt', 'pinyin', 'pinyinInitials',
    'url', 'format', 'langs', 'ccli', 'bpm', 'timeSignature'
];

function reorder(record) {
    const out = {};
    for (const key of FIELD_ORDER) {
        if (key in record) out[key] = record[key];
    }
    for (const key of Object.keys(record)) {
        if (!(key in out)) out[key] = record[key]; // preserve any unexpected extra field
    }
    return out;
}

async function main() {
    const log = (msg) => console.log(msg);

    const exceptions = JSON.parse(await readFile(EXCEPTIONS_PATH, 'utf8'));
    customPinyin(exceptions); // applies to every pinyin() call below, both jobs
    log(`Loaded ${Object.keys(exceptions).length} pinyin exception(s) from ${path.relative(REPO_ROOT, EXCEPTIONS_PATH)}\n`);

    // ── job 1: data/songs.json generated fields ──
    log('── songs.json ──');
    const raw = await readFile(SONGS_PATH, 'utf8');
    const songs = JSON.parse(raw);

    let generatedCount = 0;
    const updated = songs.map((song) => {
        if (!song.titleZh) return reorder(song);

        generatedCount++;
        log(`${song.title} (${song.titleZh})`);
        const titleZhAlt = generateAltTitle(song.titleZh, log);
        const { pinyin: py, pinyinInitials } = generatePinyinFields(song.titleZh);
        log(`  titleZhAlt: ${titleZhAlt}`);
        log(`  pinyin: ${py}`);
        log(`  pinyinInitials: ${pinyinInitials}`);

        return reorder({ ...song, titleZhAlt, pinyin: py, pinyinInitials });
    });

    await writeFile(SONGS_PATH, JSON.stringify(updated, null, 2) + '\n', 'utf8');

    log(`\n${updated.length} records total, ${generatedCount} with titleZh (generated fields written).`);
    log(`Wrote ${path.relative(REPO_ROOT, SONGS_PATH)}`);

    // ── job 2: py: lines in v2 chart files ──
    log('\n── chart files (py: layer, BILINGUAL-SPEC.md §5.6) ──');
    const chartFiles = (await walkFiles(CHARTS_DIR)).filter(f => f.endsWith('.html'));

    let filesTouched = 0;
    let linesTouched = 0;
    for (const file of chartFiles) {
        const changed = await updateChartFile(file, log);
        if (changed > 0) {
            filesTouched++;
            linesTouched += changed;
        }
    }

    log(`\n${chartFiles.length} chart file(s) checked, ${filesTouched} updated, ${linesTouched} py: line(s) written/changed.`);
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
