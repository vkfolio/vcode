/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { isAiEnabled } from './aiStatus';
import { LlamaService } from './llama';

const PREFIX_BUDGET = 2000;
const SUFFIX_BUDGET = 500;
const DEBOUNCE_MS = 200;
const MAX_TOKENS = 64;

/**
 * Inline (ghost text) suggestions from the local model using fill-in-the-middle over the text around
 * the cursor. Honors the master AI switch, `vkcode.inlineSuggest.enabled` and the core
 * `editor.inlineSuggest.enabled`, and cancels in-flight inference when the user keeps typing.
 */
export function registerInlineCompletions(context: vscode.ExtensionContext, llama: LlamaService): void {
	const provider: vscode.InlineCompletionItemProvider = {
		async provideInlineCompletionItems(document, position, _ctx, token) {
			const config = vscode.workspace.getConfiguration('vkcode', document);
			if (!isAiEnabled() || !config.get<boolean>('inlineSuggest.enabled', true)) {
				return undefined;
			}
			if (!vscode.workspace.getConfiguration('editor', document).get<boolean>('inlineSuggest.enabled', true)) {
				return undefined;
			}

			if (await delayOrCancel(DEBOUNCE_MS, token)) {
				return undefined;
			}

			const offset = document.offsetAt(position);
			const fullText = document.getText();
			const prefix = fullText.slice(Math.max(0, offset - PREFIX_BUDGET), offset);
			const suffix = fullText.slice(offset, offset + SUFFIX_BUDGET);
			if (prefix.trim().length === 0) {
				return undefined;
			}

			const controller = new AbortController();
			token.onCancellationRequested(() => controller.abort());

			const completion = (await llama.infill(prefix, suffix, { maxTokens: MAX_TOKENS, temperature: 0.1, signal: controller.signal })).trimEnd();
			if (!completion || token.isCancellationRequested) {
				return undefined;
			}

			return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
		}
	};

	context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider));
}

/** Resolves to true if cancelled during the debounce window. */
function delayOrCancel(ms: number, token: vscode.CancellationToken): Promise<boolean> {
	return new Promise<boolean>(resolve => {
		const timer = setTimeout(() => {
			disposable.dispose();
			resolve(token.isCancellationRequested);
		}, ms);
		const disposable = token.onCancellationRequested(() => {
			clearTimeout(timer);
			disposable.dispose();
			resolve(true);
		});
	});
}
