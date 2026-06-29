/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';

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

/** The user's GPU preference from `vkcode.ai.gpu`. */
export type GpuPreference = 'auto' | 'cuda' | 'vulkan' | 'off';

/** Live backend details surfaced in the AI menu. `loaded` is false when the server isn't running. */
export interface IBackendInfo {
	readonly loaded: boolean;
	/** 'cuda' | 'vulkan' | 'cpu' | 'unknown'. */
	readonly backend: string;
	readonly devices: readonly string[];
	/** Bytes; 0 when unknown. */
	readonly vramUsed: number;
	readonly vramTotal: number;
}

interface IPromptOptions {
	maxTokens?: number;
	temperature?: number;
	signal?: AbortSignal;
	/** When `false`, a small reasoning budget keeps the model answering directly; `true` allows a large one. */
	think?: boolean;
	/** Streams reasoning ("thought") text as it is generated. */
	onThinking?: (delta: string) => void;
	/** Streams answer text as it is generated. */
	onAnswer?: (delta: string) => void;
}

/**
 * Manages a local `llama.cpp` server process and talks to it over its OpenAI-compatible HTTP API.
 * Running the model out-of-process (instead of an in-process native binding) lets us use the latest
 * upstream `llama.cpp` build, which supports modern architectures such as Gemma 4. The server is
 * started lazily on first use and reused; `unload()` stops it to free VRAM.
 */
export class LlamaService {

	private serverProcess: cp.ChildProcess | undefined;
	private startPromise: Promise<number | undefined> | undefined;
	private port = 0;
	private inFlight = 0;
	private warnedMissing = false;
	private lastDeviceInfo = '';

	private _status: LlamaStatus = 'idle';
	private readonly _onDidChangeStatus = new vscode.EventEmitter<LlamaStatus>();
	/** Fires when the engine starts/stops loading or thinking. */
	readonly onDidChangeStatus = this._onDidChangeStatus.event;
	get status(): LlamaStatus { return this._status; }

	constructor(
		private readonly modelPath: () => string,
		/** Returns 'auto' (use the model's trained size) or a positive number to cap the context window. */
		private readonly contextSize: () => 'auto' | number,
		/** Returns the user's GPU backend preference. */
		private readonly gpuPreference: () => GpuPreference,
		/** Returns the path to the llama.cpp server executable. */
		private readonly serverPath: () => string,
		private readonly log: vscode.LogOutputChannel,
	) { }

	private setStatus(status: LlamaStatus): void {
		if (this._status !== status) {
			this._status = status;
			this._onDidChangeStatus.fire(status);
		}
	}

	/** True if the configured model and server executables exist on disk. */
	get modelFileExists(): boolean {
		try {
			return fs.existsSync(this.modelPath());
		} catch {
			return false;
		}
	}

	private notifyMissing(message: string): void {
		if (!this.warnedMissing) {
			this.warnedMissing = true;
			void vscode.window.showWarningMessage(message);
		}
	}

