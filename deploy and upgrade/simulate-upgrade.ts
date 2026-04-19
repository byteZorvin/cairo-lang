import {
    DeploymentInfo,
    isDirectRun,
} from "./common.js";
import { simulateDeploy } from "./simulate-deploy.js";
import { upgradeProduction } from "./upgrade.js";

const HELP = `Usage: npm run starknet:simulate:upgrade -- [options]

Simulation-only end-to-end helper. Deploys a replacement implementation and then runs the
upgrade script with the resulting deployment plan.

Do not use this in production. Production should run only:
  npm run starknet:upgrade:production -- --implementation <address>

Options are shared with simulate-deploy.ts and upgrade.ts:
  --rpc-url <url>
  --private-key <key>
  --proxy <address>
  --deployment-file <path>
  --expected-chain-id <id>
  --execute
  --confirm-proxy <address>
  --finalize`;

export async function simulateUpgrade(): Promise<DeploymentInfo | undefined> {
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
        console.log(HELP);
        return undefined;
    }

    const deployment = await simulateDeploy();

    if (deployment === undefined) {
        console.log("Deployment dry-run complete. Re-run with --execute to run the full simulation.");
        return undefined;
    }

    return upgradeProduction(deployment);
}

if (isDirectRun(import.meta.url)) {
    simulateUpgrade().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    });
}
