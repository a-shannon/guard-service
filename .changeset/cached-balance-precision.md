---
'guard-service': patch
---

Store cached asset balances as exact decimal text and migrate existing integer
values without passing them through JavaScript floating-point numbers.
