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
export function registerChatParticipant(context: vscode.ExtensionContext): void {
	const handler: vscode.ChatRequestHandler = async (request, chatContext, response, token) => {
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

		try {
			const result = await model.sendRequest(messages, {}, token);
			for await (const chunk of result.text) {
				response.markdown(chunk);
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
