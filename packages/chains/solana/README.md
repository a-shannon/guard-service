# @rosen-chains/solana

Solana event request binding for Rosen Guard. The package is under development.

`createSolanaEventContext` connects an existing `SolanaRosenExtractor` to the
Guard lock-condition and serialization hooks. It captures the extractor's
resolved profile and binds each request to its exact enriched JSON, transaction
signature, containing block, slot and Rosen height. Numeric source text is
preserved, including values above JavaScript's safe integer range.

Use the context's extractor and both hooks together. A bound transaction is
valid only within the context that issued it. An unavailable or contradictory
observation raises an error for the caller to retry; a recognized non-deposit
returns `false` from the lock-condition hook.

`createSolanaEventRequestProducer` takes that context, an injected JSON-RPC
transport returning exact response text, and an optional historical-state port.
It requests finalized transaction and full-block observations, checks their
identities and agreement, and issues a transaction through the same context.
An available history result must contain both `extractorHistory` JSON text and
its `requestContext`: signature, slot, blockhash, blockHeight, transactionIndex
and genesis. The producer compares all six coordinates before joining history.
Missing SPL history remains unavailable at the extraction hook.

`createSolanaEventReadSession` is the event-scoped network-read primitive. It
takes the same context and transport plus an injected block locator returning
the captured genesis, slot, block hash, height and parent hash. It validates one
finalized full-block response and exposes transaction IDs, block info and the
transaction producer against that private snapshot. Create one session per
event verification; the primitive does not implement a shared cache or choose
the production locator authority.

`AbstractSolanaNetwork` captures the transport, history and locator callbacks
once, then creates a fresh read session for each event. `AbstractSolanaEventChain`
takes that network, chain configuration, token map and a real
`SolanaRosenExtractor`. It retains one context for both hooks, snapshots each
event before awaiting its session, and supplies the reader explicitly to
`AbstractChain.verifyEventWithReader`. Concurrent verifications keep their own
readers. Missing event membership returns `false`; unavailable session or
transaction state raises an error.

These abstract classes provide the event consumer for native SOL and original
SPL Token. Concrete adapters must implement the remaining network, payment,
signing and submission methods, and establish the locator/history authority.

Each RPC response is limited to 1 MiB, including the full-block response.
Responses above that limit are unavailable; operational capacity has not yet
been validated. Requested commitment and matching history coordinates establish
consistency checks, not independent source authentication or a finality proof.

This module requires the Solana extractor additions from the companion Utils
contribution and the explicit reader API from the companion AbstractChain
contribution. A dependency version alone does not establish that those APIs
are released. Release the compatible dependencies before publishing this
package, apply the dependency ranges produced by the changeset release process,
and validate their compiled exports together.

Request binding does not authenticate RPC or historical account data. A network
adapter must establish the configured source, canonical block and historical
state before supplying an observation. Signing, payment submission, continuous
history, recovery and service registration are separate integration work.
