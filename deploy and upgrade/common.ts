import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import solc from "solc";
import {
    AbiCoder,
    Contract,
    ContractFactory,
    FunctionFragment,
    Interface,
    JsonRpcProvider,
    NonceManager,
    VoidSigner,
    Wallet,
    ZeroAddress,
    getAddress,
    id,
    keccak256,
    toUtf8Bytes,
} from "ethers";
import type { InterfaceAbi } from "ethers";

export type ContractArtifact = {
    abi: InterfaceAbi;
    bytecode: string;
    runtimeBytecode: string;
    runtimeHash: string;
};

export type Options = {
    rpcUrl: string;
    privateKey?: string;
    proxyAddress: string;
    implementationAddress?: string;
    verifierAddress?: string;
    deploymentFile: string;
    deploymentFileExplicit: boolean;
    expectedChainId?: bigint;
    execute: boolean;
    confirmProxy?: string;
    finalize: boolean;
    caller?: string;
};

export type StarknetStateSnapshot = {
    identify: string;
    programHash: string;
    aggregatorProgramHash: string;
    configHash: string;
    stateRoot: string;
    stateBlockNumber: string;
    stateBlockHash: string;
    feeCollector: string;
    verifierAddress: string;
    messageCancellationDelay: string;
    l1ToL2MessageNonce: string;
};

export type PreflightReport = {
    chainId: string;
    proxyAddress: string;
    proxyVersion: string;
    currentImplementation: string;
    currentImplementationCodeHash: string;
    localRuntimeHash: string;
    localRuntimeMatchesCurrentImplementation: boolean;
    upgradeActivationDelay: string;
    enableWindowDuration?: string;
    isNotFinalized: boolean;
    currentImplementationFrozen: boolean;
    caller?: string;
    callerIsProxyGovernor?: boolean;
    callerIsUpgradeGovernor?: boolean;
    starknetState: StarknetStateSnapshot;
    upgradeInitData: string;
    selectorChecks: SelectorCheck[];
};

export type SelectorCheck = {
    signature: string;
    selector: string;
    status: "matched" | "reverted-as-expected";
    detail: string;
};

export type DeploymentInfo = {
    chainId: string;
    deployer: string;
    proxy: string;
    replacementImplementation: string;
    upgradeInitData: string;
    finalize: boolean;
    preflight: PreflightReport;
};

const DEFAULT_PROXY_ADDRESS = "0x7f12e0bbd1001a2eba8b79cd6d641f1c780ca516";
const DEFAULT_RPC_URL = "https://sepolia.drpc.org";
const DEFAULT_EXPECTED_CHAIN_ID = 11155111n;
const EXPECTED_IDENTIFY = "StarkWare_Starknet_2025_10";
const VERIFIER_ADDRESS_TAG = "STARKNET_1.0_INIT_VERIFIER_ADDRESS";
const VERIFIER_GETTER_SIGNATURE = "verifierAddress()";
const SET_VERIFIER_SIGNATURE = "setVerifierAddress(address)";
const SELECTOR_PROBE_CALLER = "0x000000000000000000000000000000000000dEaD";

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
export const STARKNET_SOURCE_NAME = "starkware/starknet/solidity/Starknet.sol";
export const DEFAULT_DEPLOYMENT_FILE = path.join(SCRIPT_DIR, ".production-deployment.json");
export const ZERO_ADDRESS_WORD = AbiCoder.defaultAbiCoder().encode(["address"], [ZeroAddress]);

export const PROXY_ABI = [
    "function implementation() view returns (address)",
    "function PROXY_VERSION() view returns (string)",
    "function getUpgradeActivationDelay() view returns (uint256)",
    "function getEnableWindowDuration() view returns (uint256)",
    "function isNotFinalized() view returns (bool)",
    "function proxyIsGovernor(address) view returns (bool)",
    "function isUpgradeGovernor(address) view returns (bool)",
    "function addImplementation(address newImplementation, bytes data, bool finalize)",
    "function upgradeTo(address newImplementation, bytes data, bool finalize) payable",
];

