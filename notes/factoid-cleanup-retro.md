# Factoid Cleanup Retro — 2026-04-13

First run of the Phase 3 cleanup scripts against the live DB. Captures
what worked, what didn't, and the threshold / rule changes to fold into
the recurring maintenance job (Phase 5).

## Starting state

620 active factoids. 262 tagged Person. Assessment:
`notes/farley-assessments/2026-04-13-pre-cleanup.json`.

## cleanup-factoid-types

72 rows updated across four rule buckets:

| Rule                                   | Count | Notes                                            |
|----------------------------------------|-------|--------------------------------------------------|
| Account — trailing account/login/etc   | 42    | Clean — no visible false positives               |
| Account — leading sign-in/login phrasing | 0   | Rule redundant at current data scale             |
| Playbook — command-tool prefix (`^tmux`) | 5   | Caught only the line-start form                  |
| Playbook — how-to/setup/cheatsheet      | 18    | Includes legitimate setups (eye tracking, nginx) |
| Place — trailing venue noun             | 7     | All 7 Prudential Center dupes                    |

**Miss pattern:** the command-tool prefix rule requires the tool name at
line-start, so titles like `detach from tmux session`, `kill all tmux
sessions`, `enable mouse mode in tmux` survive as Person. 19 Person
factoids still match the junk regex post-cleanup; most are this pattern.

**Fix for v2:** drop the `^` anchor on the command-tool rule, or add a
second rule `\b(tmux|kitty|vim)\s+(session|window|pane|mode|buffer)`
that specifically catches the command-object form.

## dedupe-factoids

Pair generation:

| Block              | Pair-hits |
|--------------------|-----------|
| A (norm-exact)     | 84        |
| B (pg_trgm)        | 244       |
| C (pgvector ≥0.80) | 179       |
| D (shared display) | 20        |
| **Unique pairs**   | **214**   |

Classification:

| Bucket   | Count |
|----------|-------|
| auto     | 84    |
| review   | 104   |
| rejected | 26    |

**LLM judge verdicts on review zone:** ~95 NO, ~9 YES (eyeballed from
the live output). Key YES calls:

- `Apple ID ≡ Gmail` (shared email zephyros.shah@gmail.com)
- `Apple ID ≡ Discord` (shared email)
- `oculus rift login ≡ oculus support login` (same user, same password variant)
- `fix shift-enter in claude code ≡ add shift+enter binding to claude keybindings` (same problem + fix)
- `Generate alternatives prompts ≡ Add BaseAuthoredBy and TargetAuthoredBy to prompts` (task + completion)

The judge was notably good at distinguishing "two services with the same
email/password" (many `*_login ≡ *_login` pairs in the review zone) from
"same account." It produced 0.95+ confidence on nearly every NO verdict,
which is what we want — those are correctly staying as separate Account
factoids. This is the single strongest signal that the review-zone /
LLM-judge architecture is earning its keep.

**Proposed merges:** 101. **Applied:** 64. The delta is transitive —
when pair (A,B) merges A→B and then pair (A,C) tries to merge A→C, the
union-find collapses it to B=C (same winner) and skips.

**False positive concerns in auto-merge:**

- `Amazon contact ≡ Amazon Interview Preparation` was auto-merged because
  the suffix stripper reduces both to `amazon`. In practice this is
  *fine* — "Amazon Interview Preparation" should be a child fact, not a
  factoid, and the soft merge pins it as a child of whichever Amazon row
  won. But the mechanism is load-bearing on the suffix list being
  correct. If the list grows and starts stripping meaningful content,
  this will silently over-merge.
- `Brad ≡ Brad's Background and Role` auto-merged. Same situation: the
  Background fragment becomes a child of the Brad factoid. However, in
  some cases the *fragment* won the winner-selection (more content, more
  children), and the bare-name factoid became inactive. reparent-fragments
  then couldn't find a bare-name parent and created a new Unknown one,
  leaving a duplicate Brad pair in the DB until next dedupe cycle.

**Threshold calibration for v2:**

- Auto threshold `norm_title_equal AND content_len_min > 20` is OK but
  consider adding: `AND NOT (titleA endsWith " from Y" AND titleB endsWith " from Z" AND Y != Z)` to handle the attribution-tail distinction more carefully.
- Winner selection should prefer the shorter/bare title over the
  fragment title when both are candidates, so reparent doesn't end up
  creating a fresh parent. Current rules bias toward "more children,
  longer content" which can pick the fragment. Add rule 0:
  `titleLength(a) < titleLength(b)/2 → a is winner` for this case.
- No pairs in the review zone were above `embedding > 0.9 AND
  trigram < 0.7` — that quadrant of the decision space is empty at
  current scale. Revisit when dataset grows.

## reparent-fragments

4 prefix clusters, 32 fragments reparented across 4 newly created
Unknown parents (Vineel, Brad, Neela, Amazon).

Fragment counts after run:
- vineel: 13 (was 12 pre-dedupe; 1 new from the auto-merge aftermath)
- amazon: 3
- brad: 3

All three clusters now have "parent_exists=true" in the post-cleanup
assessment, meaning the structure invariant holds.

**Issue with parent creation type:** created as Unknown per the
conservative default. In this dataset, three of the four (Vineel, Brad,
Neela) should be Person and one (Amazon) should be Organization. Phase 5
seed will correct via human-verified upserts.

## Outcomes vs. goals

Farley file's explicit goal is "one factoid per real-world entity." We
went from 262 Person factoids to 186. Known real humans in Vineel's
orbit are ~40–50, so we're still 3–4× over. The remaining gap is not
duplication — it's **misclassification of organizations and accounts as
Person**, which the extractor prompt rewrite (Phase 1) stopped the
bleeding on but did not retroactively fix.

Next meaningful reduction in Person count will come from a type-
assignment LLM sweep over the 207 `factoid_type=NULL` rows *and* a
second pass that re-evaluates Person-tagged rows with short content and
no children (currently 135 of them) to demote junk or reclassify.

## Folding into maintenance

What moves into the recurring worker (Phase 5 / daily-weekly-monthly):

1. **Daily:** Blocks A + D on factoids created in the last 24h, auto-merge tier only, no LLM.
2. **Weekly:** full signal stack on factoids created that week, LLM judge on review zone, email the resulting list via digest for human approval before applying.
3. **Monthly:** full rescan of everything, emit retro-style report, hand-review anything with confidence < 0.85.

Before any of this runs autonomously:

- Fix the command-tool rule (remove `^` anchor, add command-object form).
- Tighten suffix list — or better, move suffix stripping out of the
  normalizer used for auto-merge decisions, and only use it for the
  first-token / prefix fallbacks. A `normalized_title_strict` for the
  auto tier and a `normalized_title_loose` for candidate generation.
- Add the "prefer bare-title winner" rule to winner selection to stop
  fragments from beating their parents.
- Promote created parents from Unknown to correct type via Phase 5 seed.

## Pre-cleanup / post-cleanup snapshots

- `notes/farley-assessments/2026-04-13-pre-cleanup.json`
- `notes/farley-assessments/2026-04-13-post-cleanup.json`
- Re-run: `bun run memory:assess -- --diff 2026-04-13-pre-cleanup 2026-04-13-post-cleanup`
