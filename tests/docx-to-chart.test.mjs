// Regression test for the Heading3-styled service-pack branch of
// tools/docx-to-chart.mjs, using the fixture at tests/fixtures/heading3-sample.docx
// (two Christmas/Amazing-Grace-style songs, both titled with a Heading3-styled
// paragraph — no bold+italic — per the tool's own header comment: "a
// Heading3-styled paragraph (the clean pack this tool was originally written
// against ...) or a bold+italic paragraph (messier service packs)").
//
// Runs the real CLI as a subprocess (docx-to-chart.mjs calls main()
// unconditionally at module load, keyed off process.argv, so it can't be
// imported and driven directly) against --charts-dir/--out-dir pointed at a
// throwaway temp directory — never the real charts/ or tools/out/.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPre } from '../tools/lib/chart-file.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'tools/docx-to-chart.mjs');
const FIXTURE = path.join(__dirname, 'fixtures/heading3-sample.docx');

describe('docx-to-chart.mjs — Heading3-style service pack', () => {
    let tmpDir, chartsDir, outDir, stdout;

    before(() => {
        tmpDir = mkdtempSync(path.join(tmpdir(), 'docx-to-chart-test-'));
        chartsDir = path.join(tmpDir, 'charts');
        outDir = path.join(tmpDir, 'out');

        // --force: the fixture's first song is deliberately titled "Amazing
        // Grace", which already exists in the real catalog, so the tool's
        // collision guard (checked against the real data/songs.json/charts/
        // regardless of --charts-dir) would otherwise refuse to write
        // anything. Safe to force here since --charts-dir/--out-dir are both
        // scoped to the throwaway tmpDir above, never the real repo paths.
        stdout = execFileSync(process.execPath, [
            SCRIPT, FIXTURE, '--force', '--charts-dir', chartsDir, '--out-dir', outDir
        ], { encoding: 'utf8' });
    });

    after(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('recognizes both songs via the Heading3 branch, not the bold+italic backstop', () => {
        // Neither title paragraph in the fixture is bold+italic — only
        // pStyle="Heading3" — so isSongTitleBlock() only recognizes them at
        // all if its `b.style === 'Heading3'` check fires on its own,
        // independent of the `b.bold && b.italic` fallback beneath it.
        assert.match(stdout, /song: "Amazing Grace"/);
        assert.match(stdout, /song: "Silent Night"/);
        assert.match(stdout, /songs processed: 2/);
    });

    it('parses CCLI/key/time-signature/BPM metadata for both songs', () => {
        const patch = JSON.parse(readFileSync(path.join(outDir, 'songs-patch.json'), 'utf8'));
        const grace = patch.find(s => s.title === 'Amazing Grace');
        const silent = patch.find(s => s.title === 'Silent Night');

        assert.ok(grace, 'Amazing Grace missing from the songs.json patch');
        assert.equal(grace.ccli, '22025');
        assert.equal(grace.bpm, '72');
        assert.equal(grace.timeSignature, '3/4 time');

        assert.ok(silent, 'Silent Night missing from the songs.json patch');
        assert.equal(silent.ccli, '27862');
        assert.equal(silent.bpm, '68');
        assert.equal(silent.timeSignature, '4/4 time');

        // data-key on the written chart fragment itself, not just the patch.
        const graceChart = readFileSync(path.join(chartsDir, 'A/amazing-grace.html'), 'utf8');
        const silentChart = readFileSync(path.join(chartsDir, 'S/silent-night.html'), 'utf8');
        assert.equal(extractPre(graceChart).key, 'G');
        assert.equal(extractPre(silentChart).key, 'C');
    });

    it('carries the Song Order table into the sidecar', () => {
        const grace = JSON.parse(readFileSync(path.join(outDir, 'song-order/amazing-grace.json'), 'utf8'));
        const silent = JSON.parse(readFileSync(path.join(outDir, 'song-order/silent-night.json'), 'utf8'));

        // Amazing Grace's table is a plain Verse/English + Verse/Chinese
        // pairing, no performance note.
        assert.deepEqual(grace.sectionOverrides.Verse, ['en', 'zh']);

        // Silent Night's table carries a "*Candles lit" note on its
        // Chinese-only Verse row — the note text must survive into the
        // sidecar alongside the mode, not just the mode on its own.
        assert.equal(silent.sectionOverrides.Verse.length, 1);
        assert.equal(silent.sectionOverrides.Verse[0].mode, 'zh');
        assert.equal(silent.sectionOverrides.Verse[0].note, 'Candles lit');
    });
});
