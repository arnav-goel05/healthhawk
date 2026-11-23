# HealthHawk

HealthHawk helps Singapore grocery shoppers compare breakfast products by nutrition, unit price, and the evidence behind packaging claims. It was built for the QwenWork × Hashmeta AI One-Person Company Hackathon. The project includes a shopper-facing site and a Founder OS for reviewing evidence, tracking scheduled jobs, and deciding what changes can go live.

**[Open the HealthHawk site](https://healthhawk.geo.hashmeta.tech/)** · **[Compare products](https://healthhawk.geo.hashmeta.tech/compare)** · **[Read the methodology](https://healthhawk.geo.hashmeta.tech/methodology)**

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
