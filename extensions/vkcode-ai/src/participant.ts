/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { isAiEnabled } from './aiStatus';
import { IChatTurn, LlamaService } from './llama';

const PARTICIPANT_ID = 'vkcode.ai';

/**
 * Registers the default chat participant. Being a default participant with an implementation is what
 * makes `chatIsEnabled` true in the workbench, which in turn enables inline chat (Ctrl+I), terminal
 * chat and notebook chat. The handler talks to the local model directly so it can stream the reasoning
 * (as live progress) separately from the answer.
 */
export function registerChatParticipant(context: vscode.ExtensionContext, llama: LlamaService, log: vscode.LogOutputChannel): void {
	const handler: vscode.ChatRequestHandler = async (request, chatContext, response, token) => {
		log.info(`chat participant invoked: "${request.prompt.slice(0, 80)}"`);

		// Editor inline chat (Ctrl+I) only renders responses that produce document edits — plain
		// markdown is filtered out. So in the editor we surface replies as a text edit at the
		// cursor/selection; elsewhere (terminal, notebook) we render markdown.
		const editorData = request.location2 instanceof vscode.ChatRequestEditorData ? request.location2 : undefined;
		const reply = (text: string) => {
			if (editorData) {
				response.textEdit(editorData.document.uri, vscode.TextEdit.replace(editorData.selection, text));
				response.textEdit(editorData.document.uri, true);
			} else {
				response.markdown(text);
			}
		};

		if (!isAiEnabled()) {
			log.info('chat participant: AI is turned off');
			reply(vscode.l10n.t('vkcode AI is turned off. Turn it on from the AI control in the status bar.'));
			return {};
		}

		const thinkingOn = vscode.workspace.getConfiguration('vkcode').get<boolean>('ai.thinking', false);
		const turns = buildTurns(chatContext.history, request, editorData);
		const controller = new AbortController();
		token.onCancellationRequested(() => controller.abort());

		// Stream the reasoning as progress steps (visible live in the inline-chat zone / chat view) but
		// never into the document. We flush one reasoning line at a time as it completes.
		let reasoningBuffer = '';
		const onThinking = thinkingOn
			? (delta: string) => {
				reasoningBuffer += delta;
				let nl: number;
				while ((nl = reasoningBuffer.indexOf('\n')) !== -1) {
					const line = reasoningBuffer.slice(0, nl).trim();
					reasoningBuffer = reasoningBuffer.slice(nl + 1);
					if (line) {
						response.progress(`🧠 ${line}`);
					}
				}
			}
			: undefined;

		// Stream the answer live for markdown surfaces; in the editor we apply it as one edit at the end
		// (incremental edits would fight the moving selection range).
		const onAnswer = editorData ? undefined : (delta: string) => response.markdown(delta);

		try {
			if (thinkingOn) {
				response.progress(vscode.l10n.t('Reasoning…'));
			}
			const { answer } = await llama.chat(turns, {
				maxTokens: thinkingOn ? 3072 : 1024,
				temperature: 0.2,
				signal: controller.signal,
				think: thinkingOn,
				onThinking,
				onAnswer
			});

			if (reasoningBuffer.trim()) {
				response.progress(`🧠 ${reasoningBuffer.trim()}`);
			}
			log.info(`chat participant answer: ${answer.length} chars (${editorData ? 'editor edit' : 'markdown'})`);

			if (editorData) {
				reply(unwrapCodeBlock(answer.trim()) || vscode.l10n.t('_(The local model returned no text. See the vkcode AI output log.)_'));
			} else if (!answer) {
				response.markdown(vscode.l10n.t('_(The local model returned no text. See the vkcode AI output log.)_'));
			}
		} catch (err) {
			if (err instanceof vscode.CancellationError) {
				return {};
			}
			log.error(`chat participant failed: ${err instanceof Error ? err.message : String(err)}`);
			reply(vscode.l10n.t('Local AI request failed: {0}', err instanceof Error ? err.message : String(err)));
		}
		return {};
	};

	const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
	context.subscriptions.push(participant);
}

/**
 * Builds the conversation turns from prior chat history plus the new request. In editor inline chat
 * the model only sees what we send it, so we attach the selected code (or surrounding context) and a
 * system prompt telling it to return ONLY code — otherwise an instruction like "improve" has nothing
 * to act on and the model replies with prose that then gets inserted into the file.
 */
function buildTurns(history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[], request: vscode.ChatRequest, editorData: vscode.ChatRequestEditorData | undefined): IChatTurn[] {
	const turns: IChatTurn[] = [];

	if (editorData) {
		const lang = editorData.document.languageId;
		const selected = editorData.document.getText(editorData.selection);
		turns.push({
			role: 'system',
			content: selected.trim()
				? `You are a code-editing assistant inside an IDE. The user gives an instruction and their selected ${lang} code. Apply the instruction and reply with ONLY the resulting ${lang} code that should replace the selection — no explanations, no commentary, no markdown code fences.`
				: `You are a code-generation assistant inside an IDE. Generate ${lang} code for the user's request. Reply with ONLY the code to insert — no explanations, no commentary, no markdown code fences.`
		});
	}

	for (const turn of history) {
		if (turn instanceof vscode.ChatRequestTurn) {
			turns.push({ role: 'user', content: turn.prompt });
		} else if (turn instanceof vscode.ChatResponseTurn) {
			turns.push({ role: 'assistant', content: responseText(turn) });
		}
	}

	if (editorData) {
		const selected = editorData.document.getText(editorData.selection);
		turns.push({
			role: 'user',
			content: selected.trim()
				? `Instruction: ${request.prompt}\n\nSelected code:\n${selected}`
				: request.prompt
		});
	} else {
		turns.push({ role: 'user', content: request.prompt });
	}
	return turns;
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
