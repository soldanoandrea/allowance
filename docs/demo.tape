# Allowance demo video (docs/DEMO_SCRIPT.md, scene by scene), recorded by VHS
# against a live local sandbox. Render it with `make video`, which runs this
# tape in a fresh clone (so no local paths show), then writes
# docs/media/demo.mp4 and docs/media/demo.gif.
#
# What is real: `make demo-manual` runs in the background and writes its
# output to examples/local_demo/.tmp/demo.log; the scenes print slices of that
# live log at reading pace (scripts/video/scene.ts, which wraps long lines
# under themselves instead of cutting them); the owner's approval, the ledger, the kill switch
# and the refused payment are real CLI commands typed against the same chain.
# The captions stand in for the voice-over.

Output docs/media/demo.mp4

Require node
Require make

Set Shell "bash"
Set FontFamily "Menlo"
# 1920x1080 (16:9, full HD for X) with a 20 px font: about 155 columns and
# 43 rows. Long lines wrap (scene.ts, the CLI's tables), none is cut.
Set FontSize 20
Set LineHeight 1.2
Set Width 1920
Set Height 1080
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 28ms
Set Framerate 30
Set WaitTimeout 240s

# ---------------------------------------------------------------- setup (not recorded)
Hide
Type `mkdir -p examples/local_demo/.tmp && rm -f examples/local_demo/.tmp/demo.log`
Enter
Type `scene() { node scripts/video/scene.ts --log examples/local_demo/.tmp/demo.log "$@"; }`
Enter
Type `card() { printf '\033[2J\033[3J\033[H\n \033[1;30;46m %s \033[0m\n\n' "$1"; shift; for l in "$@"; do printf '  %s\n\n' "$l"; done; }`
Enter
Type "clear"
Enter
Sleep 500ms
Show

# ---------------------------------------------------------------- 0:00 title card
Type `echo "Allowance - a sandboxed treasury for AI agents on NEAR"`
Enter
Type `echo "An agent gets an allowance, not your keys."`
Enter
Type `echo "Recorded live on a local NEAR sandbox. Built at NEAR HACKATHON."`
Enter
Sleep 3s

# ---------------------------------------------------------------- the problem
Hide
Type `card "The problem" "An AI agent that pays for things usually holds a full wallet key." "One poisoned web page, and the money is gone." "Allowance: the owner funds a vault contract and writes the spending policy on-chain." "The agent is a NEAR function-call key that lives on the vault account: it can call pay, nothing else," "and it cannot attach money. The protocol checks the key; the contract checks the money."`
Enter
Sleep 300ms
Show
Sleep 8s

# ---------------------------------------------------------------- start the live demo
Hide
Type "clear"
Enter
Sleep 300ms
Show
Type `make demo-manual > examples/local_demo/.tmp/demo.log 2>&1 &`
Enter
Sleep 2s

# ---------------------------------------------------------------- 1. owner sets the rules
Hide
Type `scene --title "1/7  The owner sets the rules" --note "Deploy and fund the vault, write the policy on-chain, register each agent as a function-call key on the vault" --from '^=== 2\.' --to 'token agent key' --drop '^===' --delay 120`
Enter
Wait+Screen /THE OWNER SETS/
Show
Wait
Sleep 7s

# ---------------------------------------------------------------- 2. the agent buys data
Hide
Type `scene --title "2/7  The agent buys data" --note "HTTP 402 with a price -> counterparty check -> free simulate -> pay from the vault -> the API verifies the receipt" --from 'task: daily candles' --to '=> delivered' --drop 'event |\[agent\] GET|\[agent\] $' --delay 220`
Enter
Wait+Screen /THE AGENT BUYS/
Show
Wait
Sleep 7s

