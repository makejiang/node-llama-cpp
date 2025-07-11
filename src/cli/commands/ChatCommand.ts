import * as readline from "readline";
import process from "process";
import path from "path";
import {CommandModule} from "yargs";
import chalk from "chalk";
import fs from "fs-extra";
import prettyMilliseconds from "pretty-ms";
import {chatCommandHistoryFilePath, defaultChatSystemPrompt, documentationPageUrls} from "../../config.js";
import {getIsInDocumentationMode} from "../../state.js";
import {ReplHistory} from "../../utils/ReplHistory.js";
import {defineChatSessionFunction} from "../../evaluator/LlamaChatSession/utils/defineChatSessionFunction.js";
import {getLlama} from "../../bindings/getLlama.js";
import {LlamaGrammar} from "../../evaluator/LlamaGrammar.js";
import {LlamaChatSession} from "../../evaluator/LlamaChatSession/LlamaChatSession.js";
import {
    BuildGpu, LlamaLogLevel, LlamaLogLevelGreaterThan, nodeLlamaCppGpuOptions, parseNodeLlamaCppGpuOption
} from "../../bindings/types.js";
import withOra from "../../utils/withOra.js";
import {TokenMeter} from "../../evaluator/TokenMeter.js";
import {printInfoLine} from "../utils/printInfoLine.js";
import {
    resolveChatWrapper, SpecializedChatWrapperTypeName, specializedChatWrapperTypeNames
} from "../../chatWrappers/utils/resolveChatWrapper.js";
import {GeneralChatWrapper} from "../../chatWrappers/GeneralChatWrapper.js";
import {printCommonInfoLines} from "../utils/printCommonInfoLines.js";
import {resolveCommandGgufPath} from "../utils/resolveCommandGgufPath.js";
import {withProgressLog} from "../../utils/withProgressLog.js";
import {resolveHeaderFlag} from "../utils/resolveHeaderFlag.js";
import {withCliCommandDescriptionDocsUrl} from "../utils/withCliCommandDescriptionDocsUrl.js";
import {ConsoleInteraction, ConsoleInteractionKey} from "../utils/ConsoleInteraction.js";
import {DraftSequenceTokenPredictor} from "../../evaluator/LlamaContext/tokenPredictors/DraftSequenceTokenPredictor.js";

type ChatCommand = {
    modelPath?: string,
    header?: string[],
    gpu?: BuildGpu | "auto",
    systemInfo: boolean,
    systemPrompt?: string,
    systemPromptFile?: string,
    prompt?: string,
    promptFile?: string,
    wrapper: SpecializedChatWrapperTypeName | "auto",
    noJinja?: boolean,
    contextSize?: number,
    batchSize?: number,
    flashAttention?: boolean,
    swaFullCache?: boolean,
    noTrimWhitespace: boolean,
    grammar: "text" | Parameters<typeof LlamaGrammar.getFor>[1],
    jsonSchemaGrammarFile?: string,
    threads?: number,
    temperature: number,
    minP: number,
    topK: number,
    topP: number,
    seed?: number,
    gpuLayers?: number,
    repeatPenalty: number,
    lastTokensRepeatPenalty: number,
    penalizeRepeatingNewLine: boolean,
    repeatFrequencyPenalty?: number,
    repeatPresencePenalty?: number,
    maxTokens: number,
    reasoningBudget?: number,
    noHistory: boolean,
    environmentFunctions: boolean,
    tokenPredictionDraftModel?: string,
    tokenPredictionModelContextSize?: number,
    debug: boolean,
    meter: boolean,
    timing: boolean,
    noMmap: boolean,
    printTimings: boolean
};

