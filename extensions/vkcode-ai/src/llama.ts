/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as vscode from 'vscode';

// A real dynamic import() that TypeScript will not down-level to require() under CommonJS. Required
// to load node-llama-cpp, which is ESM-only and uses top-level await (so require() throws).
const importEsm = new Function('specifier', 'return import(specifier);') as (specifier: string) => Promise<unknown>;

/**
 * Minimal facade over the parts of `node-llama-cpp` (v3) that we use. The module is an optional,
 * native ESM dependency loaded lazily via a dynamic import so that the extension still compiles and
 * activates when it is not installed; the AI features simply stay unavailable until it is present.
 */
interface ILlamaModule {
	getLlama(options?: { gpu?: false | 'auto' }): Promise<ILlama>;
	LlamaChatSession: new (options: { contextSequence: ILlamaContextSequence; systemPrompt?: string }) => ILlamaChatSession;
	LlamaCompletion: new (options: { contextSequence: ILlamaContextSequence }) => ILlamaCompletion;
}

interface ILlama {
	loadModel(options: { modelPath: string }): Promise<ILlamaModel>;
}

interface ILlamaModel {
	createContext(options?: { contextSize?: number | 'auto' | { min?: number; max?: number } }): Promise<ILlamaContext>;
	readonly infillSupported: boolean;
	readonly trainContextSize?: number;
	tokenize(text: string): number[];
}

interface ILlamaContext {
	getSequence(): ILlamaContextSequence;
	dispose(): Promise<void>;
}

interface ILlamaContextSequence {
	dispose(): void;
}

interface IPromptOptions {
	maxTokens?: number;
	temperature?: number;
	signal?: AbortSignal;
	onTextChunk?: (chunk: string) => void;
	/**
	 * Qwen3 reasoning. `false` forbids the model from spending any tokens on a `<think>` segment
	 * (so the whole budget goes to the answer); `true` allows a bounded reasoning budget. `undefined`
	 * leaves the engine default (which can be most of the context — see {@link LlamaService.chat}).
	 */
	think?: boolean;
}

/** A response chunk from `node-llama-cpp`: thoughts arrive as `segment` chunks, the answer as plain text. */
interface IResponseChunk {
	readonly type?: 'segment';
	readonly segmentType?: 'thought' | 'comment';
	readonly text: string;
}

interface ISessionPromptOptions {
	maxTokens?: number;
	temperature?: number;
	signal?: AbortSignal;
	onResponseChunk?: (chunk: IResponseChunk) => void;
	budgets?: { thoughtTokens?: number };
}

interface ILlamaChatSession {
	prompt(text: string, options?: ISessionPromptOptions): Promise<string>;
	dispose(): void;
}

interface ILlamaCompletion {
	generateCompletion(input: string, options?: IPromptOptions): Promise<string>;
	generateInfillCompletion(prefix: string, suffix: string, options?: IPromptOptions): Promise<string>;
	dispose(): void;
}

/** A single chat turn handed to the engine. */
export interface IChatTurn {
	readonly role: 'system' | 'user' | 'assistant';
	readonly content: string;
}

/** A chat completion split into the (optional) reasoning and the final answer. */
export interface IChatResult {
	readonly thinking: string;
	readonly answer: string;
}

/** What the engine is currently doing, surfaced in the status bar. */
export type LlamaStatus = 'idle' | 'loading' | 'thinking';

/**
 * Loads and serializes access to the local GGUF model. All inference is funnelled through a single
 * promise chain because one context sequence is shared across features.
 */
export class LlamaService {

	private modulePromise: Promise<ILlamaModule | undefined> | undefined;
	private modelPromise: Promise<ILlamaModel | undefined> | undefined;
	private contextPromise: Promise<ILlamaContext | undefined> | undefined;
	private queue: Promise<unknown> = Promise.resolve();
	private warnedMissing = false;

	private _status: LlamaStatus = 'idle';
	private readonly _onDidChangeStatus = new vscode.EventEmitter<LlamaStatus>();
	/** Fires when the engine starts/stops loading or thinking. */
	readonly onDidChangeStatus = this._onDidChangeStatus.event;
	get status(): LlamaStatus { return this._status; }

	constructor(
		private readonly modelPath: () => string,
		/** Returns 'auto' (fit available VRAM) or a positive number to cap the context window. */
		private readonly contextSize: () => 'auto' | number,
		private readonly log: vscode.LogOutputChannel,
	) { }

