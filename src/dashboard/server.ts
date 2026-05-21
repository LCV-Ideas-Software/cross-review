#!/usr/bin/env node
import http from "node:http";
import { loadConfig, VERSION } from "../core/config.js";
import { CrossReviewOrchestrator } from "../core/orchestrator.js";
import { sessionReportMarkdown } from "../core/reports.js";
import { EventLog } from "../observability/logger.js";

const config = loadConfig();
const eventLog = new EventLog(config);
const holder: { orchestrator?: CrossReviewOrchestrator } = {};
const orchestrator = new CrossReviewOrchestrator(config, (event) => {
  eventLog.emit(event);
  // Fire-and-forget: appendEvent is async (v4.1.0 proper-lockfile lock)
  // but the emit pipeline must stay sync — callers that need synchronous
  // persistence guarantees should await appendEvent directly. Unhandled
  // rejections are swallowed inside appendEvent.
  void holder.orchestrator?.store.appendEvent(event);
});
holder.orchestrator = orchestrator;

function sendJson(response: http.ServerResponse, value: unknown): void {
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value, null, 2));
}

function sendHtml(response: http.ServerResponse, html: string): void {
  // v2.4.0 / audit closure: Content-Security-Policy + X-Frame-Options.
  // The dashboard binds only to 127.0.0.1 (defense via network), but
  // local processes can still load it. The CSP confines the page to
  // its own origin (no third-party scripts/styles, no remote fetch),
  // which blocks click-bait DOM injection if a future change accepts
  // unsanitized input. `unsafe-inline` is required because the page
  // ships an inline <style> + <script> by design; the style-src/script-src
  // directives still block REMOTE inline injection. Anti-clickjacking
  // headers complement the CSP for in-frame embedding attempts.
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(html);
}

function notFound(response: http.ServerResponse): void {
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
}

function html(): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cross Review</title>
  <style>
    :root { color-scheme: light; font-family: Inter, Segoe UI, Arial, sans-serif; color: #102033; background: #f6f8fb; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    main { max-width: 1180px; margin: 0 auto; padding: 32px; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
    h1 { margin: 0; font-size: 28px; }
    h2 { margin: 0 0 10px; font-size: 18px; }
    .muted { color: #52647b; }
    .badge { border: 1px solid #cbd7e8; border-radius: 999px; padding: 6px 12px; background: white; font-weight: 700; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
    .card, .session { background: white; border: 1px solid #d8e1ee; border-radius: 8px; padding: 16px; box-shadow: 0 8px 20px rgb(16 32 51 / 0.05); }
    .metric strong { display: block; font-size: 24px; margin-top: 6px; }
    .toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 20px 0 14px; }
    input, select, button { min-height: 38px; border-radius: 8px; border: 1px solid #cbd7e8; padding: 0 12px; font: inherit; }
    input { flex: 1 1 260px; }
    button { font-weight: 800; color: white; background: #1f6feb; cursor: pointer; border: 0; }
    button.secondary { color: #102033; background: #eef3f9; border: 1px solid #cbd7e8; }
    button:hover { transform: translateY(-1px); }
    .sessions { display: grid; gap: 12px; margin-top: 12px; }
    .session { cursor: pointer; }
    .session:hover { border-color: #1f6feb; }
    .session strong { display: block; margin-bottom: 6px; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; color: #52647b; font-size: 14px; }
    .detail-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 0.8fr); gap: 14px; margin-top: 18px; }
    pre, .timeline { max-height: 520px; overflow: auto; white-space: pre-wrap; background: #0f172a; color: #e5e7eb; border-radius: 8px; padding: 16px; }
    .timeline { background: white; color: #102033; border: 1px solid #d8e1ee; }
    .event { border-left: 3px solid #1f6feb; padding: 8px 0 8px 10px; margin: 0 0 8px; }
    .event small { color: #52647b; display: block; }
    table.peer-health { width: 100%; border-collapse: collapse; font-size: 14px; }
    table.peer-health th, table.peer-health td { border-bottom: 1px solid #e5ecf5; padding: 8px 10px; text-align: left; }
    table.peer-health th { font-weight: 700; color: #52647b; background: #f6f8fb; }
    table.peer-health td.num { text-align: right; font-variant-numeric: tabular-nums; }
    table.peer-health td.peer { font-weight: 700; }
    @media (max-width: 820px) { main { padding: 20px; } header, .detail-grid { display: block; } .badge { display: inline-block; margin-top: 10px; } table.peer-health { font-size: 12px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Cross Review</h1>
        <div class="muted">APIs oficiais, sessões duráveis, unanimidade obrigatória</div>
      </div>
      <div class="badge">v${VERSION}</div>
    </header>
    <section class="grid" id="metrics">
      <article class="card metric"><span>Sessões</span><strong>...</strong></article>
      <article class="card metric"><span>Convergidas</span><strong>...</strong></article>
      <article class="card metric"><span>Rodadas</span><strong>...</strong></article>
      <article class="card metric"><span>Custo</span><strong>...</strong></article>
    </section>
    <section class="card" id="peer-health" style="margin-top:14px">
      <h2>Saúde por provider</h2>
      <div class="muted" style="margin-bottom:8px">READY rate, NEEDS_EVIDENCE rate, custo médio e parser warnings por peer (todas as sessões salvas).</div>
      <div id="peer-health-body" class="muted">Carregando...</div>
    </section>
    <section class="card" id="shadow-judgment" style="margin-top:14px">
      <h2>Judge shadow (decisões observadas)</h2>
      <div class="muted" style="margin-bottom:8px">Decisões emitidas pelo judge em modo shadow agregadas por peer julgador. Não muta estado — observabilidade pré v2.13.</div>
      <div id="shadow-judgment-body" class="muted">Carregando...</div>
    </section>
    <section class="grid" style="margin-top:14px">
      <article class="card"><strong>Dados</strong><p class="muted">${config.data_dir}</p></article>
      <article class="card"><strong>Logs</strong><p class="muted">${eventLog.path()}</p></article>
    </section>
    <div class="toolbar">
      <input id="filter" placeholder="Filtrar por sessão, estado ou texto..." />
      <select id="state">
        <option value="">Todos os estados</option>
        <option value="running">Em execução</option>
        <option value="converged">Convergidas</option>
        <option value="blocked">Bloqueadas</option>
        <option value="stale">Interrompidas</option>
      </select>
      <button id="refresh">Atualizar</button>
      <button id="report" class="secondary" disabled>Relatório</button>
    </div>
    <section id="sessions" class="sessions">Carregando...</section>
    <section class="detail-grid">
      <pre id="details">Selecione uma sessão para ver detalhes.</pre>
      <div class="timeline" id="timeline">A timeline aparecerá aqui.</div>
    </section>
  </main>
  <script>
    var selectedSession = null;
    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    }
    function money(value) {
      return value == null ? 'desconhecido' : '$' + Number(value).toFixed(6);
    }
    function stateOf(session) {
      return session.outcome || session.convergence_health?.state || 'em andamento';
    }
    function pct(value) {
      if (value == null || !Number.isFinite(value)) return '—';
      return (value * 100).toFixed(1) + '%';
    }
    function renderShadowJudgment(rollup) {
      if (!rollup || !rollup.decisions_total) {
        return '<div class="muted">Nenhuma decisão shadow observada. Ative o judge shadow setando CROSS_REVIEW_EVIDENCE_JUDGE_AUTOWIRE_MODE=shadow + _PEER=codex.</div>';
      }
      const peers = Object.values(rollup.by_judge_peer || {}).filter(Boolean).sort((a, b) => b.decisions_total - a.decisions_total);
      const head = '<thead><tr>' +
        ['Judge peer','Decisões','Would promote','Skip (sat. unverified)','Skip (not satisfied)','Verified','Inferred','Unknown','Primeira','Última']
          .map(h => '<th>' + h + '</th>').join('') + '</tr></thead>';
      const body = '<tbody>' + peers.map(p => {
        const conf = p.by_confidence || {};
        const promoteRate = p.decisions_total ? (p.would_promote / p.decisions_total) : 0;
        return '<tr>' +
          '<td class="peer">' + escapeHtml(p.judge_peer) + '</td>' +
          '<td class="num">' + p.decisions_total + '</td>' +
          '<td class="num">' + p.would_promote + ' (' + pct(promoteRate) + ')</td>' +
          '<td class="num">' + p.would_skip_satisfied_unverified + '</td>' +
          '<td class="num">' + p.would_skip_not_satisfied + '</td>' +
          '<td class="num">' + (conf.verified || 0) + '</td>' +
          '<td class="num">' + (conf.inferred || 0) + '</td>' +
          '<td class="num">' + (conf.unknown || 0) + '</td>' +
          '<td class="num">' + escapeHtml(p.first_seen_at || '—') + '</td>' +
          '<td class="num">' + escapeHtml(p.last_seen_at || '—') + '</td>' +
          '</tr>';
      }).join('') + '</tbody>';
      const summary = '<p class="muted" style="margin:0 0 8px">Total: <strong>' + rollup.decisions_total + '</strong> decisão(ões) — ' +
        rollup.would_promote_total + ' would_promote (' + pct(rollup.decisions_total ? rollup.would_promote_total / rollup.decisions_total : 0) + ')</p>';
      return summary + '<table class="peer-health">' + head + body + '</table>';
    }
    function renderPeerHealth(perPeer) {
      const peers = Object.values(perPeer || {}).filter(Boolean).sort((a, b) => b.results_total - a.results_total);
      if (!peers.length) return '<div class="muted">Nenhum resultado de peer registrado ainda.</div>';
      const head = '<thead><tr>' +
        ['Peer','Resultados','READY','NEEDS_EVIDENCE','NOT_READY','READY rate','NE rate','Custo total','Custo médio','Parser warns','Rejections']
          .map(h => '<th>' + h + '</th>').join('') + '</tr></thead>';
      const body = '<tbody>' + peers.map(p =>
        '<tr>' +
        '<td class="peer">' + escapeHtml(p.peer) + '</td>' +
        '<td class="num">' + p.results_total + '</td>' +
        '<td class="num">' + p.ready_count + '</td>' +
        '<td class="num">' + p.needs_evidence_count + '</td>' +
        '<td class="num">' + p.not_ready_count + '</td>' +
        '<td class="num">' + pct(p.ready_rate) + '</td>' +
        '<td class="num">' + pct(p.needs_evidence_rate) + '</td>' +
        '<td class="num">' + (p.total_cost_usd == null ? '—' : '$' + p.total_cost_usd.toFixed(4)) + '</td>' +
        '<td class="num">' + (p.avg_cost_usd == null ? '—' : '$' + p.avg_cost_usd.toFixed(6)) + '</td>' +
        '<td class="num">' + p.parser_warnings_total + '</td>' +
        '<td class="num">' + p.rejected_total + '</td>' +
        '</tr>'
      ).join('') + '</tbody>';
      return '<table class="peer-health">' + head + body + '</table>';
    }
    async function refreshMetrics() {
      const metrics = await fetch('/api/metrics').then(r => r.json());
      document.getElementById('metrics').innerHTML = [
        ['Sessões', metrics.sessions.total],
        ['Convergidas', metrics.sessions.converged],
        ['Rodadas', metrics.rounds],
        ['Custo', money(metrics.total_cost.total_cost)],
      ].map(([label, value]) => \`<article class="card metric"><span>\${label}</span><strong>\${value}</strong></article>\`).join('');
      document.getElementById('peer-health-body').innerHTML = renderPeerHealth(metrics.per_peer_health);
      document.getElementById('shadow-judgment-body').innerHTML = renderShadowJudgment(metrics.shadow_judgment);
    }
    async function refresh() {
      await refreshMetrics();
      const data = await fetch('/api/sessions').then(r => r.json());
      const filter = document.getElementById('filter').value.toLowerCase();
      const wanted = document.getElementById('state').value;
      const visible = data.filter(session => {
        const state = stateOf(session);
        const haystack = JSON.stringify({ id: session.session_id, state, health: session.convergence_health }).toLowerCase();
        return (!wanted || state === wanted || session.convergence_health?.state === wanted) && (!filter || haystack.includes(filter));
      });
      const container = document.getElementById('sessions');
      if (!visible.length) {
        container.textContent = 'Nenhuma sessão encontrada.';
        return;
      }
      container.innerHTML = visible.map(session => {
        const health = session.convergence_health || {};
        const cost = session.totals?.cost?.total_cost;
        return \`<article class="session" data-session="\${session.session_id}">
          <strong>\${escapeHtml(session.session_id)}</strong>
          <div class="row">
            <span>estado: \${escapeHtml(stateOf(session))}</span>
            <span>rodadas: \${session.rounds?.length || 0}</span>
            <span>custo: \${money(cost)}</span>
            <span>atualizada: \${escapeHtml(session.updated_at)}</span>
          </div>
          <div class="muted">\${escapeHtml(health.detail || '')}</div>
        </article>\`;
      }).join('');
      for (const node of container.querySelectorAll('.session')) {
        node.addEventListener('click', async () => selectSession(node.dataset.session));
      }
    }
    async function selectSession(id) {
      selectedSession = id;
      document.getElementById('report').disabled = false;
      const [session, events, metrics] = await Promise.all([
        fetch('/api/sessions/' + id).then(r => r.json()),
        fetch('/api/sessions/' + id + '/events').then(r => r.json()),
        fetch('/api/metrics?session_id=' + encodeURIComponent(id)).then(r => r.json()),
      ]);
      document.getElementById('details').textContent = JSON.stringify({ session, metrics }, null, 2);
      document.getElementById('timeline').innerHTML = (events || []).slice(-80).map(event => \`
        <div class="event">
          <small>#\${event.seq} \${escapeHtml(event.ts || '')} \${escapeHtml(event.type || '')}\${event.peer ? '/' + escapeHtml(event.peer) : ''}</small>
          <div>\${escapeHtml(event.message || '')}</div>
        </div>\`).join('') || 'Sem eventos.';
    }
    async function openReport() {
      if (!selectedSession) return;
      const report = await fetch('/api/sessions/' + selectedSession + '/report').then(r => r.text());
      document.getElementById('details').textContent = report;
    }
    document.getElementById('refresh').addEventListener('click', refresh);
    document.getElementById('filter').addEventListener('input', refresh);
    document.getElementById('state').addEventListener('change', refresh);
    document.getElementById('report').addEventListener('click', openReport);
    refresh();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  try {
    if (url.pathname === "/") {
      sendHtml(response, html());
      return;
    }
    if (url.pathname === "/api/health") {
      sendJson(response, {
        ok: true,
        version: VERSION,
        data_dir: config.data_dir,
        log_file: eventLog.path(),
        stub: config.stub,
      });
      return;
    }
    if (url.pathname === "/api/probe") {
      sendJson(response, await orchestrator.probeAll());
      return;
    }
    if (url.pathname === "/api/metrics") {
      sendJson(
        response,
        orchestrator.store.metrics(url.searchParams.get("session_id") ?? undefined),
      );
      return;
    }
    if (url.pathname === "/api/sessions") {
      sendJson(response, orchestrator.store.list());
      return;
    }
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})$/);
    const sessionMatchId = sessionMatch?.[1];
    if (sessionMatchId) {
      sendJson(response, orchestrator.store.read(sessionMatchId));
      return;
    }
    const eventsMatch = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})\/events$/);
    const eventsSessionId = eventsMatch?.[1];
    if (eventsSessionId) {
      const since = Number(url.searchParams.get("since_seq") ?? 0);
      sendJson(response, orchestrator.store.readEvents(eventsSessionId, since));
      return;
    }
    const reportMatch = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})\/report$/);
    const reportSessionId = reportMatch?.[1];
    if (reportSessionId) {
      const sessionId = reportSessionId;
      const session = orchestrator.store.read(sessionId);
      const markdown = sessionReportMarkdown(session, orchestrator.store.readEvents(sessionId));
      orchestrator.store.saveReport(sessionId, markdown);
      response.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(markdown);
      return;
    }
    notFound(response);
  } catch {
    console.error("dashboard_request_failed");
    response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, error: "internal_server_error" }));
  }
});

server.listen(config.dashboard_port, "127.0.0.1", () => {
  console.log(`Cross Review dashboard: http://127.0.0.1:${config.dashboard_port}`);
});