export const ChatCommand: CommandModule<object, ChatCommand> = {
    command: "chat [modelPath]",
    describe: withCliCommandDescriptionDocsUrl(
        "Chat with a model",
        documentationPageUrls.CLI.Chat
    ),
    builder(yargs) {
        const isInDocumentationMode = getIsInDocumentationMode();

        return yargs
            .option("modelPath", {
                alias: ["m", "model", "path", "url", "uri"],
                type: "string",
                description: "Model file to use for the chat. Can be a path to a local file or a URI of a model file to download. Leave empty to choose from a list of recommended models"
            })
            .option("header", {
                alias: ["H"],
                type: "string",
                array: true,
                description: "Headers to use when downloading a model from a URL, in the format `key: value`. You can pass this option multiple times to add multiple headers."
            })
            .option("gpu", {
                type: "string",

                // yargs types don't support passing `false` as a choice, although it is supported by yargs
                choices: nodeLlamaCppGpuOptions as any as Exclude<typeof nodeLlamaCppGpuOptions[number], false>[],
                coerce: (value) => {
                    if (value == null || value == "")
                        return undefined;

                    return parseNodeLlamaCppGpuOption(value);
                },
                defaultDescription: "Uses the latest local build, and fallbacks to \"auto\"",
                description: "Compute layer implementation type to use for llama.cpp. If omitted, uses the latest local build, and fallbacks to \"auto\""
            })
            .option("systemInfo", {
                alias: "i",
                type: "boolean",
                default: false,
                description: "Print llama.cpp system info"
            })
            .option("systemPrompt", {
                alias: "s",
                type: "string",
                description:
                    "System prompt to use against the model" +
                    (isInDocumentationMode ? "" : (". [the default value is determined by the chat wrapper, but is usually: " + defaultChatSystemPrompt.split("\n").join(" ") + "]"))
            })
            .option("systemPromptFile", {
                type: "string",
                description: "Path to a file to load text from and use as as the model system prompt"
            })
            .option("prompt", {
                type: "string",
                description: "First prompt to automatically send to the model when starting the chat"
            })
            .option("promptFile", {
                type: "string",
                description: "Path to a file to load text from and use as a first prompt to automatically send to the model when starting the chat"
            })
            .option("wrapper", {
                alias: "w",
                type: "string",
                default: "auto" as ChatCommand["wrapper"],
                choices: ["auto", ...specializedChatWrapperTypeNames] as const,
                description: "Chat wrapper to use. Use `auto` to automatically select a wrapper based on the model's metadata and tokenizer"
            })
            .option("noJinja", {
                type: "boolean",
                default: false,
                description: "Don't use a Jinja wrapper, even if it's the best option for the model"
            })
            .option("contextSize", {
                alias: "c",
                type: "number",
                description: "Context size to use for the model context",
                default: -1,
                defaultDescription: "Automatically determined based on the available VRAM"
            })
            .option("batchSize", {
                alias: "b",
                type: "number",
                description: "Batch size to use for the model context. The default value is the context size"
            })
            .option("flashAttention", {
                alias: "fa",
                type: "boolean",
                default: false,
                description: "Enable flash attention"
            })
            .option("swaFullCache", {
                alias: "noSwa",
                type: "boolean",
                default: false,
                description: "Disable SWA (Sliding Window Attention) on supported models"
            })
            .option("noTrimWhitespace", {
                type: "boolean",
                alias: ["noTrim"],
                default: false,
                description: "Don't trim whitespaces from the model response"
            })
            .option("grammar", {
                alias: "g",
                type: "string",
                default: "text" as ChatCommand["grammar"],
                choices: ["text", "json", "list", "arithmetic", "japanese", "chess"] satisfies ChatCommand["grammar"][],
                description: "Restrict the model response to a specific grammar, like JSON for example"
            })
            .option("jsonSchemaGrammarFile", {
                alias: ["jsgf"],
                type: "string",
                description: "File path to a JSON schema file, to restrict the model response to only generate output that conforms to the JSON schema"
            })
            .option("threads", {
                type: "number",
                defaultDescription: "Number of cores that are useful for math on the current machine",
                description: "Number of threads to use for the evaluation of tokens"
            })
            .option("temperature", {
                alias: "t",
                type: "number",
                default: 0,
                description: "Temperature is a hyperparameter that controls the randomness of the generated text. It affects the probability distribution of the model's output tokens. A higher temperature (e.g., 1.5) makes the output more random and creative, while a lower temperature (e.g., 0.5) makes the output more focused, deterministic, and conservative. The suggested temperature is 0.8, which provides a balance between randomness and determinism. At the extreme, a temperature of 0 will always pick the most likely next token, leading to identical outputs in each run. Set to `0` to disable."
            })
            .option("minP", {
                alias: "mp",
                type: "number",
                default: 0,
                description: "From the next token candidates, discard the percentage of tokens with the lowest probability. For example, if set to `0.05`, 5% of the lowest probability tokens will be discarded. This is useful for generating more high-quality results when using a high temperature. Set to a value between `0` and `1` to enable. Only relevant when `temperature` is set to a value greater than `0`."
            })
            .option("topK", {
                alias: "k",
                type: "number",
                default: 40,
                description: "Limits the model to consider only the K most likely next tokens for sampling at each step of sequence generation. An integer number between `1` and the size of the vocabulary. Set to `0` to disable (which uses the full vocabulary). Only relevant when `temperature` is set to a value greater than 0."
            })
            .option("topP", {
                alias: "p",
                type: "number",
                default: 0.95,
                description: "Dynamically selects the smallest set of tokens whose cumulative probability exceeds the threshold P, and samples the next token only from this set. A float number between `0` and `1`. Set to `1` to disable. Only relevant when `temperature` is set to a value greater than `0`."
            })
            .option("seed", {
                type: "number",
                description: "Used to control the randomness of the generated text. Only relevant when using `temperature`.",
                defaultDescription: "The current epoch time"
            })
            .option("gpuLayers", {
                alias: "gl",
                type: "number",
                description: "number of layers to store in VRAM",
                default: -1,
                defaultDescription: "Automatically determined based on the available VRAM"
            })
            .option("repeatPenalty", {
                alias: "rp",
                type: "number",
                default: 1.1,
                description: "Prevent the model from repeating the same token too much. Set to `1` to disable."
            })
            .option("lastTokensRepeatPenalty", {
                alias: "rpn",
                type: "number",
                default: 64,
                description: "Number of recent tokens generated by the model to apply penalties to repetition of"
            })
            .option("penalizeRepeatingNewLine", {
                alias: "rpnl",
                type: "boolean",
                default: true,
                description: "Penalize new line tokens. set `--no-penalizeRepeatingNewLine` or `--no-rpnl` to disable"
            })
            .option("repeatFrequencyPenalty", {
                alias: "rfp",
                type: "number",
                description: "For n time a token is in the `punishTokens` array, lower its probability by `n * repeatFrequencyPenalty`. Set to a value between `0` and `1` to enable."
            })
            .option("repeatPresencePenalty", {
                alias: "rpp",
                type: "number",
                description: "Lower the probability of all the tokens in the `punishTokens` array by `repeatPresencePenalty`. Set to a value between `0` and `1` to enable."
            })
            .option("maxTokens", {
                alias: "mt",
                type: "number",
                default: 0,
                description: "Maximum number of tokens to generate in responses. Set to `0` to disable. Set to `-1` to set to the context size"
            })
            .option("reasoningBudget", {
                alias: ["tb", "thinkingBudget", "thoughtsBudget"],
                type: "number",
                default: -1,
                defaultDescription: "Unlimited",
                description: "Maximum number of tokens the model can use for thoughts. Set to `0` to disable reasoning"
            })
            .option("noHistory", {
                alias: "nh",
                type: "boolean",
                default: false,
                description: "Don't load or save chat history"
            })
            .option("environmentFunctions", {
                alias: "ef",
                type: "boolean",
                default: false,
                description: "Provide access to environment functions like `getDate` and `getTime`"
            })
            .option("tokenPredictionDraftModel", {
                alias: ["dm", "draftModel"],
                type: "string",
                description: "Model file to use for draft sequence token prediction (speculative decoding). Can be a path to a local file or a URI of a model file to download"
            })
            .option("tokenPredictionModelContextSize", {
                alias: ["dc", "draftContextSize", "draftContext"],
                type: "number",
                description: "Max context size to use for the draft sequence token prediction model context",
                default: 4096
            })
            .option("debug", {
                alias: "d",
                type: "boolean",
                default: false,
                description: "Print llama.cpp info and debug logs"
            })
            .option("meter", {
                type: "boolean",
                default: false,
                description: "Print how many tokens were used as input and output for each response"
            })
            .option("timing", {
                type: "boolean",
                default: false,
                description: "Print how how long it took to generate each response"
            })
            .option("noMmap", {
                type: "boolean",
                default: false,
                description: "Disable mmap (memory-mapped file) usage"
            })
            .option("printTimings", {
                alias: "pt",
                type: "boolean",
                default: false,
                description: "Print llama.cpp's internal timings after each response"
            });
    },
    async handler({
        modelPath, header, gpu, systemInfo, systemPrompt, systemPromptFile, prompt,
        promptFile, wrapper, noJinja, contextSize, batchSize, flashAttention, swaFullCache,
        noTrimWhitespace, grammar, jsonSchemaGrammarFile, threads, temperature, minP, topK,
        topP, seed, gpuLayers, repeatPenalty, lastTokensRepeatPenalty, penalizeRepeatingNewLine,
        repeatFrequencyPenalty, repeatPresencePenalty, maxTokens, reasoningBudget, noHistory,
        environmentFunctions, tokenPredictionDraftModel, tokenPredictionModelContextSize, debug, meter, timing, noMmap, printTimings
    }) {
        try {
            await RunChat({
                modelPath, header, gpu, systemInfo, systemPrompt, systemPromptFile, prompt, promptFile, wrapper, noJinja, contextSize,
                batchSize, flashAttention, swaFullCache, noTrimWhitespace, grammar, jsonSchemaGrammarFile, threads,
                temperature, minP, topK, topP, seed,
                gpuLayers, lastTokensRepeatPenalty, repeatPenalty, penalizeRepeatingNewLine, repeatFrequencyPenalty, repeatPresencePenalty,
                maxTokens, reasoningBudget, noHistory, environmentFunctions, tokenPredictionDraftModel, tokenPredictionModelContextSize,
                debug, meter, timing, noMmap, printTimings
            });
        } catch (err) {
            await new Promise((accept) => setTimeout(accept, 0)); // wait for logs to finish printing
            console.error(err);
            process.exit(1);
        }
    }
};


