.PHONY: build test test-unit test-sandbox fmt fmt-check clippy clean size \
        sandbox-node node-check demo demo-keep attack-log test-ts typecheck check \
        demo-testnet demo-manual video

# ----------------------------------------------------------------------
# Contract (Rust)
# ----------------------------------------------------------------------

# Compile the contract to target/near/allowance.wasm (no Docker needed), the
# vault factory to target/near/allowance_factory/, and the NEP-141 test token
# used by the tests and the demo to target/near/test_token/.
build:
	cargo near build non-reproducible-wasm
	cargo near build non-reproducible-wasm --manifest-path factory/Cargo.toml
	cargo near build non-reproducible-wasm --no-abi --manifest-path tests/fixtures/test-token/Cargo.toml

# Everything Rust: unit tests of the policy core and contract, then sandbox
# tests (they compile the wasm themselves and download neard-sandbox on
# first run).
test:
	cargo test --workspace

# Fast feedback: pure policy evaluation + contract logic with a mocked VM
# (vault and factory).
test-unit:
	cargo test --lib --workspace

# Integration tests against a local NEAR sandbox node (vault, then the
# factory on a global contract).
test-sandbox:
	cargo test --test sandbox --test factory -- --nocapture

fmt:
	cargo fmt --all

fmt-check:
	cargo fmt --all --check

clippy:
	cargo clippy --workspace --all-targets -- -D warnings

size: build
	@ls -l target/near/allowance.wasm target/near/allowance_factory/allowance_factory.wasm | awk '{printf "%s: %d bytes (%.1f KB)\n", $$9, $$5, $$5/1000}'

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

# The same story on NEAR testnet with accounts that already exist (see
# docs/TESTNET.md). Reads .env.testnet if present. DRY RUN unless
# TESTNET_CONFIRM=yes: it prints the plan and signs nothing. Never creates
# accounts, never writes keys. STEP=deploy|fund|add-agent|run (default all).
demo-testnet: node-check build node_modules
	node --env-file-if-exists=.env.testnet scripts/testnet/demo.ts $(or $(STEP),all)

# For recording the video: like demo-keep, but YOU approve the payment that
# waits for a human, with the CLI command the demo prints.
demo-manual: node-check build sandbox-node node_modules
	node examples/local_demo/run.ts --keep --manual-approve

# Render the demo video (docs/demo.tape, docs/DEMO_SCRIPT.md) with VHS
# against a live local sandbox: docs/media/demo.mp4 and docs/media/demo.gif.
# Needs vhs, ttyd and ffmpeg (macOS: brew install vhs). Nothing is uploaded.
video: node-check
	scripts/video/render.sh

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
check: fmt-check test build sandbox-node test-ts demo
