import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  HEADERS,
  PAYMENT_SCHEME,
  newNonce,
  near,
  parseReceiptHeader,
  receiptHeader,
  requestHash,
  type Counteroffer,
  type PaymentRequired,
  type ReceiptClaim,
  type VerifyResult,
} from '@allowance/sdk';

import { defaultCatalog, poisonedPage, type Product } from './catalog.ts';

/** What the server needs from a verifier (`ReceiptVerifier` in production, a fake in tests). */
export interface Verifier {
  readonly accepts: { vaults: string[]; code_hashes: string[] };
  verify(claim: ReceiptClaim): Promise<VerifyResult>;
}

export interface ApiOptions {
  /** The API's own NEAR account: receipts must pay it. */
  payee: string;
  verifier: Verifier;
  catalog?: Product[];
  /** Vault used when a client sends a bare receipt id. */
  defaultVault?: string;
  /** Account named by the poisoned page (attack demo). */
  attacker?: string;
  /** Unpaid quotes are forgotten after this long (default 24 h, like the vault's approval TTL). */
  quoteTtlMs?: number;
  log?: (line: string) => void;
}

interface Quote {
  product: Product;
  amount: bigint;
  nonce: string;
  expiresAt: number;
  counteroffer?: Counteroffer;
}

export interface ApiServer {
  server: Server;
  listen(port?: number, host?: string): Promise<string>;
  close(): Promise<void>;
}

/**
 * A tiny paid API. Unpaid requests get HTTP 402 with a quote; a retry with
 * `X-Allowance-Receipt: <vault>:<id>` and `X-Allowance-Nonce: <nonce>` is
 * served after one `verify_receipt` view call on the vault. Quotes and used
 * receipts are kept in memory (a demo, not a production billing system).
 */
