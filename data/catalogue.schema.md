# Catalogue schema (v1) — three-key product model

Source of truth: `data/catalogue.json`. Validated by `scripts/validate-catalogue.mjs`
(EAN-uniqueness canary + handoff-contract checks). Every automated write MUST pass
the validator before and after writing; a failed write is rolled back.

## Top level

```json
{
  "schemaVersion": 1,
  "updatedAt": "<ISO-8601 timestamp of last write>",
  "products": [ <product record>, ... ]
}
```

## Product record

| Field | Type | Required | Notes |
|---|---|---|---|
| `ean` | string | yes | EAN/GTIN as **text** (never a number). Unique across catalogue — canary. Missing EAN → fuzzy match path, human-confirmed; not auto-written. |
| `name` | string | yes | Retailer product name, verbatim. |
| `brand` | string | yes | |
| `department` | string | yes | Retailer-aligned, browse-only (e.g. `Breakfast`). |
| `range` | string | yes | Like-with-like ranking key: `R1`–`R5` for cereals. Format/positioning/process only — zero nutrient gates. |
| `scoring_category` | string | yes | Computed lookup from range+format, e.g. `nutriscore-2023-general-foods`, `sg-nutri-grade-beverage`. |
| `attributes` | object | yes | Filters, never ranges: `kidsPositioned`, `coated`, `glutenFreeLabelClaim`, `organic`, … booleans/strings. |
| `offers` | array | yes | ≥1 offer; one product, many store offers. See below. |
| `ingredients` | object \| null | yes (may be null) | `{ text, provenanceTier, sourceUrl, fetchedAt }`. Null = honest gap, never fabricated. |
| `nutrition` | object \| null | yes (may be null) | See below. Null → product is "Not yet rated". |
| `halal` | object | yes | `{ status: "certified" \| "not-certified" \| "unknown", basis, sourceUrl }`. Certification/retailer attribute ONLY — never inferred from ingredients. |
| `classifierId` | string | yes | Who/what assigned department/range/scoring_category (agent session ID or human classifier name). |
| `timestamp` | ISO-8601 string | yes | When this record was produced/last updated. |
| `confidence` | `"high" \| "medium" \| "low"` | yes | Classification confidence. Low → routed to human review (pending/). |
| `rated` | boolean | yes | false whenever ingredients/nutrition incomplete or the per-100g basis is unusable → grey "Not yet rated". **Also false while a computed grade awaits founder approval** (stage C+): `score` may be non-null with `rated: false`; the public surface shows "Not yet rated" until the `grade-change` item in `pending/` is approved. **Validator-enforced:** `rated: true` requires a usable per-100g basis + a computed `score.grade` + an approved approval record (shared helper `scripts/approval-gate.mjs`); `fetch-product.mjs` always writes `rated: false`. |
| `score` | object \| null | no | Deterministic output of `scripts/score.mjs` (never LLM arithmetic): `algorithm`, `scriptVersion`, `scoredAt`, `inputs`, per-component points, `points` (s), `grade` (display name **Hawk Grade**, attribution "derived using the Nutri-Score 2023 algorithm"), `H`, `pPer100g`, `pMinRange`, `V`, `S` per preset. Null until scored. A stored score with `rated: false` = computed but **pending approval** — never displayed publicly. |
| `notes` | string | no | Free-text audit notes. |

## Offer

| Field | Type | Required | Notes |
|---|---|---|---|
| `store` | string | yes | `FairPrice` \| `Cold Storage` |
| `packPrice` | number > 0 | yes | SGD, as displayed at fetch time. |
| `packSize` | string | yes | Verbatim, e.g. `275G`. |
| `packSizeGrams` | number > 0 | yes | Normalized pack mass for unit pricing. |
| `pricePer100g` | number > 0 | yes | Derived: `packPrice / packSizeGrams * 100`, rounded to 4 dp. |
| `priceCheckedAt` | ISO-8601 string | yes | Fetch timestamp — drives "price checked {date}". |
| `sourceUrl` | https URL string | yes | Canonical product page (no tracking params). |

## Nutrition

```json
{
  "basis": "per-serving",
  "servingSizeG": 30,
  "servingSizeProvenanceTier": "label-declared",
  "servingDescription": "verbatim pack serving statement",
  "perServing": { "<nutrient>": { "value": <number>, "unit": "g|mg|kJ|kcal", "provenanceTier": "<tier>" } },
  "per100g":   { "<nutrient>": { "value": <number>, "unit": "g|mg|kJ|kcal", "provenanceTier": "<tier>" } }
}
```

