.PHONY: build test test-unit test-sandbox fmt clippy clean size \
        sandbox-node node-check demo demo-keep attack-log test-ts typecheck check

# ----------------------------------------------------------------------
# Contract (Rust)
# ----------------------------------------------------------------------

# Compile the contract to target/near/allowance.wasm (no Docker needed), and
# the NEP-141 test token used by the tests and the demo to
# target/near/test_token/test_token.wasm.
build:
	cargo near build non-reproducible-wasm
	cargo near build non-reproducible-wasm --no-abi --manifest-path tests/fixtures/test-token/Cargo.toml

# Everything Rust: unit tests of the policy core and contract, then sandbox
# tests (they compile the wasm themselves and download neard-sandbox on
# first run).
test:
	cargo test

# Fast feedback: pure policy evaluation + contract logic with a mocked VM.
test-unit:
	cargo test --lib

# Integration tests against a local NEAR sandbox node.
test-sandbox:
	cargo test --test sandbox -- --nocapture

fmt:
	cargo fmt --all

clippy:
	cargo clippy --all-targets -- -D warnings

size: build
	@ls -l target/near/allowance.wasm | awk '{printf "allowance.wasm: %d bytes (%.1f KB)\n", $$5, $$5/1024}'

clean:
	cargo clean
	rm -rf node_modules examples/local_demo/.tmp

# ----------------------------------------------------------------------
# TypeScript side: SDK + CLI, demo API, ledger page, local demo
# ----------------------------------------------------------------------

# Host for a throw-away neard-sandbox (near-sandbox crate; downloads the
# node binary on first use).
sandbox-node:
	cargo build --example sandbox_node

node-check:
	@node -e "const [M,m]=process.versions.node.split('.').map(Number); process.exit(M>22||(M===22&&m>=22)?0:1)" \
	  || (echo "Node.js >= 22.22 is required (24 recommended; runs TypeScript natively); found $$(node --version)"; exit 1)

node_modules: package.json package-lock.json sdk/package.json demo-api/package.json
	npm ci
	@touch node_modules

# One command: sandbox, deploy, fund, policy, paid API, agent loop, attack,
# receipts, ledger URL; exits when done (non-zero if a check fails).
demo: node-check build sandbox-node node_modules
	node examples/local_demo/run.ts

# Same, but keep the sandbox and the API running to browse the ledger page.
demo-keep: node-check build sandbox-node node_modules
	node examples/local_demo/run.ts --keep

# Re-run the demo and refresh docs/attack-log.md with the real output.
attack-log: node-check build sandbox-node node_modules
	node examples/local_demo/run.ts --update-docs

typecheck: node-check node_modules
	npm run typecheck

# Type-check + unit tests (mocked RPC) + the sandbox end-to-end test (it
# skips itself, saying why, if `make build sandbox-node` has not run).
test-ts: typecheck
	npm test

# What CI runs.
check: test build sandbox-node test-ts demo
