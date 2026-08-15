# GEAR — Bilingual Chart Format (v2)

Drop this file in the repo root next to `DESIGN.md`. Claude Code reads it automatically
when it's referenced from `CLAUDE.md`, so it becomes the contract for every bilingual
change instead of something you re-explain each session.

---

## 1. Goals & non-goals

**Goals**

- One song = one entity = one chart file, regardless of how many languages it has.
- Chord/lyric alignment that does not depend on monospace character counting.
- Per-section language selection ("Verse in Chinese, Chorus in English") as data.
- Mandarin-only songs handled by the same code path as bilingual ones.
- Zero required changes to the 308 existing English charts.

**Non-goals**

- Migrating the existing English-only library. v1 charts stay v1 forever unless a
  Mandarin layer is added to one.
- Replacing `data/songs.json` with a database. It stays a single fetched JSON array.

---

## 2. Backward compatibility

`data-format` is the discriminator.

| Wrapper | Parser | Notes |
|---|---|---|
| `<pre class="chord-chart" data-key="G">` | v1 (existing) | 308 files. Untouched. |
| `<pre class="chord-chart" data-key="A" data-format="bilingual">` | v2 (new) | Bilingual + Mandarin-only. |

`fetchSongContent()` must branch on `data-format`. Everything without it keeps using
`transposeText()` exactly as it does today.

**Also change while you're in there:** `fetchSongContent()` currently extracts the chart
with `html.match(/<pre[^>]*data-key="([^"]+)"[^>]*>(.*?)<\/pre>/s)`, which can only pull
one attribute. Replace it with `DOMParser` so all `data-*` attributes are available:

```js
const doc  = new DOMParser().parseFromString(html, 'text/html');
const pre  = doc.querySelector('pre.chord-chart');
const meta = { ...pre.dataset };            // { key, format, langs, ... }
const body = pre.textContent;
```

---

## 3. File layout & naming

```
charts/<LETTER>/<ascii-slug>.html
```

- `<LETTER>` — first letter of the **English** title. For Mandarin-only songs, use the
  first letter of the **pinyin** of the Chinese title (圣洁到永远 → `S`). This keeps the
  existing A–Z browse structure coherent.
- `<ascii-slug>` — lowercase ASCII, hyphenated. `holy-forever.html`, `for-you-alone.html`.

### Never put Han characters in filenames

macOS stores filenames as NFD (decomposed), Linux serves them as NFC (composed), and git
commits whatever the filesystem gave it. `charts/S/圣洁到永远.html` will work on your Mac
and 404 on gh-pages. Percent-encoding in `songs.json` does not save you — the bytes on
disk differ. Keep Chinese titles in `songs.json`, keep filenames ASCII.

While migrating, it's worth normalising the existing v1 filenames to slugs too
(`God%20Be%20Praised.html` → `god-be-praised.html`), since `songs.json` is the only thing
that references them. Optional, but it removes a whole class of URL-encoding bugs.

---

## 4. Wrapper attributes

```html
<pre class="chord-chart"
     data-format="bilingual"
     data-key="A"
     data-langs="en,zh-Hant"
     data-primary="en">
```

| Attribute | Required | Meaning |
|---|---|---|
| `data-format` | yes | Always `bilingual` for v2. |
| `data-key` | yes | Written key of the chords in the file. |
| `data-langs` | yes | Comma-separated, in authoring order. `en,zh-Hant`, `en,zh-Hans`, or `zh-Hans` alone. |
| `data-primary` | no | Default top layer when mode is "both". Defaults to first of `data-langs`. |

Use `zh-Hant` / `zh-Hans` precisely, not bare `zh` — it drives the `lang` attribute on
rendered lines, which is what makes browsers pick the right regional glyph variants. Your
current material mixes both scripts (聖潔 vs 圣洁), so this matters.

---

## 5. Body syntax

### 5.1 Section headers

A line whose entire trimmed content is a bracketed section name:

```
[Intro]  [Verse]  [Verse 1]  [Pre-Chorus]  [Chorus 1]  [Bridge]
[Interlude]  [Tag]  [Instrumental]  [Ending]  [Coda]  [Outro]
[Turnaround]  [End]  [Final Chorus]  [Echo]  [High Praise]
```

Same allow-list your v1 renderer already uses. Anything else in brackets on its own line
is a validation error, not a header — that's what keeps section headers and inline chords
unambiguous.

