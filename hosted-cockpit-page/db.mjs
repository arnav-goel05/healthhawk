// Supabase-compatible REST client over fetch (Node built-ins only, PRD D2).
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_INSTANCE_ID.
// Tables live in the tenant schema `tenant_${SUPABASE_INSTANCE_ID}_schema`.
// Dual-mode: try plain (unqualified) first; on schema-not-found errors
// (404 / PGRST205 / PGRST106 / schema-cache messages) retry with
// Accept-Profile/Content-Profile headers and stay in profile mode.
//
// Injectable seam interface (tests inject a fake with REAL ordering +
// delete semantics):
//   insertSnapshot(data) -> { receivedAt }
//   latestSnapshot()     -> { receivedAt, data } | null
//   pruneSnapshots(keep) -> deletes all but the latest `keep` rows
//   getTokenHash()       -> string | null

export function createDb({ url, anonKey, instanceId, fetchImpl = fetch } = {}) {
  const base = String(url ?? '').replace(/\/+$/, '');
  const profile = instanceId ? `tenant_${instanceId}_schema` : null;
  let useProfile = false;

  function isSchemaMiss(status, text) {
    return status === 404 || /PGRST205|PGRST106|schema cache|Could not find the table/i.test(text);
  }

  async function call(path, { method = 'GET', body, prefer } = {}) {
    if (!base || !anonKey) throw new Error('db not configured');
    const headers = {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers.Prefer = prefer;
    const doFetch = (withProfile) => {
      const h = { ...headers };
      if (withProfile && profile) {
        h['Accept-Profile'] = profile;
        h['Content-Profile'] = profile;
      }
      return fetchImpl(`${base}/rest/v1/${path}`, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    };
    let res = await doFetch(useProfile);
    let text = await res.text();
    if (!useProfile && profile && isSchemaMiss(res.status, text)) {
      useProfile = true;
      res = await doFetch(true);
      text = await res.text();
    }
    if (!res.ok) throw new Error(`db request failed (${res.status})`);
    return text ? JSON.parse(text) : null;
  }

  return {
    async insertSnapshot(data) {
      const rows = await call('cockpit_snapshots', {
        method: 'POST',
        body: { data },
        prefer: 'return=representation',
      });
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (!row || !row.received_at) throw new Error('db insert returned no row');
      return { receivedAt: row.received_at };
    },

    async latestSnapshot() {
      const rows = await call('cockpit_snapshots?select=id,received_at,data&order=received_at.desc,id.desc&limit=1');
      if (!Array.isArray(rows) || rows.length === 0) return null;
      return { receivedAt: rows[0].received_at, data: rows[0].data };
    },

    async pruneSnapshots(keep) {
      const rows = await call(`cockpit_snapshots?select=id&order=received_at.desc,id.desc&offset=${Number(keep)}`);
      if (!Array.isArray(rows) || rows.length === 0) return;
      const ids = rows.map((r) => r.id).join(',');
      await call(`cockpit_snapshots?id=in.(${ids})`, { method: 'DELETE' });
    },

    async getTokenHash() {
      const rows = await call('cockpit_auth?select=token_hash&id=eq.1&limit=1');
      if (!Array.isArray(rows) || rows.length === 0) return null;
      return rows[0].token_hash ?? null;
    },
  };
}