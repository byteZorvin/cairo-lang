# Starknet Production Upgrade

This folder contains TypeScript scripts for upgrading an existing Starknet proxy. The current
upgrade introduces a governed verifier setter on the Starknet implementation:

```text
setVerifierAddress(address)
```

Important distinction:

- **Production:** run only the upgrade script. It can deploy the new implementation itself and then
  upgrade the proxy in the same run.
- **Simulation/testing:** use the deployment helper to deploy an implementation and create a local
  deployment plan.

Default production target:

```text
proxy: 0x7f12e0bbd1001a2eba8b79cd6d641f1c780ca516
chain: Sepolia (11155111)
```

Production commands:

```bash
npm run starknet:upgrade:production
npm run starknet:set-verifier:production
```

Simulation command:

```bash
npm run starknet:simulate:deploy
npm run starknet:simulate:upgrade
```

The production upgrade script is read-only by default. It only sends transactions when both flags
are present:

```bash
--execute --confirm-proxy 0x7f12e0bbd1001a2eba8b79cd6d641f1c780ca516
```

Production deploy-and-upgrade:

```bash
RPC_URL=... PRIVATE_KEY=... npm run starknet:upgrade:production -- \
  --execute \
  --confirm-proxy 0x7f12e0bbd1001a2eba8b79cd6d641f1c780ca516
```

Production upgrade with an already deployed implementation:

```bash
RPC_URL=... PRIVATE_KEY=... npm run starknet:upgrade:production -- \
  --implementation 0x... \
  --execute \
  --confirm-proxy 0x7f12e0bbd1001a2eba8b79cd6d641f1c780ca516
```

Dry-run for multisig/cold-wallet review:

```bash
RPC_URL=... npm run starknet:upgrade:production -- \
  --implementation 0x...
```

In dry-run mode with an implementation address, the upgrade script prints exact governance calldata
for:

- `addImplementation(address,bytes,bool)`
- `upgradeTo(address,bytes,bool)`

In dry-run mode without an implementation address, the script only performs the current proxy
preflight. It cannot print governance calldata until the replacement implementation is deployed.

The upgrade itself does not change the verifier. After the implementation upgrade is live, a
Starknet governor can separately call `setVerifierAddress(address)` through the proxy to point at
the new verifier contract.

Set the verifier after the implementation upgrade:

```bash
RPC_URL=... PRIVATE_KEY=... npm run starknet:set-verifier:production -- \
  --verifier 0xf5737beb74f5a12e212008f2625367d5a504ebfb \
  --execute \
  --confirm-proxy 0x7f12e0bbd1001a2eba8b79cd6d641f1c780ca516
```

Dry-run verifier calldata:

```bash
RPC_URL=... npm run starknet:set-verifier:production -- \
  --verifier 0xf5737beb74f5a12e212008f2625367d5a504ebfb
```

Simulation deployment:

```bash
RPC_URL=... PRIVATE_KEY=... npm run starknet:simulate:deploy -- \
  --execute \
  --confirm-proxy 0x...
```

End-to-end simulation:

```bash
RPC_URL=... PRIVATE_KEY=... npm run starknet:simulate:upgrade -- \
  --execute \
  --confirm-proxy 0x...
```

The simulation deployment helper writes `deploy and upgrade/.production-deployment.json`. This file
can be consumed by `upgrade.ts` in non-production testing by passing it explicitly with
`--deployment-file`.

Preflight checks include:

- Target chain id.
- Proxy code presence.
- Proxy version, current implementation, finalization flag, and upgrade delay.
- Current implementation code presence and `isFrozen()`.
- Starknet read values through the proxy.
- Current verifier address read directly from the Starknet named storage slot.
- Function selector probes for proxy read/write methods.
- Replacement implementation code presence, `identify()`, and `isFrozen()` when provided.
- Replacement implementation exposure of `verifierAddress()` and governance-gated
  `setVerifierAddress(address)` when provided.
- Upgrade initializer derived from live state.

For an already initialized Starknet proxy, the computed upgrade initializer is:

```text
0x0000000000000000000000000000000000000000000000000000000000000000
```

That is `abi.encode(address(0))`, meaning no external initializer and no reinitialization payload.
