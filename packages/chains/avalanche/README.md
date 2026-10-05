# @rosen-chains/avalanche

`AvalancheChain` adapts the Rosen EVM transaction interface to native AVAX and
mapped standard ERC20 payments on Avalanche C-Chain. Use chain ID `43114n` for
mainnet or `43113n` for the optional Fuji profile,
with a matching `AvalancheRpcNetwork` instance.

The adapter constructs EVM type-2 payments, cold-storage transfers, manual
transfers and arbitrary orders for AVAX or one mapped ERC20 asset. It checks chain identity, the lock signer,
mapped assets, nonce, route data and fee policy. Confirmation and recovery use canonical
execution data qualified against the RPC adapter's finalized frontier.

Configure the native `avax` token with 18 decimals and its Ergo counterpart.
Operator lock addresses, signing parameters, token mappings and gas policy must
come from the bridge configuration. Each token set requires one native origin,
an unambiguous ERC20 contract identity and a supported Ergo counterpart. JOE is
the initial mainnet example. Conversion between shared and raw units must be
exact for transfers; balance accounting conservatively excludes dust.

An ERC20 payment calls `transfer(recipient, rawAmount)` with the event identifier
after the ABI arguments. Incoming token locks and outgoing payment completion
require one standard `Transfer` from the selected contract, with the exact signed
sender, recipient and raw amount bound to the canonical transaction and receipt.
`verifySettledPaymentEvidence` also requires the captured confirmation policy.
The Guard uses that predicate for observed completion and unsigned recovery,
and rechecks evidence before persistence. Fee-on-transfer and rebasing assets
need separate qualification; a successful receipt cannot override amount checks.

AVAX pays gas for every route. Mapped token funds and the raw AVAX gas reserve
are checked separately. The chain adapter supports ERC20 cold-storage, manual
and arbitrary transfers and exposes `verifySettledTokenEvidence` for their
purpose-specific proof. Guard service route authorization, SQLite and dedicated
PostgreSQL consumers have local token fixtures, including JOE recovery across a
database restart. Independent review and installed-service qualification remain
pending; those service routes remain disabled by default. Token issuance is
a Rosen deployment action.

Management transactions require the Guard's route policy and existing quorum
admission. Signing uses scanner-bound authority; submission uses
`submitAuthorizedTransaction` with fresh authorization at transport start.
Calling the legacy `submitTransaction` method for a management route is refused.
Recovery and completion require canonical settled execution of the same signed
body; an already observed transfer does not reopen submission. Guard management
flags are disabled by default. Supplying addresses alone does not enable them.

## Development

Run `npm run test -- --run`, `npm run coverage`, `npm run type-check` and
`npm run lint:check` from the package directory. Run `npm run build` to produce
the JavaScript and declarations in `dist`.
