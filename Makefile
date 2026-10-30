.PHONY: build test test-unit test-sandbox fmt clippy clean size

# Compile the contract to target/near/allowance.wasm (no Docker needed).
build:
	cargo near build non-reproducible-wasm

# Everything: unit tests of the policy core and contract, then sandbox tests
# (the sandbox tests compile the wasm themselves and download neard-sandbox
# on first run).
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
