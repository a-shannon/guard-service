# @rosen-chains/solana-rpc

Solana JSON-RPC read adapter for Rosen Guard. Integration is in progress.

Construct `SolanaRpcNetwork` with a `SolanaEventContext`, a block locator and
either an HTTP(S) `url` or a `transport` callback. The callback returns the
original JSON-RPC response text. An optional `getHistory` callback supplies the
historical SPL account state required by the event extractor. These callbacks
must establish the configured cluster and historical source authority; matching
RPC coordinates alone do not authenticate their source.

Block and transaction reads use the request-bound sessions from
`@rosen-chains/solana`. `getHeight` requests finalized block height, rather than
slot height. Responses are correlated to the request ID and limited to 1 MiB.
HTTP URLs with embedded credentials or schemes other than HTTP(S) are rejected.

`getTxConfirmation` reads the RPC signature-status envelope. Missing and failed
transactions return `-1`; a numeric confirmation count is returned when present.
A successful finalized status with a null count currently returns `1`. This
conservative placeholder has not been accepted as Rosen's confirmation policy
and does not satisfy a configured threshold above one. Production registration
must resolve that policy and validate it through the Guard consumer.

`getAddressAssets` requires `context.resolvedProfile.genesisHash`. It captures
that identity at construction and checks the endpoint's genesis hash before and
after a read. It requests finalized native balance and original Token Program
accounts in base64, validates every account and returns raw `bigint` amounts.
Guard's `AbstractChain` applies token selection and decimal wrapping afterward.
SPL identifiers bind the configured genesis hash, token program and mint.

The two balance responses must report the same context slot. The adapter tries
at most three complete pairs when valid responses report different slots.
Malformed records and transport failures reject immediately; they never produce
a partial native or token balance. Matching slots and genesis hashes do not
authenticate the endpoint or establish an atomic snapshot across RPC requests.

The returned SPL inventory excludes frozen accounts and wrapped SOL. Excluded
records still undergo complete binary validation. Token-2022 accounts are
outside the requested program and are rejected if returned. The inventory is
not a complete wallet balance or a proof that a payment can be sent: account
selection, consolidation, fees, rent and transaction construction require their
own checks.

`getTokenDetail` returns nine decimals for native SOL without an RPC read. For a
cluster-bound original SPL ID it validates a finalized 82-byte mint account,
checks cluster identity around the request and returns its decimal precision.
The mint address serves as its name; no display metadata is fetched. Wrapped SOL,
Token-2022 and identities from another cluster are unsupported.

Mempool queries and transaction submission still raise
`SOLANA_RPC_OPERATION_UNSUPPORTED`. The adapter cannot yet operate a complete
Guard payment flow. Asset-read failures raise `SOLANA_REQUEST_UNAVAILABLE` and
retain the underlying cause.

The companion Solana address codec, chain and Utils extractor contributions
must be built and installed together. Published extractor version `12.1.2` does
not include the Solana exports. Initial `0.0.0` packages require their ordered
initialization releases and a regenerated consumer lockfile before installation
from the registry. A dependency range alone cannot establish compatibility. Follow
the repository's ESM loader conventions and validate the complete built packages
in a clean consumer before release.

From the monorepo root, the focused checks are:

```sh
npm run test -w @rosen-chains/solana-rpc -- --run
npm run type-check -w @rosen-chains/solana-rpc
npm run lint:check -w @rosen-chains/solana-rpc
npm run build -w @rosen-chains/solana-rpc
```

These checks cover the adapter. They do not establish endpoint independence,
archival capacity, historical account provenance or operational activation.
