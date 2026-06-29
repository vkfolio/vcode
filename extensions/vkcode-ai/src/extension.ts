/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { registerAiStatus } from './aiStatus';
import { registerChatParticipant } from './participant';
import { registerCommitMessage } from './commitMessage';
import { registerInlineCompletions } from './inlineCompletions';
import { LlamaService } from './llama';
import { QWEN_VENDOR, QwenChatProvider } from './provider';

export function activate(context: vscode.ExtensionContext): void {
	const config = () => vscode.workspace.getConfiguration('vkcode');
	// A log channel the user can open ("Output → vkcode AI") to watch model loading and each request.
	const output = vscode.window.createOutputChannel('vkcode AI', { log: true });
	context.subscriptions.push(output);
	const llama = new LlamaService(
		() => config().get<string>('ai.model', ''),
		() => {
			const value = config().get<string | number>('ai.contextSize', 'auto');
			return typeof value === 'number' && value > 0 ? value : 'auto';
		},
		output
	);

	// Reload the model if the user points at a different GGUF file.
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('vkcode.ai.model') || e.affectsConfiguration('vkcode.ai.contextSize')) {
			llama.reset();
		}
	}));

	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(QWEN_VENDOR, new QwenChatProvider(llama)));

	registerAiStatus(context, llama, output);
	registerChatParticipant(context, output);
	registerInlineCompletions(context, llama);
	registerCommitMessage(context, llama);
}

export function deactivate(): void {
	// Nothing to clean up beyond the disposables registered on the context.
}