	private setStatus(status: LlamaStatus): void {
		if (this._status !== status) {
			this._status = status;
			this._onDidChangeStatus.fire(status);
		}
	}

	/** True if the configured model file exists on disk. */
	get modelFileExists(): boolean {
		try {
			return fs.existsSync(this.modelPath());
		} catch {
			return false;
		}
	}

	private async loadModule(): Promise<ILlamaModule | undefined> {
		if (!this.modulePromise) {
			this.modulePromise = (async () => {
				try {
					// node-llama-cpp is ESM-only with top-level await, so it must be loaded with a real
					// dynamic import(). TypeScript would otherwise down-level import() to require() under
					// CommonJS — which fails on ESM/TLA — so we hide it behind `new Function`.
					const mod = await importEsm('node-llama-cpp') as ILlamaModule;
					return mod;
				} catch (err) {
					this.notifyMissing(`The on-device AI engine could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
					return undefined;
				}
			})();
		}
		return this.modulePromise;
	}

	private async loadModel(): Promise<ILlamaModel | undefined> {
		if (!this.modelPromise) {
			this.modelPromise = Promise.resolve(vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Loading vkcode AI model…') },
				async () => {
					const mod = await this.loadModule();
					if (!mod) {
						return undefined;
					}
					const path = this.modelPath();
					if (!this.modelFileExists) {
						this.notifyMissing(vscode.l10n.t('Local AI model not found at "{0}". Set "vkcode.ai.model" to a valid GGUF file.', path));
						return undefined;
					}
					this.setStatus('loading');
					this.log.info(`Loading model: ${path}`);
					const started = Date.now();
					try {
						const llama = await mod.getLlama();
						const model = await llama.loadModel({ modelPath: path });
						this.log.info(`Model loaded in ${((Date.now() - started) / 1000).toFixed(1)}s`);
						return model;
					} catch (err) {
						this.log.error(`Failed to load model: ${err instanceof Error ? err.message : String(err)}`);
						this.notifyMissing(`The on-device AI model could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
						return undefined;
					} finally {
						this.setStatus('idle');
					}
				}));
		}
		return this.modelPromise;
	}

	private notifyMissing(message: string): void {
		if (!this.warnedMissing) {
			this.warnedMissing = true;
			void vscode.window.showWarningMessage(message);
		}
	}

	/**
	 * Creates the inference context once and reuses it across all requests (creating one per request
	 * leaks VRAM). The size auto-fits the available VRAM unless the user pins `vkcode.ai.contextSize`.
	 */
	private async getContext(model: ILlamaModel): Promise<ILlamaContext | undefined> {
		if (!this.contextPromise) {
			this.contextPromise = (async () => {
				const configured = this.contextSize();
				const contextSize = (configured === 'auto' || !(configured > 0)) ? 'auto' as const : { max: configured };
				try {
					const context = await model.createContext({ contextSize });
					this.log.info(`Context ready (requested ${configured}, model trained for ${model.trainContextSize ?? '?'} tokens)`);
					return context;
				} catch (err) {
					this.log.error(`Failed to create context: ${err instanceof Error ? err.message : String(err)}`);
					return undefined;
				}
			})();
		}
		return this.contextPromise;
	}

	/** Resets cached module/model/context handles, e.g. after the model path changes. */
	reset(): void {
		const context = this.contextPromise;
		this.modelPromise = undefined;
		this.contextPromise = undefined;
		this.warnedMissing = false;
		void context?.then(c => c?.dispose()).catch(() => undefined);
	}

