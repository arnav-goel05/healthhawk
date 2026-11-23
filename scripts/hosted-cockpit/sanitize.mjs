// Hosted Cockpit issue 01 — pure fail-closed sanitizer (PRD D3/D4).
// aggregate (p2-18-digest/1) → hosted-cockpit-snapshot/1. ZERO imports, zero
// writes, zero network, zero deps. Purity is a security property (D4/F18).
// Guard scans OUTPUT only; commands/ids/sources are removed by the mapping
// (F1: removal, not allowlist). Regex guards catch plaintext accidents, not
// determined encoding — the structural counts-only mapping is the primary
// defense (F19). assertSafe is the shared contract for the page-side copy
// (issue 03 drift test): keep the signature stable.
// Null contract (PRD rev 2.1, fix round 1 B1/A1): ONLY traffic counts/asOf/
// status (when traffic.status is not "ok") and forms.count may be null;
// freeze, coverage, funnel and all other mapped fields are mandatory —
// missing → throw here (fail-closed), never a null the page would reject.

const SCHEMA = 'hosted-cockpit-snapshot/1';

// Rev 2.2: static editorial linkage map (name substring → founder-facing line).
// Defined once, exported for tests. Matched case-insensitively, first hit wins.
export const AUTOMATION_FEEDS = [
  ['price refresh', 'Keeps prices fresh (paused under freeze)'],
  ['knowledge sync', 'Feeds the blog writer facts'],
  ['founder digest', 'Rebuilds this cockpit data'],
  ['hosted-cockpit push', 'Updates this page'],
  ['re-enrichment', 'Fills coverage gaps weekly'],
  ['blog draft', 'Queues your blog approval'],
  ['market-scout', 'Queues your aisle pick'],
  ['healthiest-basket', 'Weekly best-value basket'],
  ['founder report', 'Your Monday report'],
];

function feedsFor(name) {
  const lower = name.toLowerCase();
  for (const [needle, line] of AUTOMATION_FEEDS) {
    if (lower.includes(needle)) return line;
  }
  return 'Scheduled automation';
}

// Rev 2.2: human schedule text. Accepts the committed string form
// "M H * * * Asia/Singapore" and the object form {kind,expr,tz}.
// Only daily / Mon / Sun patterns are humanized; anything else keeps the
// raw expr (honest fallback, never a guessed cadence). SGT abbreviation is
// rendered ONLY for Asia/Singapore; any other tz is shown raw.
function scheduleText(schedule) {
  let expr = '';
  let tz = '';
  if (typeof schedule === 'string') {
    const parts = schedule.trim().split(/\s+/);
    expr = parts.slice(0, 5).join(' ');
    tz = parts.slice(5).join(' ');
  } else if (schedule !== null && typeof schedule === 'object' && !Array.isArray(schedule)) {
    if (typeof schedule.expr === 'string') expr = schedule.expr.trim().replace(/\s+/g, ' ');
    if (typeof schedule.tz === 'string') tz = schedule.tz;
  }
  const tzLabel = tz === 'Asia/Singapore' ? 'SGT' : tz;
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|0|1)$/.exec(expr);
  if (m) {
    const minute = Number(m[1]);
    const hour = Number(m[2]);
    if (minute <= 59 && hour <= 23) {
      const hh = String(hour).padStart(2, '0');
      const mm = String(minute).padStart(2, '0');
      const day = m[3] === '*' ? 'daily' : m[3] === '1' ? 'Mon' : 'Sun';
      return tzLabel ? `${day} ${hh}:${mm} ${tzLabel}` : `${day} ${hh}:${mm}`;
    }
  }
  return expr === '' ? 'schedule unavailable' : expr;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
const PATH_FRAGMENTS = ['/users/', 'runs/', 'pending/', 'scripts/', '.json']; // lowercase; matched case-insensitively

function checkText(text, where) {
  if (EMAIL_RE.test(text)) {
    throw new Error(`hosted snapshot guard: email-like text at ${where}`);
  }
  const lower = text.toLowerCase();
  for (const fragment of PATH_FRAGMENTS) {
    if (lower.includes(fragment)) {
      throw new Error(`hosted snapshot guard: internal path fragment at ${where}`);
    }
  }
  if (UUID_RE.test(text)) {
    throw new Error(`hosted snapshot guard: UUID-like id at ${where}`);
  }
}

export function assertSafe(value) {
  const seen = new WeakSet();
  const walk = (node, where) => {
    if (typeof node === 'string') {
      checkText(node, where);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) walk(node[i], `${where}[${i}]`);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      checkText(key, `${where}.<key>`);
      walk(child, `${where}.${key}`);
    }
  };
  walk(value, '$');
  return true;
}

export function sanitize(aggregate) {
  const required = (value, label) => {
    if (value === null || value === undefined) {
      throw new Error(`hosted sanitize: ${label} missing (fail-closed)`);
    }
    return value;
  };
  if (aggregate === null || typeof aggregate !== 'object' || Array.isArray(aggregate)) {
    throw new Error('hosted sanitize: aggregate unreadable (not an object)');
  }
  if (typeof aggregate.schema !== 'string' || aggregate.schema.length === 0) {
    throw new Error('hosted sanitize: aggregate schema identity missing');
  }
  const freeze = aggregate.agents?.freeze;
  if (freeze === null || typeof freeze !== 'object' || Array.isArray(freeze)
    || typeof freeze.frozen !== 'boolean') {
    throw new Error('hosted sanitize: agents.freeze missing or unreadable (fail-closed)');
  }
  if (freeze.frozen && (typeof freeze.frozenAt !== 'string' || freeze.frozenAt.length === 0)) {
    throw new Error('hosted sanitize: frozen but frozenAt unreadable (fail-closed)');
  }

  const cumulative = aggregate.funnel?.cumulative ?? {};
  const outcomes = cumulative.outcomes ?? {};
  const totals = aggregate.traffic?.totals ?? {};
  const queueItems = Array.isArray(aggregate.founderQueue?.items) ? aggregate.founderQueue.items : [];
  const stages = Array.isArray(aggregate.loop?.stages) ? aggregate.loop.stages : [];
  const alertItems = Array.isArray(aggregate.alerts?.items) ? aggregate.alerts.items : [];
  const cronItems = Array.isArray(aggregate.alerts?.crons) ? aggregate.alerts.crons : [];

  const alertCounts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const item of alertItems) {
    if (item !== null && typeof item === 'object' && Object.hasOwn(alertCounts, item.severity)) {
      alertCounts[item.severity] += 1;
    }
  }

  const snapshot = {
    schema: SCHEMA,
    dataAsOf: required(aggregate.generatedAt, 'generatedAt'),
    digestDateSGT: required(aggregate.digestDateSGT, 'digestDateSGT'),
    freeze: { frozen: freeze.frozen, since: freeze.frozen ? freeze.frozenAt : null },
    coverage: {
      rated: required(aggregate.coverage?.rated, 'coverage.rated'),
      total: required(aggregate.coverage?.total, 'coverage.total'),
      per100g: required(aggregate.coverage?.per100g, 'coverage.per100g'),
    },
    funnel: {
      proposed: required(cumulative.proposed, 'funnel.cumulative.proposed'),
      guardsPassed: required(cumulative.guardsPassed, 'funnel.cumulative.guardsPassed'),
      consensus: required(cumulative.consensus, 'funnel.cumulative.consensus'),
      published: required(cumulative.published, 'funnel.cumulative.published'),
      overruled: required(cumulative.overruled, 'funnel.cumulative.overruled'),
      greyZone: required(cumulative.greyZone, 'funnel.cumulative.greyZone'),
      outcomes: {
        publish: required(outcomes.publish, 'funnel.cumulative.outcomes.publish'),
        unverified: required(outcomes.unverified, 'funnel.cumulative.outcomes.unverified'),
        withheld: required(outcomes.withheld, 'funnel.cumulative.outcomes.withheld'),
        rejected: required(outcomes.rejected, 'funnel.cumulative.outcomes.rejected'),
      },
    },
    needsYou: queueItems.map((item) => ({
      kind: required(item?.kind, 'founderQueue item kind'),
      title: required(item?.title, 'founderQueue item title'),
      why: required(item?.why, 'founderQueue item why'),
      status: required(item?.status, 'founderQueue item status'),
      expiresWhen: item?.expiresWhen ?? null,
      stale: item?.stale ?? false,
    })),
    loop: stages.map((stage) => ({
      id: required(stage?.id, 'loop stage id'),
      name: required(stage?.name, 'loop stage name'),
      state: required(stage?.state, 'loop stage state'),
      label: required(stage?.label, 'loop stage label'),
      value: required(stage?.value, 'loop stage value'),
    })),
    traffic: {
      views: totals.views ?? null,
      visitors: totals.visitors ?? null,
      sessions: totals.sessions ?? null,
      asOf: aggregate.traffic?.fetchedAt ?? null,
      status: aggregate.traffic?.status ?? null,
    },
    forms: { count: aggregate.weekly?.forms?.count ?? null },
    alerts: alertCounts,
    // Rev 2.2: optional Automation panel data. ONLY name/schedule/lastStatus/
    // feeds — cron ids (UUIDs), statusSource paths, nextRunAt and asOf are
    // removed by the mapping (F1). Absent/empty crons → honest [].
    automation: cronItems.map((job) => {
      const name = required(job?.name, 'alerts.crons item name');
      return {
        name,
        schedule: scheduleText(job?.schedule),
        lastStatus: job?.lastRunStatus === 'ok' || job?.lastRunStatus === 'error'
          ? job.lastRunStatus : 'never-run',
        feeds: feedsFor(name),
      };
    }),
    revenue: { status: required(aggregate.revenueReadiness?.status, 'revenueReadiness.status') },
  };

  assertSafe(snapshot);
  return snapshot;
}