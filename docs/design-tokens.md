# HealthHawk — Canonical Design Tokens: "The Honest Label"

Status: **CANONICAL — single source of truth** for the whole site (every page, dev task,
collection surface and blog post). Founder-approved design preview 2026-11-22
(`docs/reports/p3-research/healthhawk-design-preview.html`), ratified in
`docs/PRD-PROTOTYPE3.md` Implementation Decisions. Injected into Hashmeta guidelines,
design config and global styles by slice P3-01 (readback evidence: `runs/p3-01/`).

**Supersession:** this document SUPERSEDES the P1 "calm minimal / Apple HIG-inspired /
system font" aesthetic lock (founder: "follow the skill and go for bold design, no need
to go with my suggestions") and **retires all three competing token sets**:

1. README prose tokens (P1 `docs/README.md` §5 "Visual tokens" — off-white/teal prose, 960px, 1px borders) — superseded, pointer retained.
2. Old live site config values (`#faf9f7` background, `#1c1b1a` text, `-apple-system` stack, 8px radii, 1280/720/1440 containers) — replaced on the platform by this set. **Supersession caveat (P3-08 review B MINOR-1):** the Products collection detail/list templates kept legacy inline residue (`#1C1B1A` ink, `#FFFFFF` card, `#E7E5E4` borders, 9999px stamp pills) until the **P3-08b** template slice staged canonical tokens + the shell `.hh-grade` stamp shape (`templates/collection-*.html`, `runs/p3-08b/`) — true on the collection surface **once that staged sync publishes**.
3. Blue app tokens (`#0071e3` accent, `#ffffff` bg, `#1d1d1f` text, grade palette `#1f7a35/#7bb026/#c99700/#e07000/#d70015`, 640px column) — retired by the P3-03 re-skin.

Historical documents keep their narrative; where they define tokens, they now point here.

## 1. Colour tokens

### Core palette

| Token | Hex | Role |
|---|---|---|
| Paper | `#F6F0E4` | Page background (warm paper) |
| Card | `#FFFDF8` | Card / surface background |
| Ink | `#1B1917` | Text, rules, borders |
| Hawk teal | `#0F766E` | Brand, primary actions, links |
| Teal deep | `#0B5D57` | Hover / pressed teal |
| Grade A | `#15803D` | Filled grade stamp A |
| Grade B | `#65A30D` | Filled grade stamp B |
| Grade C | `#CA8A04` | Filled grade stamp C |
| Grade D | `#EA580C` | Filled grade stamp D |
| Grade E | `#DC2626` | Filled grade stamp E |
| Flag red | `#B91C1C` | Flag stamps / label-watch ONLY (never a grade colour) |
| Honest grey | `#6B7280` | "Not yet rated", staleness, missing data |

### Supporting tokens (from the approved preview)

| Token | Hex | Role |
|---|---|---|
| Paper 2 | `#EFE7D6` | Alternate section background; unrated stamp fill |
| Ink soft | `#57534E` | Secondary text, verdicts, captions |
| Line | `#D8CFBC` | Hairline dividers, photo borders |
| Teal tint | `#E3EEEC` | Tinted panels, photo placeholder fill, hover fills |
| Flag bg | `#FBEAE9` | Flag stamp / flag line background |
| Amber | `#B45309` | Warning safety tags, best-value notice |
| Amber bg | `#FBF3E4` | Best-value notice background |
| Hero gold | `#F6D55C` | Hero headline emphasis + wordmark dot (on teal only) |
| Hero sub | `#EAF3F1` | Hero sub-copy on teal |
| Hero stats | `#D7E5E2` | Hero stat line on teal |
| Footer text | `#C9C2B4` | Footer body text on ink |

**Colour discipline:** teal = brand/actions. Saturation only on grade stamps, safety
tags and flag stamps. Everything else paper/ink. Grade stamps are FILLED (white
letter + icon + word on the grade colour, 2px ink border). Flag stamps are RED
OUTLINED (flag red border + text on flag-bg). Unrated = paper-2 fill, grey border,
grey "–/Unrated". Two visual languages, never confused.

## 2. Typography

| Token | Value | Use |
|---|---|---|
| Display | `"Fraunces", Georgia, serif` | Headlines, prices, grade letters — the "honest newspaper" voice |
| Body | `"Atkinson Hyperlegible", Verdana, sans-serif` | ALL UI text, verdicts, evidence, labels — designed for low-vision readers |

Load via Google Fonts CSS2 (both families, `display=swap`):

```
https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;0,9..144,700;1,9..144,600&family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&display=swap
```

Base 16px, body line-height 1.6. Display weights 500–700 (700 for headlines/prices/grade
letters); body 400/700. Hero h1 `clamp(40px, 6vw, 68px)`, line-height ~1.04, tracking
−0.015em; section h2 28px; card name 18px/700; verdict 15px; price big 30px display;
unit price 13px ink-soft; eyebrows 12–13px/700 uppercase, letter-spacing .12–.22em.
Plain language everywhere (grade 4–6 reading level).

