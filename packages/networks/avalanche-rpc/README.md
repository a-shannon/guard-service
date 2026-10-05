# Avalanche RPC network

`AvalancheRpcNetwork` implements the EVM network interface for C-Chain. The
constructor requires chain ID `43113n` (Fuji) or `43114n` (mainnet).

Acceptance uses an explicit `finalized` block, bound to its canonical
by-number result. Transactions must match the requested hash, chain, block,
receipt and transaction index. A successful receipt above the captured
finalized frontier remains pending. Confirmation depth is calculated from
that frontier. Unavailable or contradictory RPC data raises an error; there
is no fallback to `latest` or a confirmation-count API.

The source contract is AvalancheGo v1.15.0 Helicon, commit
`70bd6d063b7343fd2cd8217200aaf77b57f19f68`: `vms/saevm/blocks/access.go`
distinguishes executed `latest` from settled `finalized`, and
`vms/saevm/sae/rpc/receipts.go` permits receipts before execution completes.

This adapter trusts the configured RPC source. It does not authenticate its
node software or prove consensus. Durable source identity, restart behavior
and service-level response to inconsistent observations require integration
with the operator and confirmation consumers. Errors here do not create a
persistent service hold.

Native balances, ERC20 balances, ERC20 `totalSupply` and nonce reads use the
captured finalized block and recheck its canonical identity. Token state must
be one exact unsigned 256-bit ABI word. No state read falls back to `latest`.
These values remain trusted RPC observations rather than consensus proofs.

`getSettledTransactionEvidence` exposes signed execution identity for native
payments and nonce-spender classification, including failed transactions.
`getSettledTransactionReceiptEvidence` additionally returns deeply copied,
immutable receipt and log fields, captured before subsequent asynchronous
canonical checks. It binds receipt sender and destination to the signed body.
The chain consumer must then verify the selected asset's execution policy:
receipt success alone does not establish an ERC20 payment.

Other token metadata methods remain inherited operational queries. The Service
binds balance and supply readers to its scanner's persisted safety state; the
adapter itself does not create or clear that state.
Gas estimation preserves sender, destination, data, value, nonce and chain ID.
Submission requires a signed transaction protected for the selected chain.

Fee estimation uses `eth_baseFee` and `eth_maxPriorityFeePerGas`, with a maximum
fee of twice the base-fee upper estimate plus the tip. Both quantities must be
canonical unsigned 256-bit hex values and the result must fit in 256 bits.
Legacy gas price is returned as null. These are estimates, not guaranteed
inclusion prices. The base-fee source is the pinned
`vms/saevm/sae/rpc/custom.go`; unavailable fee methods raise an error.
