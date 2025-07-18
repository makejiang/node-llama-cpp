import {fork} from "node:child_process";
import {fileURLToPath} from "url";
import {createRequire} from "module";
import path from "path";
import {getConsoleLogPrefix} from "../../utils/getConsoleLogPrefix.js";
import {runningInBun, runningInElectron} from "../../utils/runtime.js";
import {BuildGpu, LlamaLogLevel} from "../types.js";
import {LlamaLogLevelToAddonLogLevel} from "../Llama.js";
import {newGithubIssueUrl} from "../../config.js";
import {getPlatform} from "./getPlatform.js";
import type {BindingModule} from "../AddonTypes.js";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const detectedFileName = path.basename(__filename);
const expectedFileName = "testBindingBinary";

export async function testBindingBinary(
    bindingBinaryPath: string,
    gpu: BuildGpu,
    testTimeout: number = 1000 * 60 * 5,
    pipeOutputOnNode: boolean = false
): Promise<boolean> {
    if (!detectedFileName.startsWith(expectedFileName)) {
        console.warn(
            getConsoleLogPrefix() +
            `"${expectedFileName}.js" file is not independent, so testing a binding binary with the current system` +
            "prior to importing it cannot be done.\n" +
            getConsoleLogPrefix() +
            "Assuming the test passed with the risk that the process may crash due to an incompatible binary.\n" +
            getConsoleLogPrefix() +
            'To resolve this issue, make sure that "node-llama-cpp" is not bundled together with other code and is imported as an external module with its original file structure.'
        );

        return true;
    }

    try {
        const runningInsideSnapOnLinux = getPlatform() === "linux" && process.env.SNAP != null;
        if (runningInsideSnapOnLinux && !runningInBun && !runningInElectron) {
            const nodeSea = await import("node:sea");
            if (nodeSea.isSea()) {
                console.warn(
                    getConsoleLogPrefix() +
                    "node SEA is detected, so testing a binding binary with the current system prior to importing it cannot be done.\n" +
                    getConsoleLogPrefix() +
                    "Assuming the test passed with the risk that the process may crash due to an incompatible binary.\n" +
                    getConsoleLogPrefix() +
                    "If this is an issue in your case, " +
                    "please open an issue on GitHub with the details of the environment where this happens: " + newGithubIssueUrl
                );

                return true;
            }
        }
    } catch (err) {
        // do nothing
    }

    async function getForkFunction() {
        if (runningInElectron) {
            try {
                console.log(getConsoleLogPrefix() + `Running in Electron, attempting to use utilityProcess.fork`);
                const {utilityProcess} = await import("electron");

                return {
                    type: "electron",
                    fork: utilityProcess.fork.bind(utilityProcess)
                } as const;
            } catch (err) {
                console.error(getConsoleLogPrefix() + `Failed to import Electron utilityProcess, falling back to Node.js fork:`, err);
            }
        }

        console.log(getConsoleLogPrefix() + `Using Node.js child_process.fork`);
        return {
            type: "node",
            fork
        } as const;
    }

    const forkFunction = await getForkFunction();

    function createTestProcess({
        onMessage,
        onExit
    }: {
        onMessage(message: ChildToParentMessage): void,
        onExit(code: number): void
    }): {
        sendMessage(message: ParentToChildMessage): void,
        killProcess(): void,
        pipeMessages(): void
    } {
        if (forkFunction.type === "electron") {
            let exited = false;
            const subProcess = forkFunction.fork(__filename, [], {
                env: {
                    ...process.env,
                    TEST_BINDING_CP: "true"
                }
            });

            function cleanupElectronFork() {
                if (subProcess.pid != null || !exited) {
                    subProcess.kill();
                    exited = true;
                }

                process.off("exit", cleanupElectronFork);
            }

            process.on("exit", cleanupElectronFork);

            subProcess.on("message", onMessage);
            subProcess.on("exit", (code) => {
                exited = true;
                cleanupElectronFork();
                onExit(code);
            });

            return {
                sendMessage: (message: ParentToChildMessage) => subProcess.postMessage(message),
                killProcess: cleanupElectronFork,
                pipeMessages: () => void 0
            };
        }

        let pipeSet = false;
        const subProcess = forkFunction.fork(__filename, [], {
            detached: false,
            silent: true,
            stdio: pipeOutputOnNode
                ? ["ignore", "pipe", "pipe", "ipc"]
                : ["ignore", "ignore", "ignore", "ipc"],
            env: {
                ...process.env,
                TEST_BINDING_CP: "true"
            }
        });

        function cleanupNodeFork() {
            subProcess.stdout?.off("data", onStdout);
            subProcess.stderr?.off("data", onStderr);

            if (subProcess.exitCode == null)
                subProcess.kill("SIGKILL");

            process.off("exit", cleanupNodeFork);
        }

        process.on("exit", cleanupNodeFork);

        subProcess.on("message", onMessage);
        subProcess.on("exit", (code) => {
            cleanupNodeFork();
            onExit(code ?? -1);
        });

        if (subProcess.killed || subProcess.exitCode != null) {
            cleanupNodeFork();
            onExit(subProcess.exitCode ?? -1);
        }

        function onStdout(data: string) {
            if (!pipeSet)
                return;

            process.stdout.write(data);
        }

        function onStderr(data: string) {
            if (!pipeSet)
                return;

            process.stderr.write(data);
        }

        if (pipeOutputOnNode) {
            subProcess.stdout?.on("data", onStdout);
            subProcess.stderr?.on("data", onStderr);
        }

        function pipeMessages() {
            if (!pipeOutputOnNode || pipeSet)
                return;

            pipeSet = true;
        }

        return {
            sendMessage: (message: ParentToChildMessage) => subProcess.send(message),
            killProcess: cleanupNodeFork,
            pipeMessages
        };
    }

    let testPassed = false;
    let forkSucceeded = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    let subProcess: ReturnType<typeof createTestProcess> | undefined = undefined;
    let testFinished = false;

    function cleanup() {
        testFinished = true;

        if (timeoutHandle != null)
            clearTimeout(timeoutHandle);

        subProcess?.killProcess();
    }

    return Promise.race([
        new Promise<boolean>((_, reject) => {
            timeoutHandle = setTimeout(() => {
                console.error(getConsoleLogPrefix() + `Binding binary test timed out after ${testTimeout}ms. Binary path: ${bindingBinaryPath}, GPU: ${gpu}`);
                reject(new Error("Binding binary load test timed out"));
                cleanup();
            }, testTimeout);
        }),
        new Promise<boolean>((resolve, reject) => {
            function done() {
                if (!forkSucceeded) {
                    console.error(getConsoleLogPrefix() + `Failed to create test subprocess. File: ${__filename}, GPU: ${gpu}, Binary: ${bindingBinaryPath}`);
                    reject(new Error(`Binding binary test failed to run a test process via file "${__filename}"`));
                } else {
                    console.log(getConsoleLogPrefix() + `Test completed. Passed: ${testPassed}, GPU: ${gpu}, Binary: ${bindingBinaryPath}`);
                    resolve(testPassed);
                }

                cleanup();
            }

            subProcess = createTestProcess({
                onMessage(message: ChildToParentMessage) {
                    if (message.type === "ready") {
                        forkSucceeded = true;
                        subProcess!.sendMessage({
                            type: "start",
                            bindingBinaryPath,
                            gpu
                        });
                    } else if (message.type === "loaded") {
                        subProcess!.pipeMessages(); // only start piping error logs if the binary loaded successfully
                        subProcess!.sendMessage({
                            type: "test",
                            bindingBinaryPath,
                            gpu
                        });
                    } else if (message.type === "done") {
                        testPassed = true;
                        subProcess!.sendMessage({type: "exit"});
                    }
                },
                onExit(code: number) {
                    if (code !== 0) {
                        console.error(getConsoleLogPrefix() + `Test subprocess exited with non-zero code: ${code}. GPU: ${gpu}, Binary: ${bindingBinaryPath}`);
                        testPassed = false;
                    }

                    done();
                }
            });

            if (testFinished)
                subProcess.killProcess();
        })
    ]);
}

