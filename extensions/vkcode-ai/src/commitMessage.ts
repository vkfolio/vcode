/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { isAiEnabled } from './aiStatus';
import { LlamaService } from './llama';

const DIFF_BUDGET = 6000;

const SYSTEM_PROMPT = [
	'You write git commit messages. Follow the Conventional Commits style:',
	'a short imperative subject line (max 72 chars) of the form "type(scope): summary",',
	'optionally followed by a blank line and a concise body. Reply with the commit message only,',
	'no code fences, no commentary.'
].join(' ');

/** Minimal view of the parts of the git extension API that we use. */
interface IGitInputBox { value: string }
interface IGitRepository {
	readonly rootUri: vscode.Uri;
	readonly inputBox: IGitInputBox;
	diff(cached?: boolean): Promise<string>;
}
interface IGitAPI { readonly repositories: readonly IGitRepository[] }
interface IGitExtension { getAPI(version: 1): IGitAPI }

/**
 * Registers the local "Generate Commit Message" command used by the Source Control input. Reads the
 * staged diff and asks the local model for a Conventional-Commits message, writing it into the input.
 */
export function registerCommitMessage(context: vscode.ExtensionContext, llama: LlamaService): void {
	const command = vscode.commands.registerCommand('vkcode.git.generateCommitMessage', async (arg?: unknown) => {
		if (!isAiEnabled()) {
			void vscode.window.showInformationMessage(vscode.l10n.t('vkcode AI is turned off. Enable it from the AI toggle in the status bar.'));
			return;
		}

		const api = await getGitApi();
		if (!api) {
			void vscode.window.showWarningMessage(vscode.l10n.t('The git extension is not available.'));
			return;
		}

		const repository = pickRepository(api, arg);
		if (!repository) {
			void vscode.window.showWarningMessage(vscode.l10n.t('No git repository found.'));
			return;
		}

		const staged = (await repository.diff(true)).trim();
		if (!staged) {
			void vscode.window.showInformationMessage(vscode.l10n.t('No staged changes to summarize. Stage some changes first.'));
			return;
		}

		await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title: vscode.l10n.t('Generating commit message…') }, async () => {
			const diff = staged.length > DIFF_BUDGET ? `${staged.slice(0, DIFF_BUDGET)}\n…(truncated)` : staged;
			const message = (await llama.instruct(SYSTEM_PROMPT, `Write a commit message for this staged diff:\n\n${diff}`, { maxTokens: 200, temperature: 0.2 })).trim();
			if (message) {
				repository.inputBox.value = stripFences(message);
			} else {
				void vscode.window.showWarningMessage(vscode.l10n.t('The local model did not return a commit message.'));
			}
		});
	});

	context.subscriptions.push(command);
}

async function getGitApi(): Promise<IGitAPI | undefined> {
	const extension = vscode.extensions.getExtension<IGitExtension>('vscode.git');
	if (!extension) {
		return undefined;
	}
	if (!extension.isActive) {
		await extension.activate();
	}
	return extension.exports.getAPI(1);
}

/** Resolves the repository from the command argument (SCM passes a repository-like object) or falls back to the first one. */
function pickRepository(api: IGitAPI, arg: unknown): IGitRepository | undefined {
	if (arg && typeof arg === 'object' && 'rootUri' in arg) {
		const root = (arg as { rootUri?: vscode.Uri }).rootUri;
		const match = api.repositories.find(r => r.rootUri.toString() === root?.toString());
		if (match) {
			return match;
		}
	}
	return api.repositories[0];
}

/** Removes a wrapping ``` code fence the model may have added. */
function stripFences(message: string): string {
	const fenced = message.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
	return (fenced ? fenced[1] : message).trim();
}
