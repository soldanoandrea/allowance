//! Host a throw-away NEAR sandbox node for the local demo.
//!
//! `make demo` runs this binary as a child process. It starts `neard-sandbox`
//! through the `near-sandbox` crate (the same code path as `tests/sandbox.rs`,
//! which downloads the pinned binary on first use), prints one JSON line
//!
//! ```json
//! {"rpc_url":"http://127.0.0.1:PORT","root_account_id":"sandbox","root_secret_key":"ed25519:..."}
//! ```
//!
//! and keeps the node alive until its stdin is closed, Ctrl+C or SIGTERM.
//! Closing stdin is the normal shutdown path: if the parent dies, the pipe
//! closes and the node is stopped with it. The sandbox home directory is a
//! temporary directory removed on exit.
//!
//! `root_secret_key` is the sandbox's well-known genesis key (a public
//! constant of the `near-sandbox` crate); it is only valid on this local,
//! throw-away chain.
//!
//! Environment: `SANDBOX_RPC_PORT` pins the RPC port (default: a free port).

use near_sandbox::config::{DEFAULT_GENESIS_ACCOUNT, DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY};
use near_sandbox::{Sandbox, SandboxConfig};
use near_sdk::serde_json::json;
use std::io::Write;
use tokio::io::AsyncReadExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = SandboxConfig {
        rpc_port: std::env::var("SANDBOX_RPC_PORT")
            .ok()
            .and_then(|p| p.parse().ok()),
        // The ledger page talks to the node straight from the browser, and
        // finds events by reading old blocks: keep them (the sandbox's
        // epochs are 60 blocks, and by default only 5 epochs are kept).
        additional_config: Some(json!({
            "rpc": {"cors_allowed_origins": ["*"]},
            "gc_num_epochs_to_keep": 100_000,
        })),
        ..SandboxConfig::default()
    };
    let sandbox = Sandbox::start_sandbox_with_config(config).await?;

    let ready = json!({
        "rpc_url": sandbox.rpc_addr,
        "root_account_id": DEFAULT_GENESIS_ACCOUNT.as_str(),
        "root_secret_key": DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY,
    });
    let mut stdout = std::io::stdout();
    writeln!(stdout, "{ready}")?;
    stdout.flush()?;
    eprintln!(
        "sandbox_node: neard-sandbox listening on {}",
        sandbox.rpc_addr
    );

    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let stdin_closed = async {
        let mut sink = Vec::new();
        let _ = tokio::io::stdin().read_to_end(&mut sink).await;
    };
    tokio::select! {
        _ = stdin_closed => {}
        _ = tokio::signal::ctrl_c() => {}
        _ = sigterm.recv() => {}
    }
    eprintln!("sandbox_node: stopping neard-sandbox");
    drop(sandbox);
    Ok(())
}
