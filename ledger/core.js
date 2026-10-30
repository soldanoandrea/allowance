/*
 * Allowance ledger - data layer (no DOM). A classic script so the page also
 * works from file:// (browsers refuse ES modules there). Exposes
 * `globalThis.AllowanceLedger`; the unit tests load this file in a Node VM.
 *
 * Everything comes from plain NEAR JSON-RPC:
 *   - state: the vault's view methods (get_vault, get_agents, get_pending, get_receipts);
 *   - events: NEP-297 logs found by scanning recent blocks for transactions
 *     sent to the vault and reading their outcomes (no indexer needed, but
 *     only transactions addressed to the vault, and only the scanned window).
 */
(function (root) {
  'use strict';

  var YOCTO_PER_NEAR = 10n ** 24n;
  var EMPTY_TX_ROOT = '11111111111111111111111111111111';
  var nextId = 1;

  function RpcError(message, data) {
    var err = new Error(message);
    err.name = 'RpcError';
    err.data = data;
    return err;
  }

  async function rpc(url, method, params, fetchImpl) {
    var f = fetchImpl || root.fetch;
    var res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'ledger-' + nextId++, method: method, params: params }),
    });
    var body;
    try {
      body = await res.json();
    } catch (e) {
      throw RpcError('RPC HTTP ' + res.status);
    }
    if (body.error) {
      var cause = body.error.cause && body.error.cause.name;
      throw RpcError((cause || body.error.name || 'RPC error') + ': ' + (body.error.data || body.error.message || ''), body.error);
    }
    if (body.result && body.result.error) throw RpcError(String(body.result.error), body.result);
    return body.result;
  }

  function utf8ToBase64(text) {
    var bytes = new TextEncoder().encode(text);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function bytesToText(bytes) {
    return new TextDecoder().decode(new Uint8Array(bytes));
  }

  async function view(url, contractId, method, args, fetchImpl) {
    var result = await rpc(url, 'query', {
      request_type: 'call_function',
      finality: 'optimistic',
      account_id: contractId,
      method_name: method,
      args_base64: utf8ToBase64(JSON.stringify(args || {})),
    }, fetchImpl);
    var text = bytesToText(result.result);
    return text ? JSON.parse(text) : null;
  }

  /** Everything the page shows except events. Receipts: the newest `maxReceipts`. */
  async function loadSnapshot(url, vaultId, options) {
    var opts = options || {};
    var f = opts.fetch;
    var maxReceipts = opts.maxReceipts || 200;
    var results = await Promise.all([
      view(url, vaultId, 'get_vault', {}, f),
      view(url, vaultId, 'get_agents', { from_index: 0, limit: 100 }, f),
      view(url, vaultId, 'get_pending', {}, f),
      view(url, vaultId, 'get_denylist', {}, f),
    ]);
    var vault = results[0];
    // NEP-141 tokens the vault holds: read symbol and decimals from each token
    // contract (best effort: amounts fall back to base units).
    var tokens = {};
    await Promise.all((vault.tokens || []).map(function (t) {
      return view(url, t.token_id, 'ft_metadata', {}, f).then(function (m) {
        if (m && typeof m.symbol === 'string' && typeof m.decimals === 'number') tokens[t.token_id] = { symbol: m.symbol, decimals: m.decimals };
      }, function () {});
    }));
    var from = Math.max(vault.first_receipt_id, vault.next_receipt_id - maxReceipts);
    var pages = [];
    for (var id = from; id < vault.next_receipt_id; id += 50) {
      pages.push(view(url, vaultId, 'get_receipts', { from_id: id, limit: 50 }, f));
    }
    var receipts = [].concat.apply([], await Promise.all(pages));
    return { vault: vault, agents: results[1], pending: results[2], denylist: results[3], receipts: receipts, tokens: tokens };
  }

  function parseEventLogs(logs) {
    var out = [];
    for (var i = 0; i < logs.length; i++) {
      var line = logs[i];
      if (typeof line !== 'string' || line.indexOf('EVENT_JSON:') !== 0) continue;
      try {
        var ev = JSON.parse(line.slice('EVENT_JSON:'.length));
        if (ev && ev.standard === 'allowance' && typeof ev.event === 'string') out.push(ev);
      } catch (e) {
        /* not ours */
      }
    }
    return out;
  }

  /**
   * Scan blocks (`state.nextHeight` .. head) for transactions sent to the
   * vault and collect their events. `state` is kept by the caller between
   * polls: { nextHeight, events: [], seenTx: {} }. The first call starts
   * `windowBlocks` below the head unless `state.nextHeight` is set.
   */
  async function scanEvents(url, vaultId, state, options) {
    var opts = options || {};
    var f = opts.fetch;
    var head = (await rpc(url, 'block', { finality: 'final' }, f)).header.height;
    if (!state.nextHeight) state.nextHeight = Math.max(1, head - (opts.windowBlocks || 300) + 1);
    if (!state.firstHeight) state.firstHeight = state.nextHeight;
    var maxBlocks = opts.maxBlocksPerPoll || 600;
    var to = Math.min(head, state.nextHeight + maxBlocks - 1);
    var heights = [];
    for (var h = state.nextHeight; h <= to; h++) heights.push(h);
    var concurrency = opts.concurrency || 12;
    var found = [];
    for (var i = 0; i < heights.length; i += concurrency) {
      var batch = heights.slice(i, i + concurrency);
      var txLists = await Promise.all(batch.map(function (height) { return vaultTxsAt(url, vaultId, height, state, f); }));
      for (var j = 0; j < txLists.length; j++) found = found.concat(txLists[j]);
    }
    for (var k = 0; k < found.length; k++) {
      var tx = found[k];
      if (state.seenTx[tx.hash]) continue;
      state.seenTx[tx.hash] = true;
      var status = await rpc(url, 'tx', { tx_hash: tx.hash, sender_account_id: tx.signer_id, wait_until: 'EXECUTED_OPTIMISTIC' }, f);
      var logs = [].concat(
        status.transaction_outcome.outcome.logs,
        [].concat.apply([], status.receipts_outcome.map(function (r) { return r.outcome.logs; })),
      );
      var events = parseEventLogs(logs);
      for (var e = 0; e < events.length; e++) {
        state.events.push({ height: tx.height, txHash: tx.hash, signer: tx.signer_id, event: events[e].event, data: events[e].data });
      }
    }
    state.nextHeight = to + 1;
    state.head = head;
    return state;
  }

  async function vaultTxsAt(url, vaultId, height, state, f) {
    var block;
    try {
      block = await rpc(url, 'block', { block_id: height }, f);
    } catch (e) {
      // No block at this height (skipped), or garbage-collected by a
      // non-archival node: count it so the page can say so.
      state.unavailable = (state.unavailable || 0) + 1;
      return [];
    }
    var chunks = block.chunks.filter(function (c) {
      return c.tx_root !== EMPTY_TX_ROOT && c.height_included === block.header.height;
    });
    var out = [];
    for (var i = 0; i < chunks.length; i++) {
      var chunk = await rpc(url, 'chunk', { chunk_id: chunks[i].chunk_hash }, f);
      for (var t = 0; t < chunk.transactions.length; t++) {
        var tx = chunk.transactions[t];
        if (tx.receiver_id === vaultId) out.push({ hash: tx.hash, signer_id: tx.signer_id, height: height });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Formatting
  // ------------------------------------------------------------------

  function formatNear(yocto, decimals) {
    var d = decimals === undefined ? 4 : decimals;
    var v = BigInt(yocto);
    var whole = v / YOCTO_PER_NEAR;
    var frac = (v % YOCTO_PER_NEAR).toString().padStart(24, '0').slice(0, d).replace(/0+$/, '');
    if (!frac && v % YOCTO_PER_NEAR !== 0n && whole === 0n) return '<0.' + '0'.repeat(Math.max(0, d - 1)) + '1 NEAR';
    return (frac ? whole + '.' + frac : String(whole)) + ' NEAR';
  }

  /** Token metadata known to the page: { tokenId: { symbol, decimals } }, filled by loadSnapshot. */
  var tokenMeta = {};

  function setTokens(tokens) {
    tokenMeta = tokens || {};
  }

  /** "0.02 NEAR", "2 SUSD", or "2000000 usd.x units" when the token's decimals are unknown. */
  function formatAmount(amount, asset) {
    if (!asset || asset === 'near') return formatNear(amount);
    var token = asset.ft;
    var meta = tokenMeta[token];
    if (!meta) return String(amount) + ' ' + token + ' units';
    var v = BigInt(amount);
    var unit = 10n ** BigInt(meta.decimals);
    var frac = (v % unit).toString().padStart(meta.decimals, '0').replace(/0+$/, '');
    return (frac ? (v / unit) + '.' + frac : String(v / unit)) + ' ' + meta.symbol;
  }

  function shortKey(key) {
    var parts = String(key).split(':');
    var body = parts.length > 1 ? parts[1] : parts[0];
    if (body.length <= 12) return key;
    return (parts.length > 1 ? parts[0] + ':' : '') + body.slice(0, 6) + '...' + body.slice(-5);
  }

  function describeAgent(agent) {
    if (!agent) return '';
    return agent.key ? shortKey(agent.key) : agent.account;
  }

  function nsToDate(ns) {
    return new Date(Number(BigInt(ns) / 1000000n));
  }

  /** "2026-10-30 20:25:41" (UTC, seconds precision). */
  function isoFromNs(ns) {
    return nsToDate(ns).toISOString().slice(0, 19).replace('T', ' ');
  }

  function duration(ns) {
    var s = Number(BigInt(ns) / 1000000000n);
    var parts = [];
    [['d', 86400], ['h', 3600], ['m', 60]].forEach(function (u) {
      if (s >= u[1]) {
        parts.push(Math.floor(s / u[1]) + u[0]);
        s %= u[1];
      }
    });
    if (s > 0 || parts.length === 0) parts.push(s + 's');
    return parts.join('');
  }

  function describeRejection(r, asset) {
    var fmt = function (v) { return formatAmount(v, asset); };
    switch (r.code) {
      case 'paused': return 'vault paused';
      case 'agent_disabled': return 'agent disabled';
      case 'policy_expired': return 'policy expired';
      case 'asset_not_allowed': return 'asset not allowed';
      case 'denylisted': return r.payee + ' is denylisted';
      case 'not_allowlisted': return r.payee + ' is not on the allowlist';
      case 'over_per_tx_cap': return 'above the ' + fmt(r.cap) + ' cap';
      case 'outside_time_window': return 'outside the time window';
      case 'cooldown': return 'cooldown';
      case 'over_budget': return 'over budget (' + fmt(r.remaining) + ' left)';
      case 'insufficient_vault_balance': return 'vault balance too low';
      case 'unknown_agent': return 'unknown agent';
      default: return r.code;
    }
  }

  function describePolicy(p) {
    var asset = p.asset || 'near';
    var fmt = function (v) { return formatAmount(v, asset); };
    var lines = asset === 'near' ? [] : ['pays in ' + asset.ft + ' (NEP-141)'];
    lines.push('cap ' + fmt(p.per_tx_cap) + ' per payment');
    if (p.budget) lines.push('budget ' + fmt(p.budget.amount) + ' per ' + duration(p.budget.period_ns));
    if (!p.allow || p.allow === 'any') lines.push('any payee (denylist applies)');
    else lines.push('payees: ' + p.allow.list.map(function (e) { return e.account_id; }).join(', '));
    if (p.approval_threshold) lines.push('human approval above ' + fmt(p.approval_threshold));
    if (p.cooldown_ns && p.cooldown_ns !== '0') lines.push('cooldown ' + duration(p.cooldown_ns));
    if (p.time_window) {
      lines.push('UTC ' + p.time_window.start_h + ':00-' + p.time_window.end_h + ':00' +
        (p.time_window.days && p.time_window.days.length ? ' (ISO days ' + p.time_window.days.join(',') + ')' : ''));
    }
    if (p.expires_at_ns) lines.push('expires ' + isoFromNs(p.expires_at_ns));
    if (p.ft_storage_deposit) lines.push('may pay up to ' + formatNear(p.ft_storage_deposit) + ' to register a payee on the token');
    return lines;
  }

  /** One-line, human summary of an event's data. */
  function describeEvent(ev) {
    var d = ev.data || {};
    var amt = function () { return formatAmount(d.amount, d.asset); };
    switch (ev.event) {
      case 'vault_funded': return amt() + ' from ' + d.from + ' (receipt #' + d.receipt_id + ')';
      case 'withdrawn': return amt() + ' to ' + d.to;
      case 'agent_added': return describeAgent(d.agent) + ' "' + d.label + '"';
      case 'policy_set': return describeAgent(d.agent) + ' policy v' + d.policy_version;
      case 'payment_paid': return '#' + d.receipt_id + ' ' + amt() + ' -> ' + d.payee;
      case 'payment_failed': return '#' + d.receipt_id + ' ' + amt() + ' -> ' + d.payee + (d.reason ? ': ' + d.reason : '');
      case 'payment_rejected': return '#' + d.receipt_id + ' ' + amt() + ' -> ' + d.payee + ': ' + describeRejection(d.reason, d.asset);
      case 'approval_requested': return 'request #' + d.pending_id + ': ' + amt() + ' -> ' + d.payee;
      case 'ft_payee_registration': return '#' + d.receipt_id + ' registers ' + d.payee + ' on ' + d.token_id + ' (up to ' + formatNear(d.attached) + ')';
      case 'token_registered': return d.token_id;
      case 'split_settled': return '#' + d.receipt_id + ' share ' + amt() + ' -> ' + d.beneficiary + (d.paid ? '' : ' FAILED (kept)');
      case 'split_set': return d.split ? d.split.beneficiaries.map(function (b) { return b.account_id + ' ' + b.bps / 100 + '%'; }).join(', ') : 'removed';
      case 'approval_granted':
      case 'approval_denied': return 'request #' + d.pending_id + ' by ' + d.approver;
      case 'delivery_confirmed': return '#' + d.receipt_id + ' ' + (d.passed ? 'pass' : 'FAIL');
      case 'vault_killed': return 'by ' + d.by + ', ' + (d.agents || []).length + ' key(s) deleted';
      default: return JSON.stringify(d);
    }
  }

  root.AllowanceLedger = {
    rpc: rpc,
    view: view,
    loadSnapshot: loadSnapshot,
    scanEvents: scanEvents,
    parseEventLogs: parseEventLogs,
    formatNear: formatNear,
    formatAmount: formatAmount,
    setTokens: setTokens,
    shortKey: shortKey,
    describeAgent: describeAgent,
    describeRejection: describeRejection,
    describePolicy: describePolicy,
    describeEvent: describeEvent,
    duration: duration,
    isoFromNs: isoFromNs,
    nsToDate: nsToDate,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