- **Every numeric nutrition field is an object carrying `provenanceTier`.** A bare
  number is a contract violation and the validator rejects it.
- Nutrient keys (snake_case, no unit suffix): `energy_kj`, `energy_kcal`, `protein`,
  `carbohydrate`, `sugars`, `fat`, `saturated_fat`, `fibre`, `sodium`, `salt`.
  Unit lives in `unit`.
- FairPrice panels are per-serving. `per100g` derived from the pack's **stated**
  serving size → tier `estimated-derived`. If serving size is absent, do NOT
  silently assume one — leave `per100g` null and mark the gap.
- **OFF enrichment (stage B+):** Open Food Facts barcode reads supply per-100g
  values stated directly on the label → tier `off-label`, no serving size
  required. OFF is a **separate provenance layer**: retailer `perServing` values
  are never overwritten; the OFF source, fetch time, licence and cross-check are
  recorded in `nutrition.off`:

  ```json
  "off": {
    "source": "Open Food Facts",
    "url": "https://world.openfoodfacts.org/api/v2/product/<EAN>.json",
    "fetchedAt": "<ISO-8601>",
    "license": "ODbL-1.0",
    "attribution": "Contains information from Open Food Facts (https://world.openfoodfacts.org), licensed under ODbL 1.0.",
    "servingQuantityG": 30,
    "servingSize": "<verbatim OFF serving_size or null>",
    "imageIngredientsUrl": "<url or null>",
    "imageNutritionUrl": "<url or null>",
    "crossCheck": { "impliedServingG": { "<nutrient>": <number> }, "discrepancies": [ "..." ] }
  }
  ```

- Missing values stay missing (`null` or absent key). Never fabricate.
- **OCR enrichment (stage C+):** when a label photo is transcribed via OCR
  (`qwenwork_media_read`), the evidence is anchored in a separate `nutrition.ocr`
  layer. Any nutrition field using tier `ocr-label` REQUIRES this layer
  (validator-enforced); existing layers are never overwritten and panel
  disagreements are adjudicated in writing inside it:

  ```json
  "ocr": {
    "imageUrl": "<https label-photo URL>",
    "imageUrlSource": "<where the URL came from>",
    "tool": "qwenwork_media_read",
    "transcribedAt": "<ISO-8601>",
    "transcribedBy": "<agent session id>",
    "verbatimTranscription": "runs/raw/ocr-nutrition-<EAN>.md",
    "structuredEvidence": "runs/raw/ocr-nutrition-<EAN>.json",
    "conclusive": true,
    "panel": { "perServing": { "<nutrient>": { "value": 0, "unit": "g|mg|kJ|kcal" } }, "per100g": { "..." : {} } },
    "adjudication": { "photoSupports": "...", "notes": ["..."] }
  }
  ```

  The verbatim OCR output is saved unedited to `runs/raw/` before any value is
  written to the catalogue; `structuredEvidence` points at the structured JSON
  transcription (both anchors are validator-required). Values promoted into
  `per100g`/`perServing` carry tier `ocr-label` (directly stated per 100g on the
  photo — no serving-size derivation). Values that stay only in the `ocr.panel`
  layer are evidence, not catalogue data. While the displayed per-100g basis
  differs from the photo panel, the app projection carries `panelDisagreements`
  (verbatim values from both layers) and the detail page shows a visible
  "panel disagreement" note on the affected rows until the founder's basis
  decision.

## Provenance tiers (allowed values)

| Tier | Meaning |
|---|---|
| `exact` | Measured/panel value stated per 100g directly by the source. |
| `label-declared` | Verbatim from the product label/retailer panel (per-serving values, stated serving size, ingredient text). |
| `off-label` | Per-100g value transcribed from the product label by Open Food Facts (crowdsourced secondary source; ODbL, attributed in `nutrition.off`). Stated directly per 100g — no serving-size derivation. |
| `ocr-label` | Value transcribed by our own OCR of a label photo (stage C+). Stated directly on the photo (per 100g or per serving, as printed). Requires the `nutrition.ocr` provenance layer (photo URL, timestamp, verbatim transcription path) — validator-enforced. |
| `estimated-derived` | Arithmetically derived from label-declared values (e.g. per-100g from stated serving). |
| `estimated` | Coarse estimate (position bands, voluntary %s) — labelled as estimate. |
| `regulatory-limit` | Dose context at max permitted levels, flagged additives only. |