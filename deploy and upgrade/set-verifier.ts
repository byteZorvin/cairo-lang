import { Contract, Interface, VoidSigner, Wallet, ZeroHash } from "ethers";
import {
    PROXY_ABI,
    STARKNET_ABI,
    isDirectRun,
    makeProvider,
    makeSigner,
    parseOptions,
} from "./common.js";

const HELP = `Usage: npm run starknet:set-verifier:production -- [options]

Sets the Starknet SHARP verifier address through the upgraded proxy.

Read-only by default. To send setVerifierAddress, pass --execute and --confirm-proxy <proxy>.

Options:
  --rpc-url <url>              Defaults to RPC_URL or https://sepolia.drpc.org.
  --private-key <key>          Required with --execute. Can also use PRIVATE_KEY.
  --proxy <address>            Defaults to PROXY_ADDRESS or 0x7f12...a516.
  --verifier <address>         New verifier address. Can also use VERIFIER_ADDRESS.
  --expected-chain-id <id>     Defaults to 11155111.
  --caller <address>           Optional dry-run caller for governance/static-call checks.
  --execute                    Actually send setVerifierAddress.
  --confirm-proxy <address>    Required with --execute; must equal --proxy.`;

const FACT_REGISTRY_ABI = ["function isValid(bytes32 fact) view returns (bool)"];

type SetVerifierReport = {
    chainId: string;
    proxy: string;
    implementation: string;
    identify: string;
    isFrozen: boolean;
    isFinalized: boolean;
    currentVerifier: string;
    newVerifier: string;
    newVerifierIsValidZeroFact: boolean;
    caller?: string;
    callerIsStarknetGovernor?: boolean;
    staticCall?: "succeeded" | "skipped";
    staticCallDetail?: string;
    calldata: string;
};

export async function setVerifierProduction(): Promise<void> {
    const options = parseOptions(HELP);

    if (options.verifierAddress === undefined) {
        throw new Error("Missing --verifier <address> or VERIFIER_ADDRESS.");
    }

    if (options.execute) {
        const { provider, signer, address, chainId } = await makeSigner(options);
        const report = await buildSetVerifierReport(
            provider,
            chainId,
            options.proxyAddress,
            options.verifierAddress,
            address
        );
        printSetVerifierReport(report);

        if (report.callerIsStarknetGovernor !== true) {
            throw new Error(`${address} is not a Starknet governor on the proxy.`);
        }

        const starknet = new Contract(options.proxyAddress, STARKNET_ABI, signer);
        await starknet.setVerifierAddress.staticCall(options.verifierAddress);
        console.log("setVerifierAddress static call succeeded.");

        const tx = await starknet.setVerifierAddress(options.verifierAddress);
        await tx.wait();
        console.log(`setVerifierAddress tx: ${tx.hash}`);

        const updatedVerifier = await starknet.verifierAddress();

        if (updatedVerifier !== options.verifierAddress) {
            throw new Error(
                `Verifier mismatch after update: ${updatedVerifier} != ${options.verifierAddress}`
            );
        }

        console.log(`Verifier updated: ${updatedVerifier}`);
        return;
    }

    const { provider, chainId } = await makeProvider(options);
    const caller = options.caller ?? callerFromPrivateKey(options.privateKey);
    const report = await buildSetVerifierReport(
        provider,
        chainId,
        options.proxyAddress,
        options.verifierAddress,
        caller
    );
    printSetVerifierReport(report);
    console.log("Dry run only. Re-run with --execute and --confirm-proxy to set the verifier.");
}