async function RunChat({
    modelPath: modelArg, header: headerArg, gpu, systemInfo, systemPrompt, systemPromptFile, prompt, promptFile, wrapper, noJinja,
    contextSize, batchSize, flashAttention, swaFullCache, noTrimWhitespace, grammar: grammarArg,
    jsonSchemaGrammarFile: jsonSchemaGrammarFilePath,
    threads, temperature, minP, topK, topP, seed, gpuLayers, lastTokensRepeatPenalty, repeatPenalty, penalizeRepeatingNewLine,
    repeatFrequencyPenalty, repeatPresencePenalty, maxTokens, reasoningBudget, noHistory, environmentFunctions, tokenPredictionDraftModel,
    tokenPredictionModelContextSize, debug, meter, timing, noMmap, printTimings
}: ChatCommand) {
    if (contextSize === -1) contextSize = undefined;
    if (gpuLayers === -1) gpuLayers = undefined;
    if (reasoningBudget === -1) reasoningBudget = undefined;

    const headers = resolveHeaderFlag(headerArg);
    const trimWhitespace = !noTrimWhitespace;

    if (debug)
        console.info(`${chalk.yellow("Log level:")} debug`);

    const llamaLogLevel = debug
        ? LlamaLogLevel.debug
        : LlamaLogLevel.warn;
    const llama = gpu == null
        ? await getLlama("lastBuild", {
            logLevel: llamaLogLevel
        })
        : await getLlama({
            gpu,
            logLevel: llamaLogLevel
        });
    const logBatchSize = batchSize != null;
    const useMmap = !noMmap && llama.supportsMmap;

    const resolvedModelPath = await resolveCommandGgufPath(modelArg, llama, headers, {
        flashAttention,
        swaFullCache,
        useMmap
    });
    const resolvedDraftModelPath = (tokenPredictionDraftModel != null && tokenPredictionDraftModel !== "")
        ? await resolveCommandGgufPath(tokenPredictionDraftModel, llama, headers, {
            flashAttention,
            swaFullCache,
            useMmap,
            consoleTitle: "Draft model file"
        })
        : undefined;

    if (systemInfo)
        console.log(llama.systemInfo);

    if (systemPromptFile != null && systemPromptFile !== "") {
        if (systemPrompt != null && systemPrompt !== "" && systemPrompt !== defaultChatSystemPrompt)
            console.warn(chalk.yellow("Both `systemPrompt` and `systemPromptFile` were specified. `systemPromptFile` will be used."));

        systemPrompt = await fs.readFile(path.resolve(process.cwd(), systemPromptFile), "utf8");
    }

    if (promptFile != null && promptFile !== "") {
        if (prompt != null && prompt !== "")
            console.warn(chalk.yellow("Both `prompt` and `promptFile` were specified. `promptFile` will be used."));

        prompt = await fs.readFile(path.resolve(process.cwd(), promptFile), "utf8");
    }

    if (batchSize != null && contextSize != null && batchSize > contextSize) {
        console.warn(chalk.yellow("Batch size is greater than the context size. Batch size will be set to the context size."));
        batchSize = contextSize;
    }

    let initialPrompt = prompt ?? null;
    const model = await withProgressLog({
        loadingText: chalk.blue.bold("Loading model"),
        successText: chalk.blue("Model loaded"),
        failText: chalk.blue("Failed to load model"),
        liveUpdates: !debug,
        noProgress: debug,
        liveCtrlCSendsAbortSignal: true
    }, async (progressUpdater) => {
        try {
            return await llama.loadModel({
                modelPath: resolvedModelPath,
                gpuLayers: gpuLayers != null
                    ? gpuLayers
                    : contextSize != null
                        ? {fitContext: {contextSize}}
                        : undefined,
                defaultContextFlashAttention: flashAttention,
                defaultContextSwaFullCache: swaFullCache,
                useMmap,
                ignoreMemorySafetyChecks: gpuLayers != null,
                onLoadProgress(loadProgress: number) {
                    progressUpdater.setProgress(loadProgress);
                },
                loadSignal: progressUpdater.abortSignal
            });
        } catch (err) {
            if (err === progressUpdater.abortSignal?.reason)
                process.exit(0);

            throw err;
        } finally {
            if (llama.logLevel === LlamaLogLevel.debug) {
                await new Promise((accept) => setTimeout(accept, 0)); // wait for logs to finish printing
                console.info();
            }
        }
    });
    const draftModel = resolvedDraftModelPath == null
        ? undefined
        : await withProgressLog({
            loadingText: chalk.blue.bold("Loading draft model"),
            successText: chalk.blue("Draft model loaded"),
            failText: chalk.blue("Failed to load draft model"),
            liveUpdates: !debug,
            noProgress: debug,
            liveCtrlCSendsAbortSignal: true
        }, async (progressUpdater) => {
            try {
                return await llama.loadModel({
                    modelPath: resolvedDraftModelPath,
                    defaultContextFlashAttention: flashAttention,
                    defaultContextSwaFullCache: swaFullCache,
                    useMmap,
                    onLoadProgress(loadProgress: number) {
                        progressUpdater.setProgress(loadProgress);
                    },
                    loadSignal: progressUpdater.abortSignal
                });
            } catch (err) {
                if (err === progressUpdater.abortSignal?.reason)
                    process.exit(0);

                throw err;
            } finally {
                if (llama.logLevel === LlamaLogLevel.debug) {
                    await new Promise((accept) => setTimeout(accept, 0)); // wait for logs to finish printing
                    console.info();
                }
            }
        });

    const draftContext = draftModel == null
        ? undefined
        : await withOra({
            loading: chalk.blue("Creating draft context"),
            success: chalk.blue("Draft context created"),
            fail: chalk.blue("Failed to create draft context"),
            useStatusLogs: debug
        }, async () => {
            try {
                return await draftModel.createContext({
                    contextSize: {max: tokenPredictionModelContextSize}
                });
            } finally {
                if (llama.logLevel === LlamaLogLevel.debug) {
                    await new Promise((accept) => setTimeout(accept, 0)); // wait for logs to finish printing
                    console.info();
                }
            }
        });
    const context = await withOra({
        loading: chalk.blue("Creating context"),
        success: chalk.blue("Context created"),
        fail: chalk.blue("Failed to create context"),
        useStatusLogs: debug
    }, async () => {
        try {
            return await model.createContext({
                contextSize: contextSize != null ? contextSize : undefined,
                batchSize: batchSize != null ? batchSize : undefined,
                threads: threads === null ? undefined : threads,
                ignoreMemorySafetyChecks: gpuLayers != null || contextSize != null,
                performanceTracking: printTimings
            });
        } finally {
            if (llama.logLevel === LlamaLogLevel.debug) {
                await new Promise((accept) => setTimeout(accept, 0)); // wait for logs to finish printing
                console.info();
            }
        }
    });

    const grammar = jsonSchemaGrammarFilePath != null
        ? await llama.createGrammarForJsonSchema(
            await fs.readJson(
                path.resolve(process.cwd(), jsonSchemaGrammarFilePath)
            )
        )
        : grammarArg !== "text"
            ? await LlamaGrammar.getFor(llama, grammarArg)
            : undefined;
    const chatWrapper = resolveChatWrapper({
        type: wrapper,
        bosString: model.tokens.bosString,
        filename: model.filename,
        fileInfo: model.fileInfo,
        tokenizer: model.tokenizer,
        noJinja
    }) ?? new GeneralChatWrapper();
    const draftContextSequence = draftContext?.getSequence();
    const contextSequence = draftContextSequence != null
        ? context.getSequence({
            tokenPredictor: new DraftSequenceTokenPredictor(draftContextSequence)
        })
        : context.getSequence();
    const session = new LlamaChatSession({
        contextSequence,
        systemPrompt,
        chatWrapper: chatWrapper
    });
    let lastDraftTokenMeterState = draftContextSequence?.tokenMeter.getState();
    let lastTokenMeterState = contextSequence.tokenMeter.getState();
    let lastTokenPredictionsStats = contextSequence.tokenPredictions;

    await new Promise((accept) => setTimeout(accept, 0)); // wait for logs to finish printing

    if (grammarArg != "text" && jsonSchemaGrammarFilePath != null)
        console.warn(chalk.yellow("Both `grammar` and `jsonSchemaGrammarFile` were specified. `jsonSchemaGrammarFile` will be used."));

    if (environmentFunctions && grammar != null) {
        console.warn(chalk.yellow("Environment functions are disabled since a grammar is already specified"));
        environmentFunctions = false;
    }

    const padTitle = await printCommonInfoLines({
        context,
        draftContext,
        useMmap,
        printBos: true,
        printEos: true,
        logBatchSize,
        tokenMeterEnabled: meter
    });
    printInfoLine({
        title: "Chat",
        padTitle: padTitle,
        info: [{
            title: "Wrapper",
            value: chatWrapper.wrapperName
        }, {
            title: "Repeat penalty",
            value: `${repeatPenalty} (apply to last ${lastTokensRepeatPenalty} tokens)`
        }, {
            show: repeatFrequencyPenalty != null,
            title: "Repeat frequency penalty",
            value: String(repeatFrequencyPenalty)
        }, {
            show: repeatPresencePenalty != null,
            title: "Repeat presence penalty",
            value: String(repeatPresencePenalty)
        }, {
            show: !penalizeRepeatingNewLine,
            title: "Penalize repeating new line",
            value: "disabled"
        }, {
            show: jsonSchemaGrammarFilePath != null,
            title: "JSON schema grammar file",
            value: () => path.relative(process.cwd(), path.resolve(process.cwd(), jsonSchemaGrammarFilePath ?? ""))
        }, {
            show: jsonSchemaGrammarFilePath == null && grammarArg !== "text",
            title: "Grammar",
            value: grammarArg
        }, {
            show: environmentFunctions,
            title: "Environment functions",
            value: "enabled"
        }, {
            show: timing,
            title: "Response timing",
            value: "enabled"
        }]
    });

    // this is for ora to not interfere with readline
    await new Promise((resolve) => setTimeout(resolve, 1));

    const replHistory = await ReplHistory.load(chatCommandHistoryFilePath, !noHistory);

    async function getPrompt() {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            history: replHistory.history.slice()
        });

        const res: string = await new Promise((accept) => rl.question(chalk.yellow("> "), accept));
        rl.close();

        return res;
    }

    if (prompt != null && prompt !== "" && !printTimings && (meter || timing)) {
        // warm up the context sequence before the first evaluation, to make the timings of the actual evaluations more accurate
        const contextFirstToken = session.chatWrapper.generateContextState({
            chatHistory: [
                ...session.getChatHistory(),
                {type: "user", text: ""}
            ]
        }).contextText.tokenize(model.tokenizer)[0];

        if (contextFirstToken != null)
            await contextSequence.evaluateWithoutGeneratingNewTokens([contextFirstToken]);
    } else if (!printTimings && !meter)
        void session.preloadPrompt("")
            .catch(() => void 0); // don't throw an error if preloading fails because a real prompt is sent early

    while (true) {
        let hadTrimmedWhitespaceTextInThisIterationAndSegment = false;
        let nextPrintLeftovers = "";
        const input = initialPrompt != null
            ? initialPrompt
            : await getPrompt();

        if (initialPrompt != null) {
            console.log(chalk.green("> ") + initialPrompt);
            initialPrompt = null;
        } else
            await replHistory.add(input);

        if (input === ".exit")
            break;

        process.stdout.write(chalk.yellow("AI: "));

        const [startColor, endColor] = chalk.blue("MIDDLE").split("MIDDLE");
        const [segmentStartColor, segmentEndColor] = chalk.gray("MIDDLE").split("MIDDLE");

        const abortController = new AbortController();
        const consoleInteraction = new ConsoleInteraction();
        consoleInteraction.onKey(ConsoleInteractionKey.ctrlC, async () => {
            abortController.abort();
            consoleInteraction.stop();
        });

        const timeBeforePrompt = Date.now();
        let currentSegmentType: string | undefined;
        try {
            process.stdout.write(startColor!);
            consoleInteraction.start();
            await session.prompt(input, {
                grammar: grammar as undefined, // this is a workaround to allow passing both `functions` and `grammar`
                temperature,
                minP,
                topK,
                topP,
                seed: seed ?? undefined,
                signal: abortController.signal,
                stopOnAbortSignal: true,
                budgets: {
                    thoughtTokens: reasoningBudget
                },
                repeatPenalty: {
                    penalty: repeatPenalty,
                    frequencyPenalty: repeatFrequencyPenalty != null ? repeatFrequencyPenalty : undefined,
                    presencePenalty: repeatPresencePenalty != null ? repeatPresencePenalty : undefined,
                    penalizeNewLine: penalizeRepeatingNewLine,
                    lastTokens: lastTokensRepeatPenalty
                },
                maxTokens: maxTokens === -1
                    ? context.contextSize
                    : maxTokens <= 0
                        ? undefined
                        : maxTokens,
                onResponseChunk({text: chunk, type: chunkType, segmentType}) {
                    if (segmentType != currentSegmentType) {
                        const printNewline = hadTrimmedWhitespaceTextInThisIterationAndSegment
                            ? "\n"
                            : "";
                        hadTrimmedWhitespaceTextInThisIterationAndSegment = false;

                        if (chunkType !== "segment" || segmentType == null) {
                            process.stdout.write(segmentEndColor!);
                            process.stdout.write(chalk.reset.whiteBright.bold(printNewline + "[response] "));
                            process.stdout.write(startColor!);
                        } else if (currentSegmentType == null) {
                            process.stdout.write(endColor!);
                            process.stdout.write(chalk.reset.whiteBright.bold(printNewline + `[segment: ${segmentType}] `));
                            process.stdout.write(segmentStartColor!);
                        } else {
                            process.stdout.write(segmentEndColor!);
                            process.stdout.write(chalk.reset.whiteBright.bold(printNewline + `[segment: ${segmentType}] `));
                            process.stdout.write(segmentStartColor!);
                        }

                        currentSegmentType = segmentType;
                    }

                    let text = nextPrintLeftovers + chunk;
                    nextPrintLeftovers = "";

                    if (trimWhitespace) {
                        if (!hadTrimmedWhitespaceTextInThisIterationAndSegment) {
                            text = text.trimStart();

                            if (text.length > 0)
                                hadTrimmedWhitespaceTextInThisIterationAndSegment = true;
                        }

                        const textWithTrimmedEnd = text.trimEnd();

                        if (textWithTrimmedEnd.length < text.length) {
                            nextPrintLeftovers = text.slice(textWithTrimmedEnd.length);
                            text = textWithTrimmedEnd;
                        }
                    }

                    process.stdout.write(text);
                },
                functions: (grammar == null && environmentFunctions)
                    ? defaultEnvironmentFunctions
                    : undefined,
                trimWhitespaceSuffix: trimWhitespace
            });
        } catch (err) {
            if (!(abortController.signal.aborted && err === abortController.signal.reason))
                throw err;
        } finally {
            consoleInteraction.stop();

            const currentEndColor = currentSegmentType != null
                ? segmentEndColor!
                : endColor!;

            if (abortController.signal.aborted)
                process.stdout.write(currentEndColor + chalk.yellow("[generation aborted by user]"));
            else
                process.stdout.write(currentEndColor);

            console.log();
        }
        const timeAfterPrompt = Date.now();

        if (printTimings) {
            if (LlamaLogLevelGreaterThan(llama.logLevel, LlamaLogLevel.info))
                llama.logLevel = LlamaLogLevel.info;

            await context.printTimings();
            await new Promise((accept) => setTimeout(accept, 0)); // wait for logs to finish printing

            llama.logLevel = llamaLogLevel;
        }

        if (timing)
            console.info(
                chalk.dim("Response duration: ") +
                prettyMilliseconds(timeAfterPrompt - timeBeforePrompt, {
                    keepDecimalsOnWholeSeconds: true,
                    secondsDecimalDigits: 2,
                    separateMilliseconds: true,
                    compact: false
                })
            );

        if (meter) {
            const newTokenMeterState = contextSequence.tokenMeter.getState();
            const tokenMeterDiff = TokenMeter.diff(newTokenMeterState, lastTokenMeterState);
            lastTokenMeterState = newTokenMeterState;

            const showDraftTokenMeterDiff = lastDraftTokenMeterState != null && draftContextSequence != null;

            const tokenPredictionsStats = contextSequence.tokenPredictions;
            const validatedTokenPredictions = tokenPredictionsStats.validated - lastTokenPredictionsStats.validated;
            const refutedTokenPredictions = tokenPredictionsStats.refuted - lastTokenPredictionsStats.refuted;
            const usedTokenPredictions = tokenPredictionsStats.used - lastTokenPredictionsStats.used;
            const unusedTokenPredictions = tokenPredictionsStats.unused - lastTokenPredictionsStats.unused;
            lastTokenPredictionsStats = tokenPredictionsStats;

            console.info([
                showDraftTokenMeterDiff && (
                    chalk.yellow("Main".padEnd("Drafter".length))
                ),
                chalk.dim("Input tokens:") + " " + String(tokenMeterDiff.usedInputTokens).padEnd(5, " "),
                chalk.dim("Output tokens:") + " " + String(tokenMeterDiff.usedOutputTokens).padEnd(5, " "),
                showDraftTokenMeterDiff && (
                    chalk.dim("Validated predictions:") + " " + String(validatedTokenPredictions).padEnd(5, " ")
                ),
                showDraftTokenMeterDiff && (
                    chalk.dim("Refuted predictions:") + " " + String(refutedTokenPredictions).padEnd(5, " ")
                ),
                showDraftTokenMeterDiff && (
                    chalk.dim("Used predictions:") + " " + String(usedTokenPredictions).padEnd(5, " ")
                ),
                showDraftTokenMeterDiff && (
                    chalk.dim("Unused predictions:") + " " + String(unusedTokenPredictions).padEnd(5, " ")
                )
            ].filter(Boolean).join("  "));

            if (lastDraftTokenMeterState != null && draftContextSequence != null) {
                const newDraftTokenMeterState = draftContextSequence.tokenMeter.getState();
                const draftTokenMeterDiff = TokenMeter.diff(newDraftTokenMeterState, lastDraftTokenMeterState);
                lastDraftTokenMeterState = newDraftTokenMeterState;

                console.info([
                    chalk.yellow("Drafter"),
                    chalk.dim("Input tokens:") + " " + String(draftTokenMeterDiff.usedInputTokens).padEnd(5, " "),
                    chalk.dim("Output tokens:") + " " + String(draftTokenMeterDiff.usedOutputTokens).padEnd(5, " ")
                ].join("  "));
            }
        }
    }
}

const defaultEnvironmentFunctions = {
    getDate: defineChatSessionFunction({
        description: "Retrieve the current date",
        handler() {
            const date = new Date();
            return [
                date.getFullYear(),
                String(date.getMonth() + 1).padStart(2, "0"),
                String(date.getDate()).padStart(2, "0")
            ].join("-");
        }
    }),
    getTime: defineChatSessionFunction({
        description: "Retrieve the current time",
        handler() {
            return new Date().toLocaleTimeString("en-US");
        }
    })
};