# ---------------------------------------------------------------- 3. one counteroffer
Hide
Type `scene --title "3/7  Above its limit, it negotiates once" --note "simulate says NEEDS_APPROVAL; the agent offers its autonomous limit (0.5 NEAR) and the seller accepts" --from 'task: order-book' --to '=> delivered' --drop 'event |\[agent\] GET|\[agent\] $' --delay 200`
Enter
Wait+Screen /NEGOTIATES ONCE/
Show
Wait
Sleep 6s

# ---------------------------------------------------------------- 4. a human approves
Hide
Type `scene --title "4/7  A human approves" --note "The seller refuses the counteroffer: the 0.8 NEAR payment waits for the owner" --from 'task: a year of hourly' --to 'waiting for the owner' --drop 'event |\[agent\] GET|\[agent\] $' --delay 200`
Enter
Wait+Screen /A HUMAN APPROVES/
Show
Wait
Sleep 3s
Hide
Type `set -a; . examples/local_demo/.tmp/demo.env; set +a; clear`
Enter
Sleep 300ms
Show
Type "npx allowance ledger"
Enter
Wait
Sleep 7s
Type "npx allowance approve 0 --owner-key-file examples/local_demo/.tmp/owner-key.json"
Enter
Wait
Sleep 2s
Hide
Type `scene --title "4/7  Approved by the owner" --note "The contract checked the policy again at approval time and paid; the API verified the receipt and delivered" --from 'receipt #4: paid by' --to 'total spent' --delay 150`
Enter
Wait+Screen /APPROVED BY THE OWNER/
Show
Wait
Sleep 4s

# ---------------------------------------------------------------- 5. stablecoins
Hide
Type `scene --title "5/7  Stablecoins (NEP-141)" --note "A second agent pays 2 SUSD: the vault registers the API on the token (storage_deposit), then ft_transfer" --from '^=== 4b\.' --to 'now holds 2 SUSD' --keep 'HTTP 402|simulate|pay tx|ft_payee_registration|payment_paid|verified|holds' --delay 250`
Enter
Wait+Screen /STABLECOINS/
Show
Wait
Sleep 6s

# ---------------------------------------------------------------- 6. the attack
Hide
Type `scene --title "6/7  The attack" --note "A web page hides an instruction to pay an attacker. Even a compromised process that signs anyway moves no money" --from '^=== 5\.' --to 'vault available:' --drop '^===|event |agent key ed25519|counterparty-risk check on|\[agent\] GET' --delay 110`
Enter
Wait+Screen /THE ATTACK/
Show
Wait
Sleep 9s

# ---------------------------------------------------------------- 7. a business, not just a wallet
Hide
Type `scene --title "7/7  A business, not just a wallet" --note "The API keeps its revenue in its own vault; a revenue split forwards 10% to its data provider in the same transaction" --from '^=== 6\.' --to 'demo OK' --keep '^\[demo\]|\[agent\] (simulate|pay tx)|^checks|^  (ok|FAIL)|demo (OK|FAILED)' --delay 140`
Enter
Wait+Screen /NOT JUST A WALLET/
Show
Wait
Sleep 7s

# ---------------------------------------------------------------- kill switch
Hide
Type `card "Kill switch" "One command deletes every agent key from the vault account. The agent's next transaction is rejected by NEAR itself."`
Enter
Sleep 300ms
Show
Type "npx allowance kill --owner-key-file examples/local_demo/.tmp/owner-key.json"
Enter
Wait
Sleep 2s
Type "npx allowance pay --payee api.sandbox --amount 0.01 --force --key-file examples/local_demo/.tmp/agent-key.json"
Enter
Wait
Sleep 5s

# ---------------------------------------------------------------- close
Hide
Type `card "Allowance" "Policy on-chain, keys on NEAR, receipts anyone can verify." "Try it: clone the repository and run   make demo   (local sandbox, no account, no API key)." "MIT licensed. Built at NEAR HACKATHON."`
Enter
Sleep 300ms
Show
Sleep 6s

# ---------------------------------------------------------------- teardown (not recorded)
Hide
Type "kill -INT %1; wait"
Enter
Sleep 3s