Matching is case- and separator-insensitive: `[high-praise]`, `[HIGH_PRAISE]`, and
`[High Praise]` are the same header. A number or short free-text suffix is allowed after
the header word, separated or not (`[Verse1]`, `[Chorus 2]`, `[Bridge tag]`) — the suffix
is kept verbatim, only the header word itself is canonicalized. Whatever spelling a chart
author used, the parser, renderer, and validator all agree on one canonical display form
(`Pre-Chorus`, `High Praise`, …) — `js/chart-constants.js`'s `matchSectionHeader()` is the
single implementation all three call, so this can't drift into three slightly-different
regexes the way it did before.

### 5.2 Lyric lines

Prefix `<lang>:` then the lyric with chords inline in square brackets. A chord binds to
the character immediately after it.

```
[Verse]
en: [A]You are the [C#m7]peace that guards my [F#m]heart
zh: [A]祢是平[C#m7]安保守我[F#m]心
en: [Bm7]My help in [E7]times of need
zh: [Bm7]我随时的[E7]帮助
```

Consecutive lines with different language prefixes form one **line group** — two
renditions of the same musical phrase. A blank line or a section header closes the group.

Chords are repeated on each language line **on purpose**: Chinese syllable counts differ
from English, so chord positions genuinely differ. The validator (§8) enforces that the
chord *sequence* matches across a group, which is what stops the two from drifting.

### 5.3 Chord-only lines

No prefix. Used for intros, turnarounds, instrumentals. Rendered once, shared by all
language modes.

```
[Intro]
| D | F#m | Esus4 | . |
| A/C# | F#m | Esus4 | . |
```

`|` and `.` are passed through as-is. Bare chords without pipes also work: `Em D G C`.

### 5.4 Performance notes and repeats

```
{note: Drums in}
{note: Guitar & Keys hold A at the end}
{repeat: x2}
{goto: Chorus}
{segue: Amazing Grace}
```

Rendered as an italic aside, never transposed, excluded from language filtering. These are
the `*Drums in*` / `*Soft*` annotations from your Word doc's Song Order table.