async function buildSetVerifierReport(
    provider: Awaited<ReturnType<typeof makeProvider>>["provider"],
    chainId: bigint,
    proxyAddress: string,
    newVerifier: string,
    caller?: string
): Promise<SetVerifierReport> {
    const [proxyCode, verifierCode] = await Promise.all([
        provider.getCode(proxyAddress),
        provider.getCode(newVerifier),
    ]);

    if (proxyCode === "0x") {
        throw new Error(`No contract code at proxy address ${proxyAddress} on chain ${chainId}.`);
    }

    if (verifierCode === "0x") {
        throw new Error(`No contract code at new verifier address ${newVerifier}.`);
    }

    const proxy = new Contract(proxyAddress, PROXY_ABI, provider);
    const starknet = new Contract(proxyAddress, STARKNET_ABI, provider);
    const verifier = new Contract(newVerifier, FACT_REGISTRY_ABI, provider);
    const calldata = new Interface(STARKNET_ABI).encodeFunctionData("setVerifierAddress", [
        newVerifier,
    ]);

    let currentVerifier: string;
    let isFinalized: boolean;

    try {
        [currentVerifier, isFinalized] = await Promise.all([
            starknet.verifierAddress(),
            starknet.isFinalized(),
        ]);
    } catch (error) {
        throw new Error(
            "Proxy does not expose verifierAddress()/isFinalized() through the current " +
                "implementation. Run the implementation upgrade before setting the verifier. " +
                `Probe failed with: ${errorReason(error)}`
        );
    }

    if (currentVerifier === newVerifier) {
        throw new Error(`Verifier is already set to ${newVerifier}.`);
    }

    if (isFinalized) {
        throw new Error("Starknet implementation is finalized; setVerifierAddress will revert.");
    }

    let newVerifierIsValidZeroFact: boolean;

    try {
        newVerifierIsValidZeroFact = await verifier.isValid(ZeroHash);
    } catch (error) {
        throw new Error(
            `New verifier does not expose isValid(bytes32) as expected: ${errorReason(error)}`
        );
    }

    const [implementation, identify, isFrozen, callerIsStarknetGovernor] = await Promise.all([
        proxy.implementation(),
        starknet.identify(),
        starknet.isFrozen(),
        caller === undefined ? undefined : optionalStarknetGovernorCall(starknet, caller),
    ]);

    let staticCall: SetVerifierReport["staticCall"] = "skipped";
    let staticCallDetail = "no caller supplied";

    if (caller !== undefined) {
        const starknetAsCaller = new Contract(
            proxyAddress,
            STARKNET_ABI,
            new VoidSigner(caller, provider)
        );

        try {
            await starknetAsCaller.setVerifierAddress.staticCall(newVerifier);
            staticCall = "succeeded";
            staticCallDetail = "setVerifierAddress static call succeeded";
        } catch (error) {
            staticCallDetail = errorReason(error);
        }
    }

    return {
        chainId: chainId.toString(),
        proxy: proxyAddress,
        implementation,
        identify,
        isFrozen,
        isFinalized,
        currentVerifier,
        newVerifier,
        newVerifierIsValidZeroFact,
        caller,
        callerIsStarknetGovernor,
        staticCall,
        staticCallDetail,
        calldata,
    };
}

function printSetVerifierReport(report: SetVerifierReport): void {
    console.log("Set verifier preflight:");
    console.log(`  chainId: ${report.chainId}`);
    console.log(`  proxy: ${report.proxy}`);
    console.log(`  implementation: ${report.implementation}`);
    console.log(`  identify: ${report.identify}`);
    console.log(`  isFrozen: ${report.isFrozen}`);
    console.log(`  isFinalized: ${report.isFinalized}`);
    console.log(`  current verifier: ${report.currentVerifier}`);
    console.log(`  new verifier: ${report.newVerifier}`);
    console.log(`  new verifier isValid(0x00..00): ${report.newVerifierIsValidZeroFact}`);

    if (report.caller !== undefined) {
        console.log(`  caller: ${report.caller}`);
        console.log(`  starknetIsGovernor(caller): ${String(report.callerIsStarknetGovernor)}`);
    }

    console.log(`  static call: ${report.staticCall} (${report.staticCallDetail})`);
    console.log("Governance calldata:");
    console.log(`  setVerifierAddress(${report.newVerifier})`);
    console.log(`    to: ${report.proxy}`);
    console.log(`    data: ${report.calldata}`);
}

async function optionalStarknetGovernorCall(
    starknet: Contract,
    caller: string
): Promise<boolean | undefined> {
    try {
        return await starknet.starknetIsGovernor(caller);
    } catch {
        return undefined;
    }
}

function callerFromPrivateKey(privateKey?: string): string | undefined {
    if (privateKey === undefined) {
        return undefined;
    }

    return new Wallet(privateKey).address;
}

function errorReason(error: unknown): string {
    if (typeof error === "object" && error !== null) {
        const maybe = error as { shortMessage?: string; reason?: string; data?: string };
        return maybe.reason ?? maybe.shortMessage ?? maybe.data ?? "reverted";
    }

    return "reverted";
}

if (isDirectRun(import.meta.url)) {
    setVerifierProduction().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    });
}