export const STARKNET_ABI = [
    "function identify() view returns (string)",
    "function programHash() view returns (uint256)",
    "function aggregatorProgramHash() view returns (uint256)",
    "function configHash() view returns (uint256)",
    "function stateRoot() view returns (uint256)",
    "function stateBlockNumber() view returns (int256)",
    "function stateBlockHash() view returns (uint256)",
    "function feeCollector() view returns (address)",
    "function verifierAddress() view returns (address)",
    "function messageCancellationDelay() view returns (uint256)",
    "function l1ToL2MessageNonce() view returns (uint256)",
    "function setVerifierAddress(address newVerifierAddress)",
    "function starknetIsGovernor(address user) view returns (bool)",
    "function isFinalized() view returns (bool)",
    "function isFrozen() view returns (bool)",
];

export function parseOptions(helpText: string): Options {
    const args = process.argv.slice(2);
    const options: Options = {
        rpcUrl: process.env.RPC_URL ?? DEFAULT_RPC_URL,
        privateKey: process.env.PRIVATE_KEY,
        proxyAddress: normalizeAddress(process.env.PROXY_ADDRESS ?? DEFAULT_PROXY_ADDRESS),
        implementationAddress: process.env.IMPLEMENTATION_ADDRESS
            ? normalizeAddress(process.env.IMPLEMENTATION_ADDRESS)
            : undefined,
        verifierAddress: process.env.VERIFIER_ADDRESS
            ? normalizeAddress(process.env.VERIFIER_ADDRESS)
            : process.env.NEW_VERIFIER_ADDRESS
              ? normalizeAddress(process.env.NEW_VERIFIER_ADDRESS)
              : undefined,
        deploymentFile: process.env.DEPLOYMENT_FILE ?? DEFAULT_DEPLOYMENT_FILE,
        deploymentFileExplicit: process.env.DEPLOYMENT_FILE !== undefined,
        expectedChainId: process.env.EXPECTED_CHAIN_ID
            ? BigInt(process.env.EXPECTED_CHAIN_ID)
            : DEFAULT_EXPECTED_CHAIN_ID,
        execute: process.env.EXECUTE === "1",
        confirmProxy: process.env.CONFIRM_PROXY
            ? normalizeAddress(process.env.CONFIRM_PROXY)
            : undefined,
        finalize: process.env.FINALIZE === "1",
        caller: process.env.CALLER_ADDRESS ? normalizeAddress(process.env.CALLER_ADDRESS) : undefined,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const next = args[i + 1];

        if (arg === "--rpc-url" && next !== undefined) {
            options.rpcUrl = next;
            i++;
            continue;
        }

        if (arg === "--private-key" && next !== undefined) {
            options.privateKey = next;
            i++;
            continue;
        }

        if (arg === "--proxy" && next !== undefined) {
            options.proxyAddress = normalizeAddress(next);
            i++;
            continue;
        }

        if (arg === "--implementation" && next !== undefined) {
            options.implementationAddress = normalizeAddress(next);
            i++;
            continue;
        }

        if ((arg === "--verifier" || arg === "--new-verifier") && next !== undefined) {
            options.verifierAddress = normalizeAddress(next);
            i++;
            continue;
        }

        if (arg === "--deployment-file" && next !== undefined) {
            options.deploymentFile = path.resolve(next);
            options.deploymentFileExplicit = true;
            i++;
            continue;
        }

        if (arg === "--expected-chain-id" && next !== undefined) {
            options.expectedChainId = BigInt(next);
            i++;
            continue;
        }

        if (arg === "--caller" && next !== undefined) {
            options.caller = normalizeAddress(next);
            i++;
            continue;
        }

        if (arg === "--execute") {
            options.execute = true;
            continue;
        }

        if (arg === "--confirm-proxy" && next !== undefined) {
            options.confirmProxy = normalizeAddress(next);
            i++;
            continue;
        }

        if (arg === "--finalize") {
            options.finalize = true;
            continue;
        }

        if (arg === "--help" || arg === "-h") {
            console.log(helpText);
            process.exit(0);
        }

        throw new Error(`Unknown or incomplete argument: ${arg}`);
    }

    return options;
}

