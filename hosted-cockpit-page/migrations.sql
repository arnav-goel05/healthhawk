-- Hosted cockpit schema (issue 02). Idempotent, schema-only, unqualified names.
-- The platform service executes this in the Page-owned tenant schema.
-- NO secrets, NO DML: the token hash is inserted by the orchestrator (D6 primary)
-- or checked into token-hash.txt as the pinned fallback (D6 / R2-3).

CREATE TABLE IF NOT EXISTS cockpit_snapshots (
  id serial PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  data jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS cockpit_auth (
  id int PRIMARY KEY DEFAULT 1,
  token_hash text
);