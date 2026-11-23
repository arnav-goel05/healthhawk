// Server-side HTML render (PRD D7). EVERY snapshot string HTML-escaped.
// Honest Label: paper #F6F0E4, ink #1B1917, teal #0F766E, offline system
// font stack, flat design, thick ink rules. No client JavaScript required.

const STALE_MS = 26 * 60 * 60 * 1000;

export function esc(v) {
  return String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function sgtDate(nowMs) {
  return new Date(nowMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: #F6F0E4; color: #1B1917;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  line-height: 1.45; }
.wrap { max-width: 880px; margin: 0 auto; padding: 20px 16px 48px; }
h1 { font-size: 1.5rem; margin: 0 0 4px; letter-spacing: 0.01em; }
h2 { font-size: 1.05rem; margin: 0 0 10px; text-transform: uppercase; letter-spacing: 0.06em; }
.asof { font-size: 0.85rem; margin: 0 0 16px; border-bottom: 3px solid #1B1917; padding-bottom: 12px; }
.banner { border: 3px solid #1B1917; background: #1B1917; color: #F6F0E4;
  padding: 10px 12px; font-weight: 700; margin: 0 0 12px; }
.note { border: 3px solid #0F766E; color: #0F766E; padding: 8px 12px;
  font-weight: 600; margin: 0 0 12px; }
.badge { display: inline-block; border: 3px solid #0F766E; color: #0F766E;
  padding: 4px 10px; font-weight: 700; margin: 0 0 16px; }
.panel { border: 3px solid #1B1917; padding: 14px; margin: 0 0 16px; background: #F6F0E4; }
.panel h2 { border-bottom: 3px solid #1B1917; padding-bottom: 6px; }
.item { border-top: 2px solid #1B1917; padding: 10px 0; }
.item:first-of-type { border-top: 0; }
.kind { display: inline-block; background: #0F766E; color: #F6F0E4;
  font-size: 0.72rem; font-weight: 700; padding: 2px 8px; text-transform: uppercase;
  letter-spacing: 0.05em; margin-right: 6px; }
.tag { display: inline-block; border: 2px solid #1B1917; font-size: 0.72rem;
  font-weight: 700; padding: 1px 7px; margin-left: 6px; text-transform: uppercase; }
.tag-expired { background: #1B1917; color: #F6F0E4; }
.tag-stale { border-color: #0F766E; color: #0F766E; }
.title { font-weight: 700; }
.why { font-size: 0.9rem; margin: 4px 0; }
.status { font-size: 0.8rem; font-weight: 600; }
.footer-line { border-top: 3px solid #1B1917; margin-top: 12px; padding-top: 8px;
  font-size: 0.85rem; font-weight: 600; color: #0F766E; }
.counts { display: flex; flex-wrap: wrap; gap: 10px 22px; }
.count b { font-size: 1.25rem; display: block; }
.count span { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; }
.stage { border-top: 2px solid #1B1917; padding: 8px 0; }
.stage:first-of-type { border-top: 0; }
.stage .state { font-size: 0.78rem; font-weight: 700; color: #0F766E; text-transform: uppercase; }
.meta { font-size: 0.8rem; margin-top: 8px; }
.revenue { font-weight: 700; font-size: 1.1rem; }
.empty { border: 3px solid #1B1917; padding: 24px 16px; font-weight: 700; }
.chip { display: inline-block; border: 2px solid #1B1917; font-size: 0.72rem;
  font-weight: 700; padding: 1px 7px; margin-left: 6px; text-transform: uppercase;
  letter-spacing: 0.05em; }
.chip-ok { border-color: #0F766E; background: #0F766E; color: #F6F0E4; }
.chip-error { background: #1B1917; color: #F6F0E4; }
.chip-never { color: #1B1917; opacity: 0.6; }
`;

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
${body}
</div>
</body>
</html>
`;
}

function countCell(label, value) {
  // Null contract (PRD rev 2.1): a null count is labelled "unavailable" —
  // never 0, never a fabricated number (D12).
  return `<div class="count"><b>${esc(value === null ? 'unavailable' : value)}</b><span>${esc(label)}</span></div>`;
}

export function renderEmpty() {
  return page('HealthHawk cockpit', `<h1>HealthHawk — founder cockpit</h1>
<p class="asof">sanitized hosted feed</p>
<div class="empty">no data pushed yet</div>
<p class="footer-line">decisions happen in your terminal</p>`);
}

export function renderPage(row, nowMs = Date.now()) {
  const s = row.data;
  const receivedMs = Date.parse(row.receivedAt);
  const dataMs = Date.parse(s.dataAsOf);
  const stale = !Number.isFinite(receivedMs) || !Number.isFinite(dataMs)
    || nowMs - receivedMs > STALE_MS || nowMs - dataMs > STALE_MS;
  const digestNote = s.digestDateSGT !== sgtDate(nowMs);

  const parts = [];
  parts.push(`<h1>HealthHawk — founder cockpit</h1>`);
  parts.push(`<p class="asof">data as of ${esc(s.dataAsOf)} · pushed ${esc(row.receivedAt)} · digest ${esc(s.digestDateSGT)}</p>`);
  if (stale) parts.push(`<div class="banner" role="alert">STALE DATA — the last push or the underlying data is older than 26 hours.</div>`);
  if (digestNote) parts.push(`<div class="note">digest has not rebuilt today</div>`);
  parts.push(s.freeze.frozen
    ? `<div class="badge">FROZEN since ${esc(s.freeze.since)}</div>`
    : `<div class="badge">NOT FROZEN</div>`);

  const items = s.needsYou.map((item) => {
    const expiresMs = item.expiresWhen == null ? NaN : Date.parse(item.expiresWhen);
    const expired = item.status === 'expired' || (Number.isFinite(expiresMs) && expiresMs < nowMs);
    const tags = `${expired ? '<span class="tag tag-expired">expired</span>' : ''}${item.stale === true ? '<span class="tag tag-stale">possibly stale</span>' : ''}`;
    return `<div class="item">
<div><span class="kind">${esc(item.kind)}</span><span class="title">${esc(item.title)}</span>${tags}</div>
<p class="why">${esc(item.why)}</p>
<div class="status">status: ${esc(item.status)}${item.expiresWhen != null ? ` · expires: ${esc(item.expiresWhen)}` : ''}</div>
</div>`;
  }).join('\n');
  parts.push(`<section class="panel"><h2>Needs you</h2>
${items || '<p class="why">queue is empty</p>'}
<p class="footer-line">decisions happen in your terminal</p></section>`);

  // Rev 2.2: Automation panel right after NEEDS YOU. Absent (old snapshots)
  // or empty array → honest empty line, never fabricated jobs (D12).
  const jobs = Array.isArray(s.automation) ? s.automation : [];
  const jobRows = jobs.map((job) => {
    const chip = job.lastStatus === 'ok' ? 'chip-ok'
      : job.lastStatus === 'error' ? 'chip-error' : 'chip-never';
    return `<div class="item">
<div><span class="title">${esc(job.name)}</span><span class="chip ${chip}">${esc(job.lastStatus === 'never-run' ? 'no scheduled run yet' : job.lastStatus)}</span></div>
<div class="status">${esc(job.schedule)}</div>
<p class="why">${esc(job.feeds)}</p>
</div>`;
  }).join('\n');
  parts.push(`<section class="panel"><h2>Automation — the scheduled jobs</h2>
${jobRows || '<p class="why">no job data in this snapshot</p>'}</section>`);

  parts.push(`<section class="panel"><h2>Coverage</h2><div class="counts">
${countCell('rated', s.coverage.rated)}${countCell('total', s.coverage.total)}${countCell('per 100g', s.coverage.per100g)}
</div></section>`);

  parts.push(`<section class="panel"><h2>Funnel (cumulative)</h2><div class="counts">
${countCell('proposed', s.funnel.proposed)}${countCell('guards passed', s.funnel.guardsPassed)}${countCell('consensus', s.funnel.consensus)}${countCell('published', s.funnel.published)}${countCell('overruled', s.funnel.overruled)}${countCell('grey zone', s.funnel.greyZone)}
</div><div class="counts meta">
${countCell('publish', s.funnel.outcomes.publish)}${countCell('unverified', s.funnel.outcomes.unverified)}${countCell('withheld', s.funnel.outcomes.withheld)}${countCell('rejected', s.funnel.outcomes.rejected)}
</div></section>`);

  const stages = s.loop.map((stage) => `<div class="stage">
<b>${esc(stage.name)}</b> <span class="state">${esc(stage.state)}</span>
<div class="why">${esc(stage.label)} · ${esc(stage.value)}</div>
</div>`).join('\n');
  parts.push(`<section class="panel"><h2>Business loop</h2>
${stages}</section>`);

  parts.push(`<section class="panel"><h2>Traffic</h2><div class="counts">
${countCell('views', s.traffic.views)}${countCell('visitors', s.traffic.visitors)}${countCell('sessions', s.traffic.sessions)}
</div><p class="meta">as of ${esc(s.traffic.asOf ?? 'unavailable')} · status: ${esc(s.traffic.status ?? 'unavailable')}</p></section>`);

  parts.push(`<section class="panel"><h2>Forms</h2><div class="counts">
${countCell('submissions', s.forms.count)}
</div></section>`);

  parts.push(`<section class="panel"><h2>Alerts (counts only)</h2><div class="counts">
${countCell('high', s.alerts.high)}${countCell('medium', s.alerts.medium)}${countCell('low', s.alerts.low)}${countCell('info', s.alerts.info)}
</div></section>`);

  parts.push(`<section class="panel"><h2>Revenue</h2><p class="revenue">${esc(s.revenue.status)}</p></section>`);

  return page('HealthHawk cockpit', parts.join('\n'));
}