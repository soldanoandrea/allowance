/*
 * Allowance ledger - rendering. Query parameters:
 *   rpc=<url>        NEAR JSON-RPC endpoint (e.g. http://127.0.0.1:3030, https://rpc.testnet.near.org)
 *   vault=<account>  vault contract account
 *   interval=<s>     polling interval, default 3
 *   scan=<blocks>    how far back to look for events on first load, default 300
 *   from=<height>    scan events from this block height instead
 * All text is inserted with textContent (memos and labels are agent-controlled).
 */
(function () {
  'use strict';
  var L = window.AllowanceLedger;
  var params = new URLSearchParams(location.search);
  var rpcUrl = params.get('rpc');
  var vaultId = params.get('vault');
  var intervalMs = Math.max(1, Number(params.get('interval') || 3)) * 1000;
  var scanState = { nextHeight: Number(params.get('from')) || 0, events: [], seenTx: {} };
  var windowBlocks = Number(params.get('scan') || 300);
  var app = document.getElementById('app');
  var paused = false;
  var timer = null;
  var lastOk = 0;

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') el.className = attrs[k];
        else if (k === 'text') el.textContent = attrs[k];
        else el.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function badge(text, kind) {
    return h('span', { class: 'badge' + (kind ? ' ' + kind : ''), text: text });
  }

  function statusBadge(status) {
    var s = status.status;
    if (s === 'paid') return badge('paid', 'ok');
    if (s === 'rejected') return badge('rejected: ' + status.reason.code, 'bad');
    if (s === 'failed') return badge('failed: ' + status.reason, 'bad');
    if (s === 'pending' || s === 'approved') return badge(s, 'warn');
    return badge(s);
  }

  function section(title, children) {
    return h('section', null, [h('h2', { text: title })].concat(children));
  }

  function table(headers, rows, numeric) {
    var num = numeric || [];
    return h('div', { class: 'scroll' }, [
      h('table', null, [
        h('thead', null, [h('tr', null, headers.map(function (t, i) { return h('th', { class: num.indexOf(i) >= 0 ? 'num' : '', text: t }); }))]),
        h('tbody', null, rows),
      ]),
    ]);
  }

  function td(content, cls) {
    return h('td', cls ? { class: cls } : null, [content === null || content === undefined ? '' : content]);
  }

  function stat(label, value, sub) {
    return h('div', { class: 'stat' }, [h('div', { class: 'label', text: label }), h('div', { class: 'value', text: value }), sub ? h('div', { class: 'sub', text: sub }) : null]);
  }

  function renderSetup() {
    document.getElementById('status').textContent = 'not connected';
    document.getElementById('toggle').hidden = true;
    var form = h('form', null, [
      h('label', null, ['RPC URL', h('input', { name: 'rpc', placeholder: 'http://127.0.0.1:3030 or https://rpc.testnet.near.org', value: rpcUrl || '' })]),
      h('label', null, ['Vault account', h('input', { name: 'vault', placeholder: 'vault.you.testnet', value: vaultId || '' })]),
      h('div', null, [h('button', { type: 'submit', text: 'Open ledger' })]),
    ]);
    app.appendChild(section('Open a vault', [
      h('p', { class: 'muted', text: 'This page reads an Allowance vault over plain NEAR JSON-RPC. `make demo-keep` prints a ready-made link for the local sandbox.' }),
      form,
    ]));
  }

  function renderStats(s) {
    var v = s.vault;
    var tokenStats = (v.tokens || []).map(function (t) {
      return stat('Token ' + t.token_id, L.formatAmount(t.balance, { ft: t.token_id }), 'NEP-141, accounted by the vault');
    });
    return h('section', null, [
      h('div', { class: 'stats' }, [
        stat('Available to pay', L.formatNear(v.available), 'balance ' + L.formatNear(v.balance) + ' incl. storage'),
      ].concat(tokenStats, [
        stat('Status', v.paused ? 'Paused' : 'Running', 'owner ' + v.owner_id + (v.approver_id ? ', approver ' + v.approver_id : '')),
        stat('Agents', String(v.agents), 'key gas allowance ' + L.formatNear(v.key_gas_allowance)),
        stat('Receipts', String(v.next_receipt_id), v.first_receipt_id ? 'oldest kept #' + v.first_receipt_id : 'none pruned'),
        stat('Pending approvals', String(v.pending), 'expire after ' + L.duration(v.approval_ttl_ns)),
      ], v.split ? [stat('Revenue split', v.split.beneficiaries.map(function (b) { return b.bps / 100 + '%'; }).join(' + '),
        v.split.beneficiaries.map(function (b) { return b.account_id; }).join(', '))] : [])),
    ]);
  }

  function renderAgents(s) {
    if (!s.agents.length) return section('Agents and policy', [h('div', { class: 'empty', text: 'No agents registered.' })]);
    return section('Agents and policy', [h('div', { class: 'agents' }, s.agents.map(function (a) {
      var id = a.id.key || a.id.account;
      var budget = a.policy.budget;
      var meter = null;
      if (budget) {
        var total = BigInt(budget.amount);
        var left = BigInt(a.remaining_budget || '0');
        var pct = total > 0n ? Number(((total - left) * 1000n) / total) / 10 : 0;
        meter = h('div', null, [
          h('div', { class: 'meter' }, [h('div', { style: 'width:' + Math.min(100, pct) + '%' })]),
          h('div', { class: 'muted', text: L.formatAmount(total - left, a.policy.asset) + ' spent, ' + L.formatAmount(left, a.policy.asset) + ' left, resets ' + L.isoFromNs(a.budget_resets_at_ns) + ' UTC' }),
        ]);
      }
      return h('div', { class: 'agent' }, [
        h('div', { class: 'title' }, [h('strong', { text: a.label }), a.active ? badge('active', 'ok') : badge('disabled', 'bad')]),
        h('div', { class: 'mono muted', title: id, text: (a.id.key ? 'key ' : 'account ') + L.describeAgent(a.id) }),
        h('ul', null, L.describePolicy(a.policy).map(function (line) { return h('li', { text: line }); })),
        meter,
        h('div', { class: 'muted', text: a.state.payments + ' payment(s), policy v' + a.policy_version + (a.state.last_payment_ns !== '0' ? ', last ' + L.isoFromNs(a.state.last_payment_ns) + ' UTC' : '') }),
      ]);
    }))]);
  }

  function renderPending(s) {
    var now = BigInt(s.vault.block_timestamp_ns);
    var body = s.pending.length
      ? table(['Request', 'Receipt', 'Payee', 'Amount', 'Memo', 'Expires'], s.pending.map(function (p) {
          var left = BigInt(p.expires_at_ns) - now;
          return h('tr', null, [
            td('#' + p.id), td('#' + p.receipt_id), td(p.payee), td(L.formatAmount(p.amount, p.asset), 'num'), td(p.memo, 'wrap'),
            td(left > 0n ? 'in ' + L.duration(left.toString()) : badge('expired', 'bad')),
          ]);
        }), [3])
      : h('div', { class: 'empty', text: 'Nothing waiting for a human.' });
    return section('Pending approvals', [
      body,
      s.pending.length ? h('div', { class: 'hint' }, ['Approve from the owner account: ', h('code', { text: 'npx allowance approve <request> --owner ' + s.vault.owner_id + ' --owner-key-file <path>' })]) : null,
    ]);
  }

  function renderReceipts(s) {
    if (!s.receipts.length) return section('Receipts', [h('div', { class: 'empty', text: 'No receipts yet.' })]);
    var rows = s.receipts.slice().reverse().map(function (r) {
      var delivered = r.delivered === null ? '' : r.delivered ? badge('pass', 'ok') : badge('fail', 'bad');
      var status = h('td', null, [statusBadge(r.status), r.approved_by ? h('div', { class: 'muted small', text: 'approved by ' + r.approved_by }) : null]);
      return h('tr', null, [
        td('#' + r.id), td(L.isoFromNs(r.ts_ns).slice(5)), td(r.kind), status,
        td(h('span', { class: 'mono', title: r.agent.key || r.agent.account || '', text: L.describeAgent(r.agent) })),
        td(r.payee), td(L.formatAmount(r.amount, r.asset), 'num'), td(delivered),
        td((r.memo || '') + ((r.split || []).length ? (r.memo ? ' | ' : '') + 'split: ' + r.split.map(function (p) {
          return p.account_id + ' ' + L.formatAmount(p.amount, r.asset) + ' (' + p.status + ')';
        }).join(', ') : ''), 'wrap'),
      ]);
    });
    return section('Receipts (newest first)', [table(['Id', 'Time (UTC)', 'Kind', 'Status', 'Agent', 'Payee', 'Amount', 'Delivered', 'Memo'], rows, [6])]);
  }

  function renderEvents() {
    var events = scanState.events.slice().reverse().slice(0, 100);
    var body = events.length
      ? table(['Block', 'Event', 'Details', 'Tx'], events.map(function (e) {
          var kind = /rejected|failed|denied|expired|killed/.test(e.event) ? 'bad' : /requested|paused/.test(e.event) ? 'warn' : 'ok';
          return h('tr', null, [td(String(e.height)), td(badge(e.event, kind)), td(L.describeEvent(e), 'wrap'), td(h('span', { class: 'mono', title: e.txHash, text: e.txHash.slice(0, 10) + '...' }))]);
        }))
      : h('div', { class: 'empty', text: 'No vault transactions in the scanned blocks yet.' });
    return section('Recent events (NEP-297)', [body]);
  }

  function setStatus(text, kind) {
    document.getElementById('status').textContent = text;
    document.getElementById('dot').className = 'dot' + (kind ? ' ' + kind : '');
  }

  async function poll() {
    timer = null;
    try {
      var snapshot = await L.loadSnapshot(rpcUrl, vaultId);
      L.setTokens(snapshot.tokens);
      var scanError = null;
      try {
        await L.scanEvents(rpcUrl, vaultId, scanState, { windowBlocks: windowBlocks });
      } catch (err) {
        scanError = err;
      }
      app.replaceChildren(renderStats(snapshot), renderAgents(snapshot), renderPending(snapshot), renderReceipts(snapshot), renderEvents());
      lastOk = Date.now();
      setStatus('updated ' + new Date().toLocaleTimeString() + (scanError ? ' (event scan failed: ' + scanError.message + ')' : ''), scanError ? 'stale' : '');
      document.getElementById('footer').textContent =
        'Data: NEAR JSON-RPC ' + rpcUrl + ', view methods of ' + vaultId + '. Events: NEP-297 logs of transactions sent to the vault, found by scanning blocks ' +
        (scanState.head ? (scanState.firstHeight || '?') + '-' + scanState.head : '-') +
        ' (no indexer' + (scanState.unavailable ? '; ' + scanState.unavailable + ' height(s) not served by this node: skipped or garbage-collected, use an archival RPC for older events' : '') +
        '). The receipts table is the complete, authoritative history.';
    } catch (err) {
      setStatus('error: ' + err.message + (lastOk ? ' (showing data from ' + new Date(lastOk).toLocaleTimeString() + ')' : ''), 'err');
      if (!lastOk) app.replaceChildren(section('Cannot read the vault', [h('p', { class: 'error', text: err.message }), h('p', { class: 'muted', text: 'Check the rpc and vault parameters, and that the node allows CORS.' })]));
    }
    if (!paused) timer = setTimeout(poll, intervalMs);
  }

  if (!rpcUrl || !vaultId) {
    renderSetup();
    return;
  }
  document.getElementById('vault-name').textContent = vaultId;
  document.title = 'Allowance Ledger - ' + vaultId;
  var toggle = document.getElementById('toggle');
  toggle.addEventListener('click', function () {
    paused = !paused;
    toggle.textContent = paused ? 'Resume' : 'Pause';
    if (!paused && !timer) poll();
    else if (paused && timer) { clearTimeout(timer); timer = null; setStatus('paused', 'stale'); }
  });
  poll();
})();