export async function makeProvider(options: Options): Promise<{
    provider: JsonRpcProvider;
    chainId: bigint;
}> {
    const provider = new JsonRpcProvider(options.rpcUrl, undefined, { batchMaxCount: 1 });
    const network = await provider.getNetwork();

    if (options.expectedChainId !== undefined && network.chainId !== options.expectedChainId) {
        throw new Error(
            `Unexpected chain id ${network.chainId.toString()}; expected ` +
                `${options.expectedChainId.toString()}. Use --expected-chain-id to override.`
        );
    }

    return { provider, chainId: network.chainId };
}

export async function makeSigner(options: Options): Promise<{
    provider: JsonRpcProvider;
    signer: NonceManager;
    address: string;
    chainId: bigint;
}> {
    requireExecutionConfirmation(options);

    if (options.privateKey === undefined) {
        throw new Error("PRIVATE_KEY or --private-key is required when --execute is set.");
    }

    const { provider, chainId } = await makeProvider(options);
    const wallet = new Wallet(options.privateKey, provider);
    const signer = new NonceManager(wallet);

    return {
        provider,
        signer,
        address: await wallet.getAddress(),
        chainId,
    };
}

export function compileStarknet(): ContractArtifact {
    const input = {
        language: "Solidity",
        sources: {
            [STARKNET_SOURCE_NAME]: { content: readSource(STARKNET_SOURCE_NAME) },
        },
        settings: {
            optimizer: { enabled: true, runs: 200 },
            evmVersion: "cancun",
            outputSelection: {
                "*": {
                    "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"],
                },
            },
        },
    };

    const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

    for (const error of output.errors ?? []) {
        if (error.severity === "error") {
            throw new Error(error.formattedMessage);
        }
    }

    const starknet = output.contracts?.[STARKNET_SOURCE_NAME]?.Starknet;

    if (starknet === undefined) {
        throw new Error("Compilation succeeded but Starknet artifact was not produced.");
    }

    const abi = starknet.abi as InterfaceAbi;
    assertAbiHasFunction(abi, SET_VERIFIER_SIGNATURE);
    assertAbiHasFunction(abi, VERIFIER_GETTER_SIGNATURE);

    const bytecode = `0x${starknet.evm.bytecode.object}`;
    const runtimeBytecode = `0x${starknet.evm.deployedBytecode.object}`;

    if (bytecode === "0x" || runtimeBytecode === "0x") {
        throw new Error("Compiled Starknet artifact has empty bytecode.");
    }

    return {
        abi,
        bytecode,
        runtimeBytecode,
        runtimeHash: keccak256(runtimeBytecode),
    };
}