`{goto: <section>}` is a navigation cue to a section elsewhere in the same chart ("go back
to the Chorus"), replacing what used to get hand-written as a fake section header like
`[To Chorus]` — those aren't section names, and forcing them through the §5.1 allow-list
was never right. `{segue: <title>}` is the same idea pointed at a *different* song ("go
straight into I Have Decided to Follow Jesus") rather than a section of this one. Neither
is validated against the section allow-list or any other chart's contents — `<section>` and
`<title>` are free text, exactly like `{note: ...}`'s.

### 5.5 Comments

`#` at the start of a line. Stripped at parse time, never rendered. Use for source notes,
translator credits, TODOs.

### 5.6 Generated layers

`py:` (pinyin) is **generated at build time, never authored**. The build script derives it
from the `zh-*` line and writes it back. Hand-edits get overwritten — if a reading is
wrong, fix it in the build script's exception map, not the chart.

---

## 6. Rendering model

Parse to:

```
Chart
 ├ meta: { key, langs, primary }
 └ sections: [{
     name: "Verse",
     groups: [{
       lines: [{ lang: "en", units: [{ chord: "A", text: "You are the " }, ...] }, ...],
       notes: []
     }]
   }]
```

### 6.1 Alignment

Each unit renders as an inline-block stack. No monospace requirement, no whitespace
counting, reflows on narrow screens:

```html
<span class="unit">
  <span class="chord" data-chord="A">A</span>
  <span class="syl">You are the </span>
</span>
```

```css
.unit  { display: inline-block; vertical-align: bottom; }
.chord { display: block; font-weight: 600; font-size: 0.8125em;
         color: var(--color-secondary); }
.lyric-line[lang^="zh"] { font-family: var(--font-mono-cjk); }
```

Add to your token set in `style.css`:

```css
--font-mono-cjk: 'Noto Sans Mono CJK SC', 'Noto Sans Mono CJK TC',
                 'Noto Sans Mono', 'PingFang SC', 'Microsoft YaHei', monospace;
```

Preload the CJK face alongside the Noto Serif / Manrope pair already in `index.html`.
Subset it if the download size bothers you — a praise-song corpus needs maybe 1,500 glyphs.

### 6.2 Language modes

Persist the choice in `localStorage` under `chartLang`, same pattern as your existing
`theme` key.

| Mode | Renders |
|---|---|
| `en` | English only |
| `zh` | Chinese only |
| `en-zh` | English above Chinese |
| `zh-en` | Chinese above English |

Modes unavailable for a given chart (`en` on a Mandarin-only song) are disabled, not hidden.

### 6.3 Per-section override

Each section header gets a small language chip. Overriding it sets that section's mode
independently. The resulting map is the song's **language plan**:

```json
{ "Verse": "zh", "Chorus": "en", "Bridge": "zh-en" }
```

This is your Word doc's Song Order table as data. It belongs to the **setlist entry**, not
the chart file — the same song gets a different plan for a Main vs Recessional slot, which
your `YOU ARE HOLY` page already demonstrates.

### 6.4 Transposition

Operate on parsed `unit.chord` tokens. Delete the "is every token on this line a chord?"
heuristic — it's no longer needed and it was the fragile part.

While rewriting, fix the enharmonic spelling. `transposeNote()` currently always returns
from the sharp array, so transposing into E♭ yields `G#` where a chart should read `A♭`.
Choose the accidental from the target key:

```
sharp keys: G D A E B F#
flat keys:  F Bb Eb Ab Db Gb
```

---

## 7. `songs.json` schema additions

All new fields optional, so existing records stay valid.

```json
{
  "title": "Holy Forever",
  "titleZh": "圣洁到永远",
  "url": "charts/H/holy-forever.html",
  "format": "bilingual",
  "langs": ["en", "zh-Hans"],
  "ccli": "7201044",
  "bpm": "72",
  "timeSignature": "4/4 time",

  "titleZhAlt": "聖潔到永遠",
  "pinyin": "sheng jie dao yong yuan",
  "pinyinInitials": "sjdyy"
}
```

The bottom three are **generated** by `tools/build-index.mjs` (§9) — do not hand-edit.
`titleZhAlt` is the opposite-script form, so a member typing 聖潔 finds a chart authored
in 简体.

Mandarin-only songs use `title` for the Chinese name and set `langs: ["zh-Hans"]`, with
`titleEn` optional if a descriptive English name is useful for the team.

---

## 8. Validator rules

`tools/validate-charts.mjs`, run in CI on every push:

1. Every chart parses.
2. Every bracketed token matches `^[A-G](#|b)?(m|maj|min|dim|aug|sus|add|M|[2456791113])*(/[A-G](#|b)?)?$`.
3. Every bare-bracket line is in the §5.1 section allow-list (case- and separator-
   insensitive match).
4. Within a line group, all language lines carry the **same chord sequence**. This is the
   one drift risk the format introduces; catching it in CI is what makes duplication safe.
5. `data-key` is a real key, and the chart's first chord is diatonic to it or a common
   borrowed chord (bVI, bVII) — not a strict first-chord-equals-key match, since worship
   charts routinely open on an intro/pickup chord (IV, V, vi) rather than the tonic.
6. Every `songs.json` `url` resolves to a file on disk, and every chart file appears in
   `songs.json`. (Worth running against your current 308 too — orphans accumulate.)
7. No non-ASCII bytes in any path under `charts/`.

Fail the build on 1–4 and 7; warn on 5–6.

---

## 9. Build scripts

```
tools/
  build-index.mjs      # derives titleZhAlt, pinyin, pinyinInitials → songs.json
  validate-charts.mjs  # §8
  docx-to-chart.mjs    # converts a service-pack .docx into v2 chart files
```

`build-index.mjs` uses `pinyin-pro` and `opencc-js`, runs locally, and commits its output —
gh-pages serves static files, so nothing runs at request time and there's no runtime
dependency to load.

`docx-to-chart.mjs` is the highest-leverage one: you already have years of bilingual
service packs in exactly the shape of `20260510_Team_2__Euan__Combined_Service_.docx`
(chord run, English run, Chinese run, repeat). Converting them beats retyping.

---

## 10. Migration order

1. Parser + renderer + language toggle, behind `data-format`. Ship with one hand-written
   chart to prove it.
2. `docx-to-chart.mjs`, run over your existing service packs. Hand-check the output — the
   Word docs use hand-padded spacing, so syllable-to-chord binding needs eyes on it.
3. Search index + language filter chips.
4. Setlist language plan + docx export of the Song Order table.
5. CI validator.
6. Pinyin ruby layer.
