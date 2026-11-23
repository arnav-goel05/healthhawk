# HealthHawk

HealthHawk helps Singapore grocery shoppers compare breakfast products by nutrition, unit price, and the evidence behind packaging claims. It was built for the QwenWork × Hashmeta AI One-Person Company Hackathon. The project includes a shopper-facing site and a Founder OS for reviewing evidence, tracking scheduled jobs, and deciding what changes can go live.

**[Open the HealthHawk site](https://healthhawk.geo.hashmeta.tech/)** · **[Compare products](https://healthhawk.geo.hashmeta.tech/compare)** · **[Read the methodology](https://healthhawk.geo.hashmeta.tech/methodology)**

## Find the code shown in the demo

Paths start at the root of this GitHub repository. Click a path to open the file, or press **t** on the repository page and paste the path into GitHub’s file finder.

| Demo feature | What to open | Path from repository root |
| --- | --- | --- |
| Daily cron jobs | Price refresh | [`scripts/12-fetch-prices.mjs`](scripts/12-fetch-prices.mjs) |
|  | Publish sync | [`scripts/12-sync.mjs`](scripts/12-sync.mjs) |
|  | Blog knowledge sync | [`scripts/p3-blog-knowledge.mjs`](scripts/p3-blog-knowledge.mjs) |
|  | Founder digest | [`scripts/p2-digest.mjs`](scripts/p2-digest.mjs) |
| Weekly cron jobs | Basket report | [`scripts/12-basket.mjs`](scripts/12-basket.mjs) |
|  | Market scout brief | [`scripts/p2-scout-brief.mjs`](scripts/p2-scout-brief.mjs) |
|  | Monday rollup and decision queue | [`scripts/founder-queue.mjs`](scripts/founder-queue.mjs) |
| Skills | Write scopes for the 13 roles | [`scripts/p2-skill-scope.mjs`](scripts/p2-skill-scope.mjs) |
|  | Product classification | [`scripts/4-classify.mjs`](scripts/4-classify.mjs) |
|  | Scoring rules | [`scripts/score.mjs`](scripts/score.mjs) |
|  | Packaging claim checks | [`scripts/7a-claim-rules.mjs`](scripts/7a-claim-rules.mjs) |
| Founder dashboard · QwenWork Pages | Page renderer shown in the demo | [`hosted-cockpit-page/render.mjs`](hosted-cockpit-page/render.mjs) |
|  | Web server | [`hosted-cockpit-page/server.mjs`](hosted-cockpit-page/server.mjs) |
|  | Snapshot sanitizer | [`scripts/hosted-cockpit/sanitize.mjs`](scripts/hosted-cockpit/sanitize.mjs) |
| Shopper site · Hashmeta AI | Homepage | [`runs/p3-06/homepage-block.html`](runs/p3-06/homepage-block.html) |
|  | Product comparison | [`app/index.html`](app/index.html) |
|  | Methodology page | [`runs/p4-04/methodology-new.html`](runs/p4-04/methodology-new.html) |
|  | Product listing template | [`templates/collection-list.html`](templates/collection-list.html) |
|  | Product detail template | [`templates/collection-detail.html`](templates/collection-detail.html) |

[Open the founder dashboard](https://ne8hlevd.qwenwork.page/) · [Open the shopper site](https://healthhawk.geo.hashmeta.tech/)

**Operator checkout only.** These paths start at the root of the full HealthHawk operator repository and are outside the public GitHub snapshot.

| What to open | Path in the operator repository |
| --- | --- |
| Index of all 13 skills and their instruction-file paths | `skills-manifest.json` |
| Example skill instructions | `skills/healthhawk-orchestrator/SKILL.md` |
| Saved QwenWork schedule readback | `runs/merge-fos/live-crons-post-repoint-20261123.json` |
| Weekly Open Food Facts re-enrichment | `scripts/p2-reenrich.mjs` |
| Blog drafting instructions | `skills/healthhawk-content/SKILL.md` |

## What shoppers can do

- Search and compare products within a comparable range, such as plain oats or granola. Switch among **Best value**, **Balanced**, and **Healthiest**. The Best value preset excludes D and E grades by default.
- See FairPrice offers in Singapore dollars with a unit price and a check date. Open a product to inspect ingredients, key nutrition figures, and available dietary or allergen evidence.
- Open a claim check to see the packaging claim, the label evidence, the rule applied, and any gap in the evidence. Products with incomplete or unapproved grading evidence show **Not yet rated**.
- Read how HealthHawk interprets labels, assigns grades, and evaluates claims. The P4 update replaces dense explanations with short summaries and expandable proof boxes across the homepage, compare app, and methodology page.

## How the system works

| Step | Implementation |
| --- | --- |
| Collect and verify | Product records are keyed by barcode where available. Retailer offers, product-label evidence, and Open Food Facts enrichment keep their source, date, and provenance. Missing or disputed data is carried forward explicitly. |
| Classify and score | JavaScript rules group like products and apply the relevant nutrition algorithm. The ranking combines health and price within a range. Filtering uses the precomputed ordering, so removing a result does not change the remaining products' scores. |
| Review and publish | The pipeline separates proposed findings from approved changes. The compare builder creates a static shopper projection, and Hashmeta hosts the site and collection pages. The P4 release changes the presentation layer and keeps the catalogue data frozen. |
| Operate | QwenWork jobs support price refresh, enrichment, research, and reporting. Founder OS derives an inbox and operating summaries from local state. An ingest service renders a separate hosted cockpit from a validated, sanitized snapshot. |

## Run locally

Use **Node.js 22 or newer**. The static compare app and the included tests require no npm install. From the repository root, serve the static assets and open the local URL printed by the server.

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory app
# Open http://localhost:8000/
```

You can also open [app/index.html](app/index.html) directly. The checked-in data is a historical snapshot, so prices and availability may have changed. Some product photos and source links use the network. The standalone preview covers the compare experience. The homepage and methodology HTML blocks are designed for the Hashmeta site shell.

In the configured operator workspace, run `node scripts/founder.mjs status` to derive the founder inbox and report where its evidence came from. The command expects the workspace's review inputs and writes a derived queue.

Run these offline checks from a Git checkout. They cover the P4 compare and methodology UI plus the hosted cockpit. The cockpit HTTP tests use an in-memory database and cover authentication, validation, rendering, and snapshot retention.

```sh
node --test tests/p4-0{2,3,4}-*.test.mjs tests/hosted-{page,push}.test.mjs
```

See [hosted-cockpit-page/README.md](hosted-cockpit-page/README.md) for the database schema, environment settings, and endpoints. Live publishing and scheduled jobs require separately configured platform accounts and operator state.

## Repository structure

| Path | Purpose |
| --- | --- |
| [`app/`](app/) | Standalone compare app, public product projection, search library, styling, and credited pack images |
| [`scripts/`](scripts/) | Deterministic scoring, claim rules, projection logic, and Founder OS commands |
| [`hosted-cockpit-page/`](hosted-cockpit-page/) | Node server, snapshot contract, HTML renderer, and database schema for the hosted cockpit |
| [`templates/`](templates/) | Hashmeta collection page templates |
| [`runs/p3-06/homepage-block.html`](runs/p3-06/homepage-block.html) | P4 homepage content block |
| [`runs/p4-04/methodology-new.html`](runs/p4-04/methodology-new.html) | P4 methodology content block |
| [`tests/`](tests/) | Node tests for offline behavior and cockpit HTTP integration |

The public GitHub repository is a source snapshot. It includes the published compare data projection and a runnable test subset. The local working repository also holds the full collector inputs, private founder dashboard state, approval queues, scheduler configuration, and platform run logs. Those inputs are required to reproduce the full production workflow and local integration suite.

## Data and attribution

Hawk Grade uses the Nutri-Score 2023 general-food algorithm from Santé publique France for supported foods. The grading and evidence are for within-category comparison and general information. For allergies or other dietary needs, check the package you are buying.

Open Food Facts database contributions are attributed under [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Pack images retain their source and uploader credit in the [media manifest](app/media-manifest.json) and are credited under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). Images may show packaging for a different market. Fuse.js is vendored under [Apache-2.0](app/fuse.LICENSE.txt). Retailer and product names identify the original sources.