export async function runProductionPreflight(
    options: Options,
    artifact: ContractArtifact,
    implementationAddress?: string
): Promise<PreflightReport> {
    const { provider, chainId } = await makeProvider(options);
    const proxyCode = await provider.getCode(options.proxyAddress);

    if (proxyCode === "0x") {
        throw new Error(`No contract code at proxy address ${options.proxyAddress} on chain ${chainId}.`);
    }

    const caller = options.caller ?? callerFromPrivateKey(options.privateKey);
    const proxyRunner = caller === undefined ? provider : new VoidSigner(caller, provider);
    const proxy = new Contract(options.proxyAddress, PROXY_ABI, proxyRunner);
    const starknet = new Contract(options.proxyAddress, STARKNET_ABI, provider);

    const [
        proxyVersion,
        currentImplementation,
        upgradeActivationDelay,
        isNotFinalized,
        starknetState,
    ] = await Promise.all([
        proxy.PROXY_VERSION(),
        proxy.implementation(),
        proxy.getUpgradeActivationDelay(),
        proxy.isNotFinalized(),
        readStarknetState(starknet, provider, options.proxyAddress),
    ]);

    const normalizedImplementation = normalizeAddress(currentImplementation);
    const currentImplementationCode = await provider.getCode(normalizedImplementation);

    if (currentImplementationCode === "0x") {
        throw new Error(`Current implementation has no code: ${normalizedImplementation}`);
    }

    const implementation = new Contract(normalizedImplementation, STARKNET_ABI, provider);
    const currentImplementationFrozen = await starknet.isFrozen();
    const implementationIdentify = await implementation.identify();
    const enableWindowDuration = await optionalCall<bigint>(proxy, "getEnableWindowDuration");
    const callerIsProxyGovernor =
        caller === undefined ? undefined : await optionalRoleCall(proxy, "proxyIsGovernor", caller);
    const callerIsUpgradeGovernor =
        caller === undefined ? undefined : await optionalRoleCall(proxy, "isUpgradeGovernor", caller);

    assertEqual(implementationIdentify, EXPECTED_IDENTIFY, "current implementation identify()");
    assertEqual(starknetState.identify, EXPECTED_IDENTIFY, "proxy identify()");
    assertTruthy(isNotFinalized, "proxy must not be finalized");
    assertTruthy(!currentImplementationFrozen, "current implementation must not be frozen");
    assertNonZero(starknetState.programHash, "programHash()");
    assertNonZero(starknetState.aggregatorProgramHash, "aggregatorProgramHash()");
    assertNonZero(starknetState.configHash, "configHash()");
    assertNonZero(starknetState.stateRoot, "stateRoot()");
    assertNotZeroAddress(starknetState.verifierAddress, "verifier address storage");

    const upgradeInitData = ZERO_ADDRESS_WORD;
    const selectorChecks = await verifySelectors(
        proxy,
        implementationAddress ?? normalizedImplementation,
        upgradeInitData,
        options.finalize
    );

    if (implementationAddress !== undefined) {
        selectorChecks.push(...(await verifyReplacementImplementation(provider, implementationAddress)));
    }

    return {
        chainId: chainId.toString(),
        proxyAddress: options.proxyAddress,
        proxyVersion,
        currentImplementation: normalizedImplementation,
        currentImplementationCodeHash: keccak256(currentImplementationCode),
        localRuntimeHash: artifact.runtimeHash,
        localRuntimeMatchesCurrentImplementation: keccak256(currentImplementationCode) === artifact.runtimeHash,
        upgradeActivationDelay: upgradeActivationDelay.toString(),
        enableWindowDuration: enableWindowDuration?.toString(),
        isNotFinalized,
        currentImplementationFrozen,
        caller,
        callerIsProxyGovernor,
        callerIsUpgradeGovernor,
        starknetState,
        upgradeInitData,
        selectorChecks,
    };
}

export async function deployImplementation(options: Options, artifact: ContractArtifact): Promise<string> {
    const { signer, address, chainId } = await makeSigner(options);
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);

    console.log(`Deploying Starknet implementation on chain ${chainId.toString()} from ${address}.`);
    const contract = await factory.deploy();
    const deployment = await contract.waitForDeployment();
    const implementation = await deployment.getAddress();
    console.log(`Starknet implementation deployed: ${implementation}`);

    return implementation;
}

export async function executeUpgrade(
    options: Options,
    deployment: DeploymentInfo
): Promise<StarknetStateSnapshot> {
    const { provider, signer, address } = await makeSigner(options);
    const proxy = new Contract(deployment.proxy, PROXY_ABI, signer);
    const starknet = new Contract(deployment.proxy, STARKNET_ABI, signer);
    const preState = await readStarknetState(starknet, provider, deployment.proxy);
    const callerIsProxyGovernor = await optionalRoleCall(proxy, "proxyIsGovernor", address);
    const callerIsUpgradeGovernor = await optionalRoleCall(proxy, "isUpgradeGovernor", address);

    if (callerIsProxyGovernor === false && callerIsUpgradeGovernor === false) {
        throw new Error(`${address} is not authorized by the proxy governance checks.`);
    }

    const addTx = await proxy.addImplementation(
        deployment.replacementImplementation,
        deployment.upgradeInitData,
        deployment.finalize
    );
    await addTx.wait();
    console.log(`addImplementation tx: ${addTx.hash}`);

    const delay = BigInt(deployment.preflight.upgradeActivationDelay);

    if (delay > 0n) {
        console.log(
            `Upgrade delay is ${delay.toString()} seconds. Candidate was added; run upgrade.ts again after activation.`
        );
        return preState;
    }

    await proxy.upgradeTo.staticCall(
        deployment.replacementImplementation,
        deployment.upgradeInitData,
        deployment.finalize
    );
    console.log("upgradeTo static call succeeded.");

    const upgradeTx = await proxy.upgradeTo(
        deployment.replacementImplementation,
        deployment.upgradeInitData,
        deployment.finalize
    );
    await upgradeTx.wait();
    console.log(`upgradeTo tx: ${upgradeTx.hash}`);

    const activeImplementation = normalizeAddress(await proxy.implementation());

    if (activeImplementation !== normalizeAddress(deployment.replacementImplementation)) {
        throw new Error(
            `Proxy implementation mismatch after upgrade: ${activeImplementation} != ` +
                normalizeAddress(deployment.replacementImplementation)
        );
    }

    const postState = await readStarknetState(starknet, provider, deployment.proxy);
    assertStatePreserved(preState, postState);
    console.log("Post-upgrade state preservation checks passed.");

    return postState;
}

