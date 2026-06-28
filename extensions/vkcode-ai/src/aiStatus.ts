/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** Reads the master AI enablement flag. */
export function isAiEnabled(): boolean {
	return vscode.workspace.getConfiguration('vkcode').get<boolean>('ai.enabled', true);
}

/**
 * Bottom status-bar toggle for the on-device AI. Flipping it updates `vkcode.ai.enabled`, which the
 * inline-completion provider, chat participant and commit-message command all consult before running.
 */
export function registerAiStatus(context: vscode.ExtensionContext): void {
	const item = vscode.window.createStatusBarItem('vkcode.ai.status', vscode.StatusBarAlignment.Right, 40);
	item.name = vscode.l10n.t('vkcode AI');
	item.command = 'vkcode.ai.toggle';

	const render = () => {
		const on = isAiEnabled();
		item.text = on ? '$(sparkle) AI' : '$(circle-slash) AI';
		item.tooltip = on
			? vscode.l10n.t('vkcode AI is on — click to turn off')
			: vscode.l10n.t('vkcode AI is off — click to turn on');
		item.show();
	};

	const toggle = vscode.commands.registerCommand('vkcode.ai.toggle', async () => {
		const config = vscode.workspace.getConfiguration('vkcode');
		const next = !config.get<boolean>('ai.enabled', true);
		await config.update('ai.enabled', next, vscode.ConfigurationTarget.Global);
	});

	const onChange = vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('vkcode.ai.enabled')) {
			render();
		}
	});

	render();
	context.subscriptions.push(item, toggle, onChange);
}
