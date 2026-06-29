/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { isAiEnabled } from './aiStatus';
import { QWEN_VENDOR } from './provider';

const PARTICIPANT_ID = 'vkcode.ai';

/**
 * Registers the default chat participant. Being a default participant with an implementation is what
 * makes `chatIsEnabled` true in the workbench, which in turn enables inline chat (Ctrl+I), terminal
 * chat and notebook chat — all routed to the local Qwen model via `vscode.lm`.
 */
export function registerChatParticipant(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): void {
	const handler: vscode.ChatRequestHandler = async (request, chatContext, response, token) => {
		log.info(`chat participant invoked: "${request.prompt.slice(0, 80)}"`);
		if (!isAiEnabled()) {
			response.markdown(vscode.l10n.t('vkcode AI is turned off. Enable it from the **AI** toggle in the status bar.'));
			return {};
		}

		const [model] = await vscode.lm.selectChatModels({ vendor: QWEN_VENDOR });
		if (!model) {
			response.markdown(vscode.l10n.t('The local AI model is not available. Check the `vkcode.ai.model` setting.'));
			return {};
		}

		const messages: vscode.LanguageModelChatMessage[] = [];
		for (const turn of chatContext.history) {
			if (turn instanceof vscode.ChatRequestTurn) {
				messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
			} else if (turn instanceof vscode.ChatResponseTurn) {
				messages.push(vscode.LanguageModelChatMessage.Assistant(responseText(turn)));
			}
		}
		messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

		// Editor inline chat (Ctrl+I) only renders responses that produce document edits — a plain
		// markdown answer is filtered out and the user sees nothing. So when invoked there, apply the
		// model output as a text edit at the cursor/selection; elsewhere (terminal, notebook) stream
		// markdown as usual.
		const editorData = request.location2 instanceof vscode.ChatRequestEditorData ? request.location2 : undefined;

		try {
			const result = await model.sendRequest(messages, {}, token);
			let full = '';
			for await (const chunk of result.text) {
				full += chunk;
			}
			log.info(`chat participant received ${full.length} chars (${editorData ? 'editor edit' : 'markdown'})`);

			if (editorData) {
				const text = unwrapCodeBlock(full.trim());
				if (text) {
					response.textEdit(editorData.document.uri, vscode.TextEdit.replace(editorData.selection, text));
					response.textEdit(editorData.document.uri, true);
				} else {
					response.markdown(vscode.l10n.t('_(The local model returned no text. See the **vkcode AI** output log.)_'));
				}
			} else if (full) {
				response.markdown(full);
			} else {
				response.markdown(vscode.l10n.t('_(The local model returned no text. See the **vkcode AI** output log.)_'));
			}
		} catch (err) {
			if (err instanceof vscode.CancellationError) {
				return {};
			}
			response.markdown(vscode.l10n.t('Local AI request failed: {0}', err instanceof Error ? err.message : String(err)));
		}
		return {};
	};

	const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
	context.subscriptions.push(participant);
}

/**
 * When the model wraps its whole answer in a single fenced code block (common for code requests),
 * returns just the code so it can be inserted into the document; otherwise returns the text as-is.
 */
function unwrapCodeBlock(text: string): string {
	const fenced = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
	return fenced ? fenced[1] : text;
}

/** Concatenates the markdown parts of a previous response turn. */
function responseText(turn: vscode.ChatResponseTurn): string {
	let text = '';
	for (const part of turn.response) {
		if (part instanceof vscode.ChatResponseMarkdownPart) {
			text += part.value.value;
		}
	}
	return text;
}