export function writeDeploymentInfo(filePath: string, deployment: DeploymentInfo): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(deployment, null, 2)}\n`);
}

export function readDeploymentInfo(filePath: string): DeploymentInfo {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as DeploymentInfo;
}

export function printPreflight(report: PreflightReport): void {
    console.log("Production preflight:");
    console.log(`  chainId: ${report.chainId}`);
    console.log(`  proxy: ${report.proxyAddress}`);
    console.log(`  proxy version: ${report.proxyVersion}`);
    console.log(`  current implementation: ${report.currentImplementation}`);
    console.log(`  current implementation code hash: ${report.currentImplementationCodeHash}`);
    console.log(`  local Starknet runtime hash: ${report.localRuntimeHash}`);
    console.log(`  local runtime matches current implementation: ${report.localRuntimeMatchesCurrentImplementation}`);
    console.log(`  upgrade delay: ${report.upgradeActivationDelay}`);
    console.log(`  enable window duration: ${report.enableWindowDuration ?? "not exposed by proxy"}`);
    console.log(`  isNotFinalized: ${report.isNotFinalized}`);
    console.log(`  current implementation frozen: ${report.currentImplementationFrozen}`);

    if (report.caller !== undefined) {
        console.log(`  caller: ${report.caller}`);
        console.log(`  proxyIsGovernor(caller): ${String(report.callerIsProxyGovernor)}`);
        console.log(`  isUpgradeGovernor(caller): ${String(report.callerIsUpgradeGovernor)}`);
    }

    console.log("  Starknet state:");
    console.log(`    identify: ${report.starknetState.identify}`);
    console.log(`    programHash: ${report.starknetState.programHash}`);
    console.log(`    aggregatorProgramHash: ${report.starknetState.aggregatorProgramHash}`);
    console.log(`    configHash: ${report.starknetState.configHash}`);
    console.log(`    stateRoot: ${report.starknetState.stateRoot}`);
    console.log(`    stateBlockNumber: ${report.starknetState.stateBlockNumber}`);
    console.log(`    stateBlockHash: ${report.starknetState.stateBlockHash}`);
    console.log(`    feeCollector: ${report.starknetState.feeCollector}`);
    console.log(`    verifierAddress: ${report.starknetState.verifierAddress}`);
    console.log(`    messageCancellationDelay: ${report.starknetState.messageCancellationDelay}`);
    console.log(`    l1ToL2MessageNonce: ${report.starknetState.l1ToL2MessageNonce}`);
    console.log(`  computed upgrade init data: ${report.upgradeInitData}`);
    console.log("  selector checks:");

    for (const check of report.selectorChecks) {
        console.log(`    ${check.selector} ${check.signature}: ${check.status} (${check.detail})`);
    }
}

export function isDirectRun(metaUrl: string): boolean {
    const entry = process.argv[1];
    return entry !== undefined && metaUrl === pathToFileURL(path.resolve(entry)).href;
}

function requireExecutionConfirmation(options: Options): void {
    if (!options.execute) {
        throw new Error("Internal error: execution attempted without --execute.");
    }

    if (options.confirmProxy !== options.proxyAddress) {
        throw new Error(
            `Refusing to execute. Pass --confirm-proxy ${options.proxyAddress} to confirm target.`
        );
    }
}

async function readStarknetState(
    starknet: Contract,
    provider: JsonRpcProvider,
    proxyAddress: string
): Promise<StarknetStateSnapshot> {
    const [
        identifyResult,
        programHash,
        aggregatorProgramHash,
        configHash,
        stateRoot,
        stateBlockNumber,
        stateBlockHash,
        feeCollector,
        verifierAddress,
        messageCancellationDelay,
        l1ToL2MessageNonce,
    ] = await Promise.all([
        starknet.identify(),
        starknet.programHash(),
        starknet.aggregatorProgramHash(),
        starknet.configHash(),
        starknet.stateRoot(),
        starknet.stateBlockNumber(),
        starknet.stateBlockHash(),
        starknet.feeCollector(),
        readVerifierAddress(provider, proxyAddress),
        starknet.messageCancellationDelay(),
        starknet.l1ToL2MessageNonce(),
    ]);

    return {
        identify: identifyResult,
        programHash: programHash.toString(),
        aggregatorProgramHash: aggregatorProgramHash.toString(),
        configHash: configHash.toString(),
        stateRoot: stateRoot.toString(),
        stateBlockNumber: stateBlockNumber.toString(),
        stateBlockHash: stateBlockHash.toString(),
        feeCollector,
        verifierAddress,
        messageCancellationDelay: messageCancellationDelay.toString(),
        l1ToL2MessageNonce: l1ToL2MessageNonce.toString(),
    };
}

async function verifyReplacementImplementation(
    provider: JsonRpcProvider,
    implementationAddress: string
): Promise<SelectorCheck[]> {
    const code = await provider.getCode(implementationAddress);

    if (code === "0x") {
        throw new Error(`Replacement implementation has no code: ${implementationAddress}`);
    }

    const implementation = new Contract(implementationAddress, STARKNET_ABI, provider);
    assertEqual(await implementation.identify(), EXPECTED_IDENTIFY, "replacement identify()");
    assertTruthy(!(await implementation.isFrozen()), "replacement implementation must not be frozen");

    let verifierAddress: string;

    try {
        verifierAddress = normalizeAddress(await implementation.verifierAddress());
    } catch (error) {
        throw new Error(
            `Replacement implementation must expose ${VERIFIER_GETTER_SIGNATURE}; ` +
                `probe failed with: ${errorReason(error)}`
        );
    }

    const guardedImplementation = new Contract(
        implementationAddress,
        STARKNET_ABI,
        new VoidSigner(SELECTOR_PROBE_CALLER, provider)
    );

    const checks: SelectorCheck[] = [
        {
            signature: VERIFIER_GETTER_SIGNATURE,
            selector: selector(VERIFIER_GETTER_SIGNATURE),
            status: "matched",
            detail: `direct implementation returned ${verifierAddress}`,
        },
    ];

    let setterProbeReason: string | undefined;

    try {
        await guardedImplementation.setVerifierAddress.staticCall(ZeroAddress);
    } catch (error) {
        setterProbeReason = errorReason(error);
    }

    if (setterProbeReason === undefined) {
        throw new Error(`${SET_VERIFIER_SIGNATURE} unexpectedly succeeded for non-governor probe.`);
    }

    if (!setterProbeReason.includes("ONLY_GOVERNANCE")) {
        throw new Error(
            `Replacement implementation must expose a governance-gated ` +
                `${SET_VERIFIER_SIGNATURE}; probe reverted with: ${setterProbeReason}`
        );
    }

    checks.push({
        signature: SET_VERIFIER_SIGNATURE,
        selector: selector(SET_VERIFIER_SIGNATURE),
        status: "reverted-as-expected",
        detail: setterProbeReason,
    });

    return checks;
}

async function verifySelectors(
    proxy: Contract,
    implementationAddress: string,
    upgradeInitData: string,
    finalize: boolean
): Promise<SelectorCheck[]> {
    const checks: SelectorCheck[] = [];
    const readCalls: Array<[string, () => Promise<unknown>]> = [
        ["implementation()", () => proxy.implementation()],
        ["PROXY_VERSION()", () => proxy.PROXY_VERSION()],
        ["getUpgradeActivationDelay()", () => proxy.getUpgradeActivationDelay()],
        ["isNotFinalized()", () => proxy.isNotFinalized()],
    ];

    for (const [signature, call] of readCalls) {
        await call();
        checks.push({
            signature,
            selector: selector(signature),
            status: "matched",
            detail: "eth_call succeeded",
        });
    }

    const writeProbes: Array<[string, () => Promise<unknown>]> = [
        [
            "addImplementation(address,bytes,bool)",
            () => proxy.addImplementation.staticCall(implementationAddress, upgradeInitData, finalize),
        ],
        [
            "upgradeTo(address,bytes,bool)",
            () => proxy.upgradeTo.staticCall(implementationAddress, upgradeInitData, finalize),
        ],
    ];

    for (const [signature, call] of writeProbes) {
        try {
            await call();
            checks.push({
                signature,
                selector: selector(signature),
                status: "matched",
                detail: "static call succeeded",
            });
        } catch (error) {
            const reason = errorReason(error);
            checks.push({
                signature,
                selector: selector(signature),
                status: "reverted-as-expected",
                detail: reason,
            });
        }
    }

    return checks;
}

async function optionalRoleCall(
    contract: Contract,
    functionName: "proxyIsGovernor" | "isUpgradeGovernor",
    account: string
): Promise<boolean | undefined> {
    try {
        return await contract[functionName](account);
    } catch {
        return undefined;
    }
}

async function optionalCall<T>(contract: Contract, functionName: string): Promise<T | undefined> {
    try {
        return await contract[functionName]();
    } catch {
        return undefined;
    }
}

async function readVerifierAddress(
    provider: JsonRpcProvider,
    proxyAddress: string
): Promise<string> {
    const slot = keccak256(toUtf8Bytes(VERIFIER_ADDRESS_TAG));
    const rawValue = await provider.getStorage(proxyAddress, slot);
    return normalizeAddress(`0x${rawValue.slice(-40)}`);
}

function assertStatePreserved(preState: StarknetStateSnapshot, postState: StarknetStateSnapshot): void {
    const keys: Array<keyof StarknetStateSnapshot> = [
        "identify",
        "programHash",
        "aggregatorProgramHash",
        "configHash",
        "stateRoot",
        "stateBlockNumber",
        "stateBlockHash",
        "feeCollector",
        "verifierAddress",
        "messageCancellationDelay",
        "l1ToL2MessageNonce",
    ];

    for (const key of keys) {
        if (preState[key] !== postState[key]) {
            throw new Error(`State changed unexpectedly for ${key}: ${preState[key]} -> ${postState[key]}`);
        }
    }
}

function callerFromPrivateKey(privateKey?: string): string | undefined {
    if (privateKey === undefined) {
        return undefined;
    }

    return new Wallet(privateKey).address;
}

function readSource(sourceName: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, "src", sourceName), "utf8");
}

function findImports(importPath: string): { contents: string } | { error: string } {
    const candidates = [path.join(REPO_ROOT, "src", importPath), path.join(REPO_ROOT, importPath)];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return { contents: fs.readFileSync(candidate, "utf8") };
        }
    }

    return { error: `Import not found: ${importPath}` };
}

function normalizeAddress(address: string): string {
    return getAddress(address);
}

function assertEqual(actual: string, expected: string, label: string): void {
    if (actual !== expected) {
        throw new Error(`${label} mismatch: ${actual} != ${expected}`);
    }
}

function assertTruthy(value: boolean, message: string): void {
    if (!value) {
        throw new Error(message);
    }
}

function assertNonZero(value: string, label: string): void {
    if (BigInt(value) === 0n) {
        throw new Error(`${label} unexpectedly returned zero.`);
    }
}

function assertNotZeroAddress(value: string, label: string): void {
    if (normalizeAddress(value) === ZeroAddress) {
        throw new Error(`${label} unexpectedly returned the zero address.`);
    }
}

function assertAbiHasFunction(abi: InterfaceAbi, signature: string): void {
    const contractInterface = new Interface(abi);

    if (contractInterface.getFunction(signature) === null) {
        throw new Error(`Compiled Starknet artifact is missing ${signature}.`);
    }
}

function selector(signature: string): string {
    return FunctionFragment.from(`function ${signature}`).selector ?? id(signature).slice(0, 10);
}

function errorReason(error: unknown): string {
    if (typeof error === "object" && error !== null) {
        const maybe = error as { shortMessage?: string; reason?: string; data?: string };
        return maybe.reason ?? maybe.shortMessage ?? maybe.data ?? "reverted";
    }

    return "reverted";
}
