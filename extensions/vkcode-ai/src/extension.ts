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
import { LOCAL_VENDOR, LocalChatProvider } from './provider';

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
		() => {
			const value = config().get<string>('ai.gpu', 'auto');
			return value === 'cuda' || value === 'vulkan' || value === 'off' ? value : 'auto';
		},
		() => config().get<string>('ai.serverPath', ''),
		output
	);
	// Stop the model server when the extension is unloaded.
	context.subscriptions.push({ dispose: () => void llama.unload() });

	// Reload the model if the user points at a different GGUF file, context size, GPU backend or server,
	// and free memory entirely when the master switch is turned off.
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('vkcode.ai.model') || e.affectsConfiguration('vkcode.ai.contextSize') || e.affectsConfiguration('vkcode.ai.gpu') || e.affectsConfiguration('vkcode.ai.serverPath')) {
			llama.reset();
		}
		if (e.affectsConfiguration('vkcode.ai.enabled') && !config().get<boolean>('ai.enabled', true)) {
			void llama.unload();
		}
	}));

	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(LOCAL_VENDOR, new LocalChatProvider(llama)));

	registerAiStatus(context, llama, output);
	registerChatParticipant(context, llama, output);
	registerInlineCompletions(context, llama);
	registerCommitMessage(context, llama);
}

export function deactivate(): void {
	// Nothing to clean up beyond the disposables registered on the context.
}