export function createApiServer(options: ApiOptions): ApiServer {
  const catalog = options.catalog ?? defaultCatalog();
  const quotes = new Map<string, Quote>();
  const usedReceipts = new Set<string>();
  const ttl = options.quoteTtlMs ?? 24 * 3_600_000;
  const log = options.log ?? (() => {});

  function issueQuote(product: Product, amount: bigint, counteroffer?: Counteroffer): Quote {
    const now = Date.now();
    for (const [nonce, q] of quotes) if (q.expiresAt < now) quotes.delete(nonce);
    const quote: Quote = { product, amount, nonce: newNonce(), expiresAt: now + ttl, ...(counteroffer ? { counteroffer } : {}) };
    quotes.set(quote.nonce, quote);
    return quote;
  }

  function body402(quote: Quote, error?: { error: string; detail: string }): PaymentRequired {
    return {
      scheme: PAYMENT_SCHEME,
      resource: quote.product.path,
      description: quote.product.description,
      payee: options.payee,
      asset: 'near',
      amount_yocto: quote.amount.toString(),
      nonce: quote.nonce,
      request_hash_base64: requestHash(quote.nonce),
      expires_at: new Date(quote.expiresAt).toISOString(),
      accepts: options.verifier.accepts,
      instructions:
        `Pay ${near(quote.amount)} to ${options.payee} from an Allowance vault: ` +
        `pay(payee="${options.payee}", amount="${quote.amount}", request_hash="${requestHash(quote.nonce)}"), ` +
        `then repeat this request with headers ${HEADERS.receipt}: <vault>:<receipt id> and ${HEADERS.nonce}: ${quote.nonce}. ` +
        `One counteroffer is welcome: ${HEADERS.offer}: <yoctoNEAR> with ${HEADERS.offerReason}.`,
      ...(quote.counteroffer ? { counteroffer: quote.counteroffer } : {}),
      ...(error ? { error: error.error, error_detail: error.detail } : {}),
    };
  }

  async function handlePaid(req: IncomingMessage, res: ServerResponse, product: Product): Promise<void> {
    const receiptValue = header(req, HEADERS.receipt);
    if (receiptValue) {
      const nonce = header(req, HEADERS.nonce);
      if (!nonce) return send(res, 400, { error: 'missing_nonce', error_detail: `send ${HEADERS.nonce} with the receipt` });
      const quote = quotes.get(nonce);
      if (!quote || quote.product !== product) {
        return send(res, 402, body402(issueQuote(product, product.price), { error: 'unknown_nonce', detail: 'no open quote for this nonce and resource' }));
      }
      const parsed = parseReceiptHeader(receiptValue, options.defaultVault);
      if (!parsed) return send(res, 400, { error: 'bad_receipt_header', error_detail: `expected ${HEADERS.receipt}: <vault>:<receipt id>` });
      const key = receiptHeader(parsed.vaultId, parsed.receiptId);
      if (usedReceipts.has(key)) {
        return send(res, 402, body402(quote, { error: 'receipt_already_used', detail: `${key} was already redeemed` }));
      }
      const result = await options.verifier.verify({ ...parsed, payee: options.payee, minAmount: quote.amount, nonce });
      if (!result.ok) {
        log(`GET ${product.path}  receipt ${key} REFUSED: ${result.reason} (${result.detail})`);
        return send(res, 402, body402(quote, { error: result.reason, detail: result.detail }));
      }
      usedReceipts.add(key);
      quotes.delete(nonce);
      log(`GET ${product.path}  receipt ${key} verified on-chain (verify_receipt at block ${result.blockHash}) -> 200`);
      res.setHeader('x-allowance-paid', key);
      return send(res, 200, {
        resource: product.path,
        description: product.description,
        paid: { vault: parsed.vaultId, receipt_id: parsed.receiptId, amount_yocto: quote.amount.toString() },
        data: product.data(),
      });
    }

    const offerText = header(req, HEADERS.offer);
    if (offerText) {
      if (!/^\d{1,40}$/.test(offerText)) return send(res, 400, { error: 'bad_offer', error_detail: `${HEADERS.offer} must be yoctoNEAR` });
      const offer = BigInt(offerText);
      const reason = header(req, HEADERS.offerReason) ?? '';
      const accepted = offer >= product.floor && offer < product.price;
      const counteroffer: Counteroffer = {
        status: accepted ? 'accepted' : 'rejected',
        offered_yocto: offer.toString(),
        list_price_yocto: product.price.toString(),
        reason: accepted
          ? `Deal: ${near(offer)} paid now beats ${near(product.price)} paid later.`
          : `${near(offer)} is below what we can accept for this dataset; the list price stands.`,
      };
      log(`GET ${product.path}  counteroffer ${near(offer)} ("${reason.slice(0, 80)}") -> ${counteroffer.status}`);
      return send(res, 402, body402(issueQuote(product, accepted ? offer : product.price, counteroffer)));
    }

    const quote = issueQuote(product, product.price);
    log(`GET ${product.path}  -> 402 quote ${near(quote.amount)} (nonce ${quote.nonce})`);
    return send(res, 402, body402(quote));
  }

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
    if (path === '/health') return send(res, 200, { ok: true });
    if (path === '/') {
      return send(res, 200, {
        payee: options.payee,
        scheme: PAYMENT_SCHEME,
        accepts: options.verifier.accepts,
        products: catalog.map((p) => ({ path: p.path, description: p.description, price_yocto: p.price.toString() })),
      });
    }
    if (path === '/web/market-news') {
      log('GET /web/market-news  (free page with a hidden prompt injection)');
      return send(res, 200, poisonedPage(options.attacker ?? 'attacker.testnet', options.payee));
    }
    const product = catalog.find((p) => p.path === path);
    if (!product) return send(res, 404, { error: 'not_found' });
    handlePaid(req, res, product).catch((err: unknown) => {
      log(`GET ${path}  internal error: ${(err as Error).message}`);
      send(res, 500, { error: 'internal_error' });
    });
  });

  return {
    server,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const { port: actual } = server.address() as AddressInfo;
          resolve(`http://${host}:${actual}`);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
