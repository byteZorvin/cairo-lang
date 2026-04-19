import fs from "node:fs";
import { Interface } from "ethers";
import {
    DeploymentInfo,
    PROXY_ABI,
    compileStarknet,
    deployImplementation,
    executeUpgrade,
    isDirectRun,
    parseOptions,
    printPreflight,
    readDeploymentInfo,
    runProductionPreflight,
} from "./common.js";

const HELP = `Usage: npm run starknet:upgrade:production -- [options]

Production upgrade phase. Accepts --implementation, reads a deployment plan when explicitly
requested, or deploys the compiled implementation when --execute is set and no implementation is
supplied.

Read-only by default. To deploy and send addImplementation/upgradeTo, pass --execute
and --confirm-proxy <proxy>.

Options:
  --rpc-url <url>              Defaults to RPC_URL or https://sepolia.drpc.org.
  --private-key <key>          Required with --execute. Can also use PRIVATE_KEY.
  --proxy <address>            Defaults to PROXY_ADDRESS or 0x7f12...a516.
  --implementation <address>   Replacement implementation if not using deployment file.
  --deployment-file <path>     Defaults to deploy and upgrade/.production-deployment.json.
  --expected-chain-id <id>     Defaults to 11155111.
  --execute                    Actually send the upgrade transactions.
  --confirm-proxy <address>    Required with --execute; must equal --proxy.
  --finalize                   Use finalize=true. Default false.`;

export async function upgradeProduction(
    deploymentOverride?: DeploymentInfo
): Promise<DeploymentInfo | undefined> {
    const options = parseOptions(HELP);
    const artifact = compileStarknet();
    const deployment = deploymentOverride ?? loadDeployment(options);
    const preflight = await runProductionPreflight(options, artifact, deployment?.replacementImplementation);
    printPreflight(preflight);

    let effectiveDeployment: DeploymentInfo | undefined;

    if (deployment !== undefined) {
        effectiveDeployment = {
            ...deployment,
            chainId: preflight.chainId,
            proxy: options.proxyAddress,
            upgradeInitData: preflight.upgradeInitData,
            finalize: options.finalize || deployment.finalize,
            preflight,
        };
    } else if (options.execute) {
        const implementation = await deployImplementation(options, artifact);
        const postDeployPreflight = await runProductionPreflight(options, artifact, implementation);
        printPreflight(postDeployPreflight);

        effectiveDeployment = {
            chainId: postDeployPreflight.chainId,
            deployer: postDeployPreflight.caller ?? "unknown",
            proxy: options.proxyAddress,
            replacementImplementation: implementation,
            upgradeInitData: postDeployPreflight.upgradeInitData,
            finalize: options.finalize,
            preflight: postDeployPreflight,
        };
    }

    if (effectiveDeployment === undefined) {
        console.log(
            "Dry run only. No replacement implementation was supplied, so no governance calldata " +
                "can be produced before deployment. Re-run with --execute and --confirm-proxy to deploy and upgrade."
        );
        return undefined;
    }

    if (!options.execute) {
        printUpgradeCalldata(effectiveDeployment);
        console.log("Dry run only. Re-run with --execute and --confirm-proxy to upgrade.");
        return effectiveDeployment;
    }

    const postState = await executeUpgrade(options, effectiveDeployment);
    console.log("Post-upgrade values:");
    console.log(`  identify: ${postState.identify}`);
    console.log(`  programHash: ${postState.programHash}`);
    console.log(`  aggregatorProgramHash: ${postState.aggregatorProgramHash}`);
    console.log(`  configHash: ${postState.configHash}`);
    console.log(`  stateRoot: ${postState.stateRoot}`);
    console.log(`  stateBlockNumber: ${postState.stateBlockNumber}`);
    console.log(`  stateBlockHash: ${postState.stateBlockHash}`);
    console.log(`  verifierAddress: ${postState.verifierAddress}`);
    return effectiveDeployment;
}

function printUpgradeCalldata(deployment: DeploymentInfo): void {
    const proxyInterface = new Interface(PROXY_ABI);
    const addImplementationCalldata = proxyInterface.encodeFunctionData("addImplementation", [
        deployment.replacementImplementation,
        deployment.upgradeInitData,
        deployment.finalize,
    ]);
    const upgradeToCalldata = proxyInterface.encodeFunctionData("upgradeTo", [
        deployment.replacementImplementation,
        deployment.upgradeInitData,
        deployment.finalize,
    ]);

    console.log("Governance calldata:");
    console.log(`  addImplementation(${deployment.replacementImplementation}, initData, ${deployment.finalize})`);
    console.log(`    to: ${deployment.proxy}`);
    console.log(`    data: ${addImplementationCalldata}`);
    console.log(`  upgradeTo(${deployment.replacementImplementation}, initData, ${deployment.finalize})`);
    console.log(`    to: ${deployment.proxy}`);
    console.log(`    data: ${upgradeToCalldata}`);
}

function loadDeployment(options: ReturnType<typeof parseOptions>): DeploymentInfo | undefined {
    if (options.implementationAddress !== undefined) {
        return {
            chainId: "",
            deployer: "",
            proxy: options.proxyAddress,
            replacementImplementation: options.implementationAddress,
            upgradeInitData: "",
            finalize: options.finalize,
            preflight: {} as DeploymentInfo["preflight"],
        };
    }

    if (options.deploymentFileExplicit && fs.existsSync(options.deploymentFile)) {
        return readDeploymentInfo(options.deploymentFile);
    }

    return undefined;
}

if (isDirectRun(import.meta.url)) {
    upgradeProduction().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    });
}
