# hosted-cockpit-page

Self-contained dynamic QW Page: token-protected ingest API + server-rendered
sanitized founder cockpit. Node 22+ built-ins only (`http`, `crypto`, `fetch`),
zero npm dependencies. Never edit from a cron; published once from the owning
chat (PRD D1/D9).

## Run

```sh
node server.mjs            # listens on process.env.PORT (default 8081), process.env.HOST (default 0.0.0.0)
```

Env (injected by the platform after the database is provisioned):

| var | purpose |
| --- | --- |
| `PORT` / `HOST` | listen address (default 8081 / 0.0.0.0) |
| `SUPABASE_URL` | REST base; client calls `${SUPABASE_URL}/rest/v1/<table>` |
| `SUPABASE_ANON_KEY` | sent as `apikey` + `Authorization: Bearer` headers |
| `SUPABASE_INSTANCE_ID` | tenant schema `tenant_${id}_schema` for profile-header retry |

`db.mjs` tries plain unqualified-table requests first; on schema-not-found
(404 / PGRST205 / PGRST106 / schema-cache errors) it retries with
`Accept-Profile` / `Content-Profile` set to the tenant schema and stays in
that mode.

## Endpoints

- `POST /api/ingest` — `Authorization: Bearer <token>`. Body cap 256 KB →
  JSON parse → sha256(token) compared to the stored hash with
  `crypto.timingSafeEqual` on fixed-length 32-byte digests → strict per-field
  validation (`hosted-cockpit-snapshot/1`, strings ≤500, arrays ≤100, counts
  non-negative integers, exact key sets) → self-contained fail-closed content
  guard (`guard.mjs`, PRD D4 semantics). Missing/wrong token → 401 with empty
  body. Any invalid body → 400, NOTHING inserted or overwritten. Valid →
  insert + prune to latest 14 → `200 {ok:true, receivedAt}`.
- `GET /api/snapshot` — latest sanitized snapshot JSON (public); 404 when empty.
- `GET /` — server-rendered Honest Label cockpit (no client JS). Data-as-of
  header, staleness banner when `now − receivedAt > 26h` OR
  `now − dataAsOf > 26h`, "digest has not rebuilt today" note when
  `digestDateSGT ≠ today SGT` (UTC+8), honest empty state. Every string
  HTML-escaped. Revenue status rendered verbatim from the snapshot.

No response ever contains the token hash or env values.

## Token hash precedence (D6 / R2-3)

1. DB auth row: `cockpit_auth` single row `id=1`, column `token_hash`
   (sha256 hex of the 32-random-byte token; inserted by the orchestrator via
   idempotent DML — never checked in here).
2. Fallback: `token-hash.txt` in this directory (sha256 hex only, one line).
   Ships ABSENT by default; the orchestrator creates it only if the migration
   tool rejects DML. The token itself never enters the repo.

If neither source yields a valid 64-hex hash, ingest fails closed (401).

## db seam

`createServer({ db, configDir, now })` accepts an injected db implementing:

```
insertSnapshot(data) -> { receivedAt }
latestSnapshot()     -> { receivedAt, data } | null
pruneSnapshots(keep) -> delete all but the latest `keep` (received_at desc, id desc)
getTokenHash()       -> string | null
```

Tests inject a fake with REAL ordering + delete semantics over real HTTP on
ephemeral ports; `configDir` lets tests exercise the fallback file without
creating one in this directory. `now` is an injectable millisecond clock for
deterministic staleness fixtures.

## migrations.sql

Idempotent, schema-only, unqualified names (`cockpit_snapshots`,
`cockpit_auth`). No secrets, no DML.

## Local demo (no platform)

```sh
node --test ../tests/hosted-page.test.mjs   # exercises everything with a fake db
```

Or run `node server.mjs` against any PostgREST-compatible endpoint via the
env vars above, then POST a `hosted-cockpit-snapshot/1` fixture with the
Bearer token and open `/`.