## 3. Rules, shape, grid, layout

- **Flat design: no gradients, no shadows, no blur.** Depth comes from ink rules and paper/card contrast.
- **Rules:** 2–3px solid ink borders (nutrition-label style). 3px for header/hero/section-head rules; 2px for cards, stamps, inputs, buttons. 1px ink or `Line` for fine dividers only.
- **Radii:** 10–12px on cards/stamps/panels (12px cards, 10px grade stamps and small panels); 8px small elements (photos, small buttons); 999px pills for chips/tags/presets.
- **Grid:** 8pt spacing grid (8/16/24/32/48/64…).
- **Container:** ~1080px max-width, centred, 24px side padding. Mobile-first.
- **Touch targets ≥44px; WCAG AA contrast** on paper and card for every grade/flag/safety state.
- Header: sticky, paper background, 3px ink bottom rule, 72px tall, one wordmark. Footer: ink background, paper headings, footer-text body. ONE header/footer site-wide.

## 4. Motion

- **One staggered page reveal:** rows rise 14px + fade in, ~500ms ease, stagger ~60ms per row (max ~5 steps).
- **Preset reorder ~200ms** (list re-render transition; preview uses a 350ms rise on reorder — target ~200ms, never longer than 350ms).
- Hover micro-transitions ≤180ms (translateY(−2px) + border-colour on rows).
- **`prefers-reduced-motion: reduce` respected everywhere** — all animation/transition durations collapse to 0.
- No other motion. No confetti, no ornament, no gamification.

## 5. Consistency contract (audit checklist for reviewers — non-negotiable)

1. **One header/footer** on every surface (no second brand header inside pages).
2. **One token set** — this document; no competing palettes, fonts or radii anywhere.
3. **One card anatomy:** photo · grade stamp · name · ≤8-word verdict · price big + unit small · ≤2 safety tags · one evidence tap ("ⓘ How we know").
4. **Two visual languages:** grades = filled stamps (colour + letter + icon + word); flags = red outlined stamps. Never confused.
5. **Max 2 disclosure levels** — evidence one labelled tap away, at most two levels deep.
6. **≤12 visible controls per screen.**
7. **Plain language** (grade 4–6 reading level) on every surface.
8. **Honest states everywhere:** grey "Not yet rated" (priced, sorted last), "price checked {date}" staleness stamps, loading skeletons, two distinct empty states (filter-empty vs search-empty).

## 6. Functional guardrails (unchanged from the PRD — non-negotiable)

- Grade = colour + letter + icon + word (colour never alone).
- Flags are a distinct visual language from grades.
- Safety tags (allergen/Halal/G6PD) never buried — always visible on every product surface.
- Evidence one tap / max 2 levels.
- Disclaimers on the surface of every product view (within-category comparison, not medical advice; computed with Nutri-Score 2023, not an official mark).
- Honest states (unrated grey, staleness, empty states).
- Ranking integrity (like-with-like within department + range under every preset; flags never reshuffle the ranked list).
- Precise legal record under every plain summary.
- No "lies/fake/scam" phrasing.
- Grey zones = "unverified", never accusations.

## 7. Image policy (amended G3, founder-approved)

No retailer hotlinks / external image fetches. **Self-hosted Hashmeta media URLs are
allowed**, with CC BY-SA attribution (licence + Open Food Facts page link) and a
"packaging may differ" note; lazy-loaded; generic icon fallback when no photo; never
AI-generated pack lookalikes. Migration + test enforcement landed in slice P3-05
(`scripts/p3-image-migrate.mjs`, `app/media-manifest.json`,
`tests/p3-image-migration.test.mjs`, G3 guardrail in `scripts/p2-ux-full-dom.mjs`).

## 8. Single-source chain

```
docs/design-tokens.md  (this file — the rulebook)
        │
        ├── app/tokens.css        :root CSS custom properties consumed by the app build
        │                          (wired into app/index.html by slice P3-03)
        └── Hashmeta platform     guidelines (rulebook + contract + image policy)
                                   design config (palette + fonts + shape)
                                   global styles (component layer on these tokens)
```

Every future page, dev task and blog post inherits the scheme from the platform
injection; every repo surface reads this document. Changes to the scheme happen
HERE first, then propagate to `app/tokens.css` and the platform in the same slice.

## 9. P4 parent-first simplification — rendering override (2026-11-23)

Founder-approved override (`docs/PRD-P4-SIMPLIFY.md`, slices P4-01…P4-05): the P3
"precise legal record stays byte-preserved underneath" rendering decision is
OVERRIDDEN — the deep layer is now TRIMMED, not a full dump. Two layers, both
simple: plain words on the surface; one tap deeper = trimmed proof (exact claim
quote + exact label quote + one plain rule line + source link). The precise legal
record stays in the frozen data/repo, not on screen — this clarifies §6's
"Precise legal record under every plain summary" guardrail: the record must
exist and be verifiable, but it no longer renders in full. Display-only: the
data freeze is intact (zero data/ writes; verdicts, scores, flags and sources
keep their exact values).