/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LlamaService } from './llama';

/** Reads the master AI enablement flag. */
export function isAiEnabled(): boolean {
	return vscode.workspace.getConfiguration('vkcode').get<boolean>('ai.enabled', true);
}

/** A QuickPick row bound to an action. */
interface IMenuItem extends vscode.QuickPickItem {
	run?: () => void | Thenable<void>;
}

/**
 * Bottom status-bar item for the on-device AI. Shows a spinner while the model is loading or thinking
 * (so it's obvious work is happening); clicking it while idle opens a QuickPick control center (toggle
 * AI, pick model, reasoning, backend/VRAM status, logs, unload), and clicking while busy opens the
 * "vkcode AI" output log.
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
				? vscode.l10n.t('vkcode AI — click for options')
				: vscode.l10n.t('vkcode AI is off — click for options');
			item.command = 'vkcode.ai.menu';
		}
		item.show();
	};

	const setEnabled = (value: boolean) =>
		vscode.workspace.getConfiguration('vkcode').update('ai.enabled', value, vscode.ConfigurationTarget.Global);

	const toggle = vscode.commands.registerCommand('vkcode.ai.toggle', () => setEnabled(!isAiEnabled()));

	const showOutput = vscode.commands.registerCommand('vkcode.ai.showOutput', () => output.show(true));

	const toggleThinking = vscode.commands.registerCommand('vkcode.ai.toggleThinking', async () => {
		const config = vscode.workspace.getConfiguration('vkcode');
		const next = !config.get<boolean>('ai.thinking', false);
		await config.update('ai.thinking', next, vscode.ConfigurationTarget.Global);
		void vscode.window.showInformationMessage(next
			? vscode.l10n.t('vkcode AI reasoning is ON — the model will think before answering.')
			: vscode.l10n.t('vkcode AI reasoning is OFF — the model answers directly.'));
	});

	const unload = vscode.commands.registerCommand('vkcode.ai.unload', async () => {
		await llama.unload();
		void vscode.window.showInformationMessage(vscode.l10n.t('vkcode AI model unloaded; memory released.'));
	});

	const selectModel = vscode.commands.registerCommand('vkcode.ai.selectModel', () => pickModel());

	const menu = vscode.commands.registerCommand('vkcode.ai.menu', () => openMenu());

	async function openMenu(): Promise<void> {
		const config = vscode.workspace.getConfiguration('vkcode');
		const on = isAiEnabled();
		const thinking = config.get<boolean>('ai.thinking', false);
		const modelName = path.basename(config.get<string>('ai.model', '')) || vscode.l10n.t('(not set)');

		const items: IMenuItem[] = [
			{
				label: on ? '$(circle-slash) Turn AI Off' : '$(sparkle) Turn AI On',
				description: on ? vscode.l10n.t('Currently on') : vscode.l10n.t('Currently off'),
				run: () => setEnabled(!on)
			},
			{
				label: thinking ? '$(lightbulb-autofix) Reasoning: On' : '$(lightbulb) Reasoning: Off',
				description: vscode.l10n.t('Step-by-step reasoning'),
				run: () => vscode.commands.executeCommand('vkcode.ai.toggleThinking')
			},
			{
				label: `$(server) Model: ${modelName}`,
				description: vscode.l10n.t('Switch model'),
				run: () => pickModel()
			},
			{
				label: `$(chip) ${await backendLabel()}`,
				description: vscode.l10n.t('Open logs'),
				run: () => output.show(true)
			},
			{ label: '', kind: vscode.QuickPickItemKind.Separator },
			{ label: '$(output) Show Logs', run: () => output.show(true) },
			{ label: '$(trash) Unload Model (free memory)', run: () => vscode.commands.executeCommand('vkcode.ai.unload') }
		];

		const picked = await vscode.window.showQuickPick(items, {
			title: vscode.l10n.t('vkcode AI'),
			placeHolder: vscode.l10n.t('Choose an action')
		});
		await picked?.run?.();
	}

	async function backendLabel(): Promise<string> {
		const info = await llama.getBackendInfo();
		if (info.backend === 'unknown') {
			return vscode.l10n.t('Backend: (load a model to view)');
		}
		const name = info.backend === 'cpu' ? 'CPU' : info.backend.toUpperCase();
		const device = info.backend === 'cpu' ? '' : ` · ${info.devices[0] ?? 'GPU'}`;
		const vram = info.vramTotal ? ` · VRAM ${gb(info.vramUsed)}/${gb(info.vramTotal)} GB` : '';
		return `Backend: ${name}${device}${vram}`;
	}

	async function pickModel(): Promise<void> {
		const config = vscode.workspace.getConfiguration('vkcode');
		const current = config.get<string>('ai.model', '').replace(/\\/g, '/');
		const models = discoverModels(current);
		if (models.length === 0) {
			void vscode.window.showWarningMessage(vscode.l10n.t('No .gguf models found next to the configured model.'));
			return;
		}
		const items = models.map<IMenuItem>(file => ({
			label: `${file === current ? '$(check) ' : '$(circle-large-outline) '}${path.basename(file)}`,
			description: path.dirname(file),
			run: () => config.update('ai.model', file, vscode.ConfigurationTarget.Global)
		}));
		const picked = await vscode.window.showQuickPick(items, {
			title: vscode.l10n.t('Select AI Model'),
			placeHolder: vscode.l10n.t('Switching reloads the engine')
		});
		await picked?.run?.();
	}

	const onChange = vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('vkcode.ai.enabled')) {
			render();
		}
	});

	render();
	context.subscriptions.push(item, toggle, showOutput, toggleThinking, unload, selectModel, menu, onChange, llama.onDidChangeStatus(() => render()));
}

/** Formats a byte count as a one-decimal gigabyte string. */
function gb(bytes: number): string {
	return (bytes / (1024 ** 3)).toFixed(1);
}

/**
 * Finds `*.gguf` models (excluding `mmproj*` vision projectors) under the models root, scanned
 * recursively. The root is the nearest ancestor folder named "models" (so models in sibling
 * subfolders like `models/gemma/` are all found), falling back to the configured model's folder.
 * Always includes the configured model itself.
 */
function discoverModels(configured: string): string[] {
	// Normalize to forward slashes so the result is valid in settings.json and works regardless of
	// whether the configured path used `\` or `/` (Windows fs accepts both).
	const norm = configured.replace(/\\/g, '/');
	const found = new Set<string>();
	if (norm && fs.existsSync(norm)) {
		found.add(norm);
	}
	const root = modelsRoot(norm);
	const scan = (dir: string, depth: number) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = `${dir}/${entry.name}`;
			if (entry.isDirectory()) {
				if (depth > 0) {
					scan(full, depth - 1);
				}
			} else if (entry.name.toLowerCase().endsWith('.gguf') && !entry.name.toLowerCase().startsWith('mmproj')) {
				found.add(full);
			}
		}
	};
	if (root) {
		scan(root, 3);
	}
	return [...found].sort();
}

/** Walks up from the (forward-slash) configured model to the nearest "models" folder, else its folder. */
function modelsRoot(configured: string): string {
	if (!configured) {
		return '';
	}
	let dir = path.posix.dirname(configured);
	for (let i = 0; i < 4; i++) {
		if (path.posix.basename(dir).toLowerCase() === 'models') {
			return dir;
		}
		const parent = path.posix.dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	return path.posix.dirname(configured);
}
