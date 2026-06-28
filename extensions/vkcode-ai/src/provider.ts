/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IChatTurn, LlamaService } from './llama';

export const QWEN_VENDOR = 'qwen';
const MODEL_ID = 'qwen-local';

/**
 * Exposes the local Qwen model through the language-model API so that inline chat, the chat
 * participant and any other consumer can talk to it via `vscode.lm`. The model advertises
 * `toolCalling: true` because inline chat only considers tool-capable models, even though inline
 * chat sessions themselves do not invoke tools.
 */
export class QwenChatProvider implements vscode.LanguageModelChatProvider {

	constructor(private readonly llama: LlamaService) { }

	provideLanguageModelChatInformation(_options: vscode.PrepareLanguageModelChatModelOptions, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
		const contextSize = vscode.workspace.getConfiguration('vkcode').get<number>('ai.contextSize', 4096);
		return [{
			id: MODEL_ID,
			name: 'Qwen (local)',
			family: 'qwen',
			version: '3.5-4b',
			maxInputTokens: Math.max(1024, contextSize - 512),
			maxOutputTokens: 1024,
			capabilities: { toolCalling: true, imageInput: false },
			isDefault: true,
			isUserSelectable: true
		}];
	}

	async provideLanguageModelChatResponse(_model: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[], _options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<void> {
		const turns = messages.map(toTurn);
		const controller = new AbortController();
		token.onCancellationRequested(() => controller.abort());
		await this.llama.chat(turns, {
			maxTokens: 1024,
			temperature: 0.2,
			signal: controller.signal,
			onTextChunk: chunk => progress.report(new vscode.LanguageModelTextPart(chunk))
		});
	}

	async provideTokenCount(_model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
		const value = typeof text === 'string' ? text : toTurn(text).content;
		return this.llama.countTokens(value);
	}
}

/** Flattens a request message's content parts into a single text turn. */
function toTurn(message: vscode.LanguageModelChatRequestMessage): IChatTurn {
	const parts = message.content as ReadonlyArray<unknown>;
	const text = parts
		.map(part => (part && typeof part === 'object' && 'value' in part && typeof (part as { value: unknown }).value === 'string')
			? (part as { value: string }).value
			: '')
		.join('');
	const role: IChatTurn['role'] = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
	return { role, content: text };
}
