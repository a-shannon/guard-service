---
'@rosen-chains/ergo': minor
'@rosen-chains/ergo-explorer-network': patch
'@rosen-chains/ergo-node-network': patch
---

Add explicit Ergo transaction submission authorization at the final transport
adapter boundary, preserving legacy submissions and refusing unsupported networks.
