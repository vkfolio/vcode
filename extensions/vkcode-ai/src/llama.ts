/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as vscode from 'vscode';

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
	createContext(options?: { contextSize?: number }): Promise<ILlamaContext>;
	readonly infillSupported: boolean;
	tokenize(text: string): number[];
}

interface ILlamaContext {
	getSequence(): ILlamaContextSequence;
}

interface ILlamaContextSequence {
	dispose(): void;
}

interface IPromptOptions {
	maxTokens?: number;
	temperature?: number;
	signal?: AbortSignal;
	onTextChunk?: (chunk: string) => void;
}

interface ILlamaChatSession {
	prompt(text: string, options?: IPromptOptions): Promise<string>;
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

/**
 * Loads and serializes access to the local GGUF model. All inference is funnelled through a single
 * promise chain because one context sequence is shared across features.
 */
export class LlamaService {

	private modulePromise: Promise<ILlamaModule | undefined> | undefined;
	private modelPromise: Promise<ILlamaModel | undefined> | undefined;
	private queue: Promise<unknown> = Promise.resolve();
	private warnedMissing = false;

	constructor(private readonly modelPath: () => string, private readonly contextSize: () => number) { }

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
					// Indirect specifier so the TypeScript compiler does not try to resolve the optional
					// native module at build time; Node resolves it at runtime from the extension's deps.
					const specifier = 'node-llama-cpp';
					const mod = await import(specifier) as ILlamaModule;
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
			this.modelPromise = (async () => {
				const mod = await this.loadModule();
				if (!mod) {
					return undefined;
				}
				const path = this.modelPath();
				if (!this.modelFileExists) {
					this.notifyMissing(vscode.l10n.t('Local AI model not found at "{0}". Set "vkcode.ai.model" to a valid GGUF file.', path));
					return undefined;
				}
				const llama = await mod.getLlama();
				return llama.loadModel({ modelPath: path });
			})();
		}
		return this.modelPromise;
	}

	private notifyMissing(message: string): void {
		if (!this.warnedMissing) {
			this.warnedMissing = true;
			void vscode.window.showWarningMessage(message);
		}
	}

	/** Resets cached module/model handles, e.g. after the model path changes. */
	reset(): void {
		this.modelPromise = undefined;
		this.warnedMissing = false;
	}

	/** Runs `work` exclusively against a freshly created context sequence. */
	private run<T>(work: (mod: ILlamaModule, model: ILlamaModel) => Promise<T>, fallback: T): Promise<T> {
		const next = this.queue.then(async () => {
			const mod = await this.loadModule();
			const model = await this.loadModel();
			if (!mod || !model) {
				return fallback;
			}
			return work(mod, model);
		}).catch(err => {
			if (!(err instanceof Error && err.name === 'AbortError')) {
				console.error('[vkcode-ai] inference failed', err);
			}
			return fallback;
		});
		// Keep the chain alive regardless of individual outcomes.
		this.queue = next.catch(() => undefined);
		return next;
	}

	/** Streams a chat completion, returning the full text. */
	chat(turns: readonly IChatTurn[], options: IPromptOptions = {}): Promise<string> {
		return this.run(async (mod, model) => {
			const context = await model.createContext({ contextSize: this.contextSize() });
			const sequence = context.getSequence();
			const systemPrompt = turns.filter(t => t.role === 'system').map(t => t.content).join('\n\n') || undefined;
			const conversation = turns
				.filter(t => t.role !== 'system')
				.map(t => `${t.role === 'assistant' ? 'Assistant' : 'User'}: ${t.content}`)
				.join('\n\n');
			const session = new mod.LlamaChatSession({ contextSequence: sequence, systemPrompt });
			try {
				return await session.prompt(conversation, options);
			} finally {
				session.dispose();
				sequence.dispose();
			}
		}, '');
	}

	/** Generates an instruction-style response from a system + user prompt. */
	instruct(system: string, user: string, options: IPromptOptions = {}): Promise<string> {
		return this.chat([{ role: 'system', content: system }, { role: 'user', content: user }], options);
	}

	/** Produces a fill-in-the-middle completion for inline suggestions. */
	infill(prefix: string, suffix: string, options: IPromptOptions = {}): Promise<string> {
		return this.run(async (mod, model) => {
			const context = await model.createContext({ contextSize: this.contextSize() });
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
		}, '');
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
