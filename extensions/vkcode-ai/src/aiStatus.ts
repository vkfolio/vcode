/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { LlamaService } from './llama';

/** Reads the master AI enablement flag. */
export function isAiEnabled(): boolean {
	return vscode.workspace.getConfiguration('vkcode').get<boolean>('ai.enabled', true);
}

/**
 * Bottom status-bar item for the on-device AI. Shows a spinner while the model is loading or thinking
 * (so it's obvious work is happening), and toggles `vkcode.ai.enabled` on click. Clicking while the
 * model is busy opens the "vkcode AI" output log instead.
 */
export function registerAiStatus(context: vscode.ExtensionContext, llama: LlamaService, output: vscode.LogOutputChannel): void {
	const item = vscode.window.createStatusBarItem('vkcode.ai.status', vscode.StatusBarAlignment.Right, 40);
	item.name = vscode.l10n.t('vkcode AI');

	const render = () => {
		const on = isAiEnabled();
		const status = llama.status;
		if (on && status === 'loading') {
			item.text = '$(loading~spin) AI model…';
			item.tooltip = vscode.l10n.t('Loading the local AI model… (click to view logs)');
			item.command = 'vkcode.ai.showOutput';
		} else if (on && status === 'thinking') {
			item.text = '$(loading~spin) AI…';
			item.tooltip = vscode.l10n.t('The local AI is thinking… (click to view logs)');
			item.command = 'vkcode.ai.showOutput';
		} else {
			item.text = on ? '$(sparkle) AI' : '$(circle-slash) AI';
			item.tooltip = on
				? vscode.l10n.t('vkcode AI is on — click to turn off')
				: vscode.l10n.t('vkcode AI is off — click to turn on');
			item.command = 'vkcode.ai.toggle';
		}
		item.show();
	};

	const toggle = vscode.commands.registerCommand('vkcode.ai.toggle', async () => {
		const config = vscode.workspace.getConfiguration('vkcode');
		const next = !config.get<boolean>('ai.enabled', true);
		await config.update('ai.enabled', next, vscode.ConfigurationTarget.Global);
	});

	const showOutput = vscode.commands.registerCommand('vkcode.ai.showOutput', () => output.show(true));

	const toggleThinking = vscode.commands.registerCommand('vkcode.ai.toggleThinking', async () => {
		const config = vscode.workspace.getConfiguration('vkcode');
		const next = !config.get<boolean>('ai.thinking', false);
		await config.update('ai.thinking', next, vscode.ConfigurationTarget.Global);
		void vscode.window.showInformationMessage(next
			? vscode.l10n.t('vkcode AI reasoning is ON — the model will think before answering.')
			: vscode.l10n.t('vkcode AI reasoning is OFF — the model answers directly.'));
	});

	const onChange = vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('vkcode.ai.enabled')) {
			render();
		}
	});

	render();
	context.subscriptions.push(item, toggle, showOutput, toggleThinking, onChange, llama.onDidChangeStatus(() => render()));
}