	/** Picks a free localhost TCP port for the server. */
	private static findFreePort(): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			const srv = net.createServer();
			srv.on('error', reject);
			srv.listen(0, '127.0.0.1', () => {
				const port = (srv.address() as net.AddressInfo).port;
				srv.close(() => resolve(port));
			});
		});
	}

	/** Maps the GPU preference to a llama.cpp `--n-gpu-layers` value (0 = CPU, 999 = offload all). */
	private gpuLayers(): number {
		return this.gpuPreference() === 'off' ? 0 : 999;
	}

	/** Starts the server (once) and resolves with its port, or undefined if it could not be started. */
	private ensureServer(): Promise<number | undefined> {
		if (!this.startPromise) {
			this.startPromise = this.startServer();
		}
		return this.startPromise;
	}

	private async startServer(): Promise<number | undefined> {
		const server = this.serverPath();
		const model = this.modelPath();
		if (!fs.existsSync(server)) {
			this.notifyMissing(vscode.l10n.t('The local AI server was not found at "{0}". Set "vkcode.ai.serverPath".', server));
			return undefined;
		}
		if (!fs.existsSync(model)) {
			this.notifyMissing(vscode.l10n.t('Local AI model not found at "{0}". Set "vkcode.ai.model" to a valid GGUF file.', model));
			return undefined;
		}

		this.setStatus('loading');
		const started = Date.now();
		return Promise.resolve(vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Loading vkcode AI model…') },
			async () => {
				try {
					const port = await LlamaService.findFreePort();
					const configured = this.contextSize();
					const ctx = configured === 'auto' || !(configured > 0) ? 0 : configured;
					const args = [
						'-m', model,
						'--host', '127.0.0.1',
						'--port', String(port),
						'-ngl', String(this.gpuLayers()),
						'-c', String(ctx),
						'--no-webui',
						'--jinja'
					];
					this.log.info(`Loading model "${path.basename(model)}" (server ${path.basename(server)}, -ngl ${this.gpuLayers()}, -c ${ctx}, port ${port})`);
					const proc = cp.spawn(server, args, { cwd: path.dirname(server), windowsHide: true });
					this.serverProcess = proc;

					proc.stderr?.setEncoding('utf8');
					proc.stderr?.on('data', (chunk: string) => this.onServerLog(chunk));
					proc.on('exit', code => {
						this.log.info(`llama-server exited (code ${code ?? 'signal'})`);
						if (this.serverProcess === proc) {
							this.serverProcess = undefined;
							this.startPromise = undefined;
							this.port = 0;
						}
					});

					await this.waitForHealth(port, proc);
					this.port = port;
					this.log.info(`Model "${path.basename(model)}" ready in ${((Date.now() - started) / 1000).toFixed(1)}s${this.lastDeviceInfo ? ` · ${this.lastDeviceInfo}` : ''}`);
					return port;
				} catch (err) {
					this.log.error(`Failed to start llama-server: ${err instanceof Error ? err.message : String(err)}`);
					this.notifyMissing(vscode.l10n.t('The local AI model could not be loaded: {0}', err instanceof Error ? err.message : String(err)));
					await this.unload();
					return undefined;
				} finally {
					this.setStatus('idle');
				}
			}));
	}

	/** Extracts the GPU device line from the server log so the backend can be shown in the menu. */
	private onServerLog(chunk: string): void {
		for (const line of chunk.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}
			const device = trimmed.match(/using device \w+ \(([^)]+)\)/i);
			if (device) {
				this.lastDeviceInfo = device[1];
			}
			if (/error|failed|unknown model architecture/i.test(trimmed)) {
				this.log.warn(`llama-server: ${trimmed}`);
			} else {
				this.log.trace(`llama-server: ${trimmed}`);
			}
		}
	}

	/** Polls the server's /health endpoint until it reports ready, or the process dies / times out. */
	private async waitForHealth(port: number, proc: cp.ChildProcess): Promise<void> {
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline) {
			if (proc.exitCode !== null) {
				throw new Error('the server process exited during startup (see the vkcode AI log)');
			}
			try {
				const res = await fetch(`http://127.0.0.1:${port}/health`);
				if (res.ok) {
					return;
				}
			} catch {
				// not up yet
			}
			await new Promise(resolve => setTimeout(resolve, 300));
		}
		throw new Error('timed out waiting for the model to load');
	}

	private base(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	/** Stops the server, freeing its memory/VRAM. The next request restarts it lazily. */
	async unload(): Promise<void> {
		const proc = this.serverProcess;
		this.serverProcess = undefined;
		this.startPromise = undefined;
		this.port = 0;
		if (proc && proc.exitCode === null) {
			await new Promise<void>(resolve => {
				const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 2000);
				proc.once('exit', () => { clearTimeout(timer); resolve(); });
				proc.kill();
			});
			this.log.info('Model unloaded; memory released.');
		}
		this.setStatus('idle');
	}

	/** Restarts the server, e.g. after the model path or GPU preference changes. */
	reset(): void {
		this.warnedMissing = false;
		void this.unload();
	}

	/** Tracks an in-flight request so the status bar shows the engine is busy. */
	private async track<T>(work: () => Promise<T>, fallback: T): Promise<T> {
		this.inFlight++;
		this.setStatus('thinking');
		try {
			return await work();
		} catch (err) {
			if (err instanceof Error && err.name === 'AbortError') {
				this.log.debug('request cancelled');
			} else {
				this.log.error(`request failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			return fallback;
		} finally {
			if (--this.inFlight === 0) {
				this.setStatus('idle');
			}
		}
	}

	/**
	 * Runs a chat completion, returning the reasoning and the answer separately. Modern reasoning
	 * models (Qwen3, Gemma 4) stream a `reasoning_content` field alongside `content`; we keep the two
	 * apart so the reasoning can be surfaced as progress/logs while only the answer reaches the editor.
	 */
	chat(turns: readonly IChatTurn[], options: IPromptOptions = {}): Promise<IChatResult> {
		return this.track(async () => {
			const port = await this.ensureServer();
			if (!port) {
				return { thinking: '', answer: '' };
			}
			const maxTokens = options.maxTokens ?? (options.think === false ? 1024 : 3072);
			const messages = turns.map(t => ({ role: t.role, content: t.content }));
			let thinking = '';
			let answer = '';
			await this.stream('/v1/chat/completions', {
				messages,
				max_tokens: maxTokens,
				temperature: options.temperature ?? 0.2,
				stream: true
			}, options.signal, delta => {
				if (typeof delta.reasoning_content === 'string') {
					thinking += delta.reasoning_content;
					options.onThinking?.(delta.reasoning_content);
				}
				if (typeof delta.content === 'string') {
					answer += delta.content;
					options.onAnswer?.(delta.content);
				}
			});
			const finalThinking = thinking.trim();
			const finalAnswer = answer.trim();
			this.log.info(`chat [${path.basename(this.modelPath())}]: thinking=${options.think}, reasoning=${finalThinking.length} chars, answer=${finalAnswer.length} chars`);
			if (finalThinking) {
				this.log.info(`chat reasoning:\n${finalThinking}`);
			}
			return { thinking: finalThinking, answer: finalAnswer };
		}, { thinking: '', answer: '' });
	}

	/** Generates an instruction-style answer from a system + user prompt (no reasoning by default). */
	async instruct(system: string, user: string, options: IPromptOptions = {}): Promise<string> {
		const result = await this.chat([{ role: 'system', content: system }, { role: 'user', content: user }], { think: false, ...options });
		return result.answer;
	}

	/** Produces a fill-in-the-middle completion for inline suggestions. */
	infill(prefix: string, suffix: string, options: IPromptOptions = {}): Promise<string> {
		return this.track(async () => {
			const port = await this.ensureServer();
			if (!port) {
				return '';
			}
			const res = await fetch(`${this.base()}/infill`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					input_prefix: prefix,
					input_suffix: suffix,
					n_predict: options.maxTokens ?? 64,
					temperature: options.temperature ?? 0.1
				}),
				signal: options.signal
			});
			if (!res.ok) {
				return '';
			}
			const json = await res.json() as { content?: string };
			return json.content ?? '';
		}, '');
	}

	/** Counts tokens for `text`, falling back to a rough estimate when the server is unavailable. */
	async countTokens(text: string): Promise<number> {
		try {
			const port = await this.ensureServer();
			if (port) {
				const res = await fetch(`${this.base()}/tokenize`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ content: text })
				});
				if (res.ok) {
					const json = await res.json() as { tokens?: unknown[] };
					if (Array.isArray(json.tokens)) {
						return json.tokens.length;
					}
				}
			}
		} catch {
			// fall through to estimate
		}
		return Math.ceil(text.length / 4);
	}

	/** Live backend/VRAM details for the AI menu. */
	async getBackendInfo(): Promise<IBackendInfo> {
		const loaded = !!this.serverProcess && this.port !== 0;
		const backend = this.gpuPreference() === 'off' ? 'cpu' : (this.lastDeviceInfo ? 'cuda' : 'unknown');
		return {
			loaded,
			backend,
			devices: this.lastDeviceInfo ? [this.lastDeviceInfo] : [],
			vramUsed: 0,
			vramTotal: 0
		};
	}

	/** POSTs a streaming request and dispatches each SSE delta to `onDelta`. */
	private async stream(
		endpoint: string,
		body: object,
		signal: AbortSignal | undefined,
		onDelta: (delta: { content?: unknown; reasoning_content?: unknown }) => void
	): Promise<void> {
		const res = await fetch(`${this.base()}${endpoint}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal
		});
		if (!res.ok || !res.body) {
			throw new Error(`server returned ${res.status}`);
		}
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		for (; ;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let nl: number;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (!line.startsWith('data:')) {
					continue;
				}
				const data = line.slice(5).trim();
				if (data === '[DONE]') {
					return;
				}
				try {
					const json = JSON.parse(data) as { choices?: { delta?: { content?: unknown; reasoning_content?: unknown } }[] };
					const delta = json.choices?.[0]?.delta;
					if (delta) {
						onDelta(delta);
					}
				} catch {
					// ignore keep-alive / non-JSON lines
				}
			}
		}
	}
}
