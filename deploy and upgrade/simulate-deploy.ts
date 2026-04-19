import {
    DeploymentInfo,
    compileStarknet,
    deployImplementation,
    isDirectRun,
    parseOptions,
    printPreflight,
    runProductionPreflight,
    writeDeploymentInfo,
} from "./common.js";

const HELP = `Usage: npm run starknet:simulate:deploy -- [options]

Simulation-only deployment helper for Starknet implementation upgrades.

This script is for local/test simulation or for preparing a deployment plan in non-production
environments. The current production workflow should not run this script; production should run
only upgrade.ts against an already deployed implementation address.

Default target:
  proxy: 0x7f12e0bbd1001a2eba8b79cd6d641f1c780ca516
  chain: Sepolia (11155111)

Read-only by default. To deploy in a simulation environment, pass --execute and --confirm-proxy
<proxy>.

Options:
  --rpc-url <url>              Defaults to RPC_URL or https://sepolia.drpc.org.
  --private-key <key>          Required with --execute. Can also use PRIVATE_KEY.
  --proxy <address>            Defaults to PROXY_ADDRESS or the target proxy above.
  --deployment-file <path>     Defaults to deploy and upgrade/.production-deployment.json.
  --expected-chain-id <id>     Defaults to 11155111.
  --execute                    Actually deploy the implementation in the selected environment.
  --confirm-proxy <address>    Required with --execute; must equal --proxy.
  --finalize                   Store finalize=true for the upgrade plan. Default false.`;

export async function simulateDeploy(): Promise<DeploymentInfo | undefined> {
    const options = parseOptions(HELP);
    const artifact = compileStarknet();
    const preflight = await runProductionPreflight(options, artifact);
    printPreflight(preflight);

    if (!preflight.localRuntimeMatchesCurrentImplementation) {
        console.log(
            "Local Starknet runtime differs from the current implementation. This is a real code upgrade."
        );
    }

    if (!options.execute) {
        console.log("Dry run only. Re-run with --execute and --confirm-proxy to simulate deployment.");
        return undefined;
    }

    const implementation = await deployImplementation(options, artifact);
    const postDeployPreflight = await runProductionPreflight(options, artifact, implementation);
    printPreflight(postDeployPreflight);

    const deployment: DeploymentInfo = {
        chainId: postDeployPreflight.chainId,
        deployer: postDeployPreflight.caller ?? "unknown",
        proxy: options.proxyAddress,
        replacementImplementation: implementation,
        upgradeInitData: postDeployPreflight.upgradeInitData,
        finalize: options.finalize,
        preflight: postDeployPreflight,
    };

    writeDeploymentInfo(options.deploymentFile, deployment);
    console.log(`Wrote deployment plan: ${options.deploymentFile}`);
    return deployment;
}

if (isDirectRun(import.meta.url)) {
    simulateDeploy().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    });
}