	/**
	 * Runs `work` exclusively against a freshly created context sequence. `quiet` requests are logged
	 * at debug level (hidden by default) — used by the high-frequency inline-suggestion path so it
	 * doesn't flood the log on every keystroke.
	 */
	private run<T>(label: string, work: (mod: ILlamaModule, model: ILlamaModel) => Promise<T>, fallback: T, quiet = false): Promise<T> {
		const log = quiet ? this.log.debug.bind(this.log) : this.log.info.bind(this.log);
		const next = this.queue.then(async () => {
			const mod = await this.loadModule();
			const model = await this.loadModel();
			if (!mod || !model) {
				return fallback;
			}
			this.setStatus('thinking');
			log(`${label}: generating…`);
			const started = Date.now();
			try {
				const result = await work(mod, model);
				log(`${label}: done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
				return result;
			} finally {
				this.setStatus('idle');
			}
		}).catch(err => {
			this.setStatus('idle');
			if (err instanceof Error && err.name === 'AbortError') {
				this.log.debug(`${label}: cancelled`);
			} else {
				this.log.error(`${label}: failed — ${err instanceof Error ? err.message : String(err)}`);
			}
			return fallback;
		});
		// Keep the chain alive regardless of individual outcomes.
		this.queue = next.catch(() => undefined);
		return next;
	}

	/**
	 * Runs a chat completion, returning the reasoning and the answer separately.
	 *
	 * `node-llama-cpp` already wraps turns in the model's own chat template, so we pass the raw user
	 * text (no manual "User:"/"Assistant:" prefixes) and let the wrapper handle roles. Thinking is
	 * controlled with `budgets.thoughtTokens`, NOT a `/no_think` soft-switch: by default the engine
	 * lets the model spend most of the context on a `<think>` segment, and the value returned by
	 * `prompt()` excludes that segment — so an answer-only budget (`thoughtTokens: 0`) is what makes
	 * the model actually answer. The reasoning, when allowed, arrives as `segment` response chunks.
	 */
	chat(turns: readonly IChatTurn[], options: IPromptOptions = {}): Promise<IChatResult> {
		return this.run('chat', async (mod, model) => {
			const context = await this.getContext(model);
			if (!context) {
				return { thinking: '', answer: '' };
			}
			const sequence = context.getSequence();
			const systemPrompt = turns.filter(t => t.role === 'system').map(t => t.content).join('\n\n') || undefined;
			// Inline chat sends a single user turn; for the rare multi-turn case we concatenate the
			// non-system turns into one prompt (the wrapper still applies the model's template once).
			const prompt = turns.filter(t => t.role !== 'system').map(t => t.content).join('\n\n');

			const maxTokens = options.maxTokens ?? 1024;
			// think===false → no reasoning at all; think===true → bounded reasoning that still leaves
			// room in the budget for a real answer (otherwise thinking can consume every token).
			const thoughtTokens = options.think === false ? 0 : Math.max(256, maxTokens - 768);

			let thinking = '';
			let answer = '';
			const session = new mod.LlamaChatSession({ contextSequence: sequence, systemPrompt });
			try {
				const returned = await session.prompt(prompt, {
					maxTokens,
					temperature: options.temperature,
					signal: options.signal,
					budgets: { thoughtTokens },
					onResponseChunk: chunk => {
						if (chunk.type === 'segment' && chunk.segmentType === 'thought') {
							thinking += chunk.text;
						} else {
							answer += chunk.text;
						}
					}
				});
				// `returned` is the answer text (segments excluded); prefer the streamed accumulation but
				// fall back to it in case a build doesn't surface chunks.
				const finalAnswer = (answer || returned).trim();
				this.log.info(`chat: thinking=${options.think}, budget=${thoughtTokens}/${maxTokens}, reasoning=${thinking.trim().length} chars, answer=${finalAnswer.length} chars`);
				return { thinking: thinking.trim(), answer: finalAnswer };
			} finally {
				session.dispose();
				sequence.dispose();
			}
		}, { thinking: '', answer: '' });
	}

	/** Generates an instruction-style answer from a system + user prompt (no reasoning by default). */
	async instruct(system: string, user: string, options: IPromptOptions = {}): Promise<string> {
		const result = await this.chat([{ role: 'system', content: system }, { role: 'user', content: user }], { think: false, ...options });
		return result.answer;
	}

	/** Produces a fill-in-the-middle completion for inline suggestions. */
	infill(prefix: string, suffix: string, options: IPromptOptions = {}): Promise<string> {
		return this.run('inline', async (mod, model) => {
			const context = await this.getContext(model);
			if (!context) {
				return '';
			}
			const sequence = context.getSequence();
			const completion = new mod.LlamaCompletion({ contextSequence: sequence });
			try {
				if (model.infillSupported) {
					return await completion.generateInfillCompletion(prefix, suffix, options);
				}
				return await completion.generateCompletion(prefix, options);
			} finally {
				completion.dispose();
				sequence.dispose();
			}
		}, '', /* quiet */ true);
	}

	/** Counts tokens for `text`, falling back to a rough estimate when the model is unavailable. */
	async countTokens(text: string): Promise<number> {
		const model = await this.loadModel();
		if (!model) {
			return Math.ceil(text.length / 4);
		}
		try {
			return model.tokenize(text).length;
		} catch {
			return Math.ceil(text.length / 4);
		}
	}
}
