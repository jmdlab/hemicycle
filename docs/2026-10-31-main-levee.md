# Show-of-hands votes (votes à main levée) — chantier note

**Goal:** on each bill page, list amendments decided without a public scrutin (no per-deputy detail).

**State (2026-10-31, commit 47ff699b9):** live. PLF 2027: 273 listed. Real test case n° 459 (PLF 2027, 16/10). Reviewed by Codex and Fable 5.1, all findings fixed, 25/25 tests (`node --test tests/*.test.mjs`).

**Files:** `scripts/refresh-amendements.mjs` (HTTP range reader for the AN archive; daily step and every quiet poll), `server/data/amendements.mjs` (zip reader, `amendementRefs`, `mainLevee`), `server/loi.mjs` (`mainLeveeFor`, crawler HTML), `src/components/BillPage.tsx` (`MainLeveeSection`).

**Next (optional):** the section shows on about 1 bill page in 4, because older normalized records lack `dossierRef` (fill it in at normalize). Size `ML_MARGIN_MS` (6 h) from data once poll logs the scrutin's hour.

**Pitfalls:** never commit `storage/` (raw holds members' contact details). Join rule: when in doubt, leave the amendment out (margin, ±1 day cover, unreadable titles hide their day). `node --test tests/` fails; use the glob.