if (process.env.TEST_BINDING_CP === "true" && (process.parentPort != null || process.send != null)) {
    let binding: BindingModule;
    const sendMessage = process.parentPort != null
        ? (message: ChildToParentMessage) => process.parentPort.postMessage(message)
        : (message: ChildToParentMessage) => process.send!(message);
    const onMessage = async (message: ParentToChildMessage) => {
        console.log(getConsoleLogPrefix() + `Received message: ${JSON.stringify(message)}`);
        if (message.type === "start") {
            try {
                console.log(getConsoleLogPrefix() + `Attempting to load binding binary: ${message.bindingBinaryPath}`);
                binding = require(message.bindingBinaryPath);

                const errorLogLevel = LlamaLogLevelToAddonLogLevel.get(LlamaLogLevel.error);
                if (errorLogLevel != null)
                    binding.setLoggerLogLevel(errorLogLevel);

                console.log(getConsoleLogPrefix() + `Successfully loaded binding binary: ${message.bindingBinaryPath}`);
                sendMessage({type: "loaded"});
            } catch (err) {
                console.error(getConsoleLogPrefix() + `Failed to load binding binary: ${message.bindingBinaryPath}. Error:`, err);
                process.exit(1);
            }
        } else if (message.type === "test") {
            try {
                if (binding == null)
                    throw new Error("Binding binary is not loaded");

                console.log(getConsoleLogPrefix() + `Starting binding test for GPU: ${message.gpu}`);
                
                console.log(getConsoleLogPrefix() + `Loading backends...`);
                binding.loadBackends();
                const loadedGpu = binding.getGpuType();
                console.log(getConsoleLogPrefix() + `Loaded GPU type: ${loadedGpu}`);

                if (loadedGpu == null || (loadedGpu === false && message.gpu !== false)) {
                    console.log(getConsoleLogPrefix() + `Reloading backends with binary directory: ${path.dirname(path.resolve(message.bindingBinaryPath))}`);
                    binding.loadBackends(path.dirname(path.resolve(message.bindingBinaryPath)));
                }

                console.log(getConsoleLogPrefix() + `Initializing binding...`);
                await binding.init();
                
                console.log(getConsoleLogPrefix() + `Getting GPU VRAM info...`);
                binding.getGpuVramInfo();
                
                console.log(getConsoleLogPrefix() + `Getting GPU device info...`);
                binding.getGpuDeviceInfo();

                const gpuType = binding.getGpuType();
                console.log(getConsoleLogPrefix() + `Final GPU type: ${gpuType}`);
                
                void (gpuType as (BuildGpu) satisfies typeof gpuType);
                if (gpuType !== message.gpu) {
                    const errorMsg = `Binary GPU type mismatch. Expected: ${message.gpu}, got: ${gpuType}. ` + (
                        message.gpu === "cuda"
                            ? "May be due to a linker issue, ensure you don't have multiple conflicting CUDA installations."
                            : "May be due to a linker issue, ensure the native dependencies are not broken."
                    );
                    console.error(getConsoleLogPrefix() + errorMsg);
                    throw new Error(errorMsg);
                }

                console.log(getConsoleLogPrefix() + `Ensuring GPU device is supported...`);
                binding.ensureGpuDeviceIsSupported();

                console.log(getConsoleLogPrefix() + `All binding tests passed successfully`);
                sendMessage({type: "done"});
            } catch (err) {
                console.error(getConsoleLogPrefix() + `Binding test failed:`, err);
                process.exit(1);
            }
        } else if (message.type === "exit") {
            process.exit(0);
        }
    };

    if (process.parentPort != null)
        process.parentPort.on("message", (message) => onMessage(message.data));
    else
        process.on("message", onMessage);

    sendMessage({type: "ready"});
}

type ParentToChildMessage = {
    type: "start",
    bindingBinaryPath: string,
    gpu: BuildGpu
} | {
    type: "test",
    bindingBinaryPath: string,
    gpu: BuildGpu
} | {
    type: "exit"
};
type ChildToParentMessage = {
    type: "ready" | "loaded" | "done"
};
