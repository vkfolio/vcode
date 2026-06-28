/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { LanguageClient, ServerOptions, TransportKind } from 'vscode-languageclient/node';
import { MdLanguageClient, startClient } from './client/client';
import { activateShared } from './extension.shared';
import { VsCodeOutputLogger } from './logging';
import { IMdParser, MarkdownItEngine } from './markdownEngine';
import { getMarkdownExtensionContributions } from './markdownExtensions';
import { githubSlugifier } from './slugify';

export async function activate(context: vscode.ExtensionContext) {
	// vkcode: open notebook images (markdown + output renderers) in a separate editor tab when the
	// in-cell "view fullscreen" button is clicked. Registered first so it works even before the
	// markdown language server finishes starting.
	registerNotebookImageViewer(context);

	const contributions = getMarkdownExtensionContributions(context);
	context.subscriptions.push(contributions);

	const logger = new VsCodeOutputLogger();
	context.subscriptions.push(logger);

	const engine = new MarkdownItEngine(contributions, githubSlugifier, logger);

	const client = await startServer(context, engine);
	context.subscriptions.push(client);
	activateShared(context, client, engine, logger, contributions);
}

/**
 * vkcode: listens for "open image" messages posted by the notebook markdown and output renderers and
 * shows the image in a dedicated editor tab (a webview panel, which is viewport-sized so it centers
 * correctly — unlike an overlay inside the tall notebook output webview).
 */
function registerNotebookImageViewer(context: vscode.ExtensionContext): void {
	const onMessage = (message: unknown) => {
		if (message && typeof message === 'object' && (message as { type?: string }).type === 'vkcode-open-image') {
			const src = (message as { src?: string }).src;
			const title = (message as { title?: string }).title;
			if (typeof src === 'string' && src.length > 0) {
				openImagePanel(src, title);
			}
		}
	};

	// createRendererMessaging() only works for renderers this extension contributes, so we handle the
	// markdown renderer here; the builtin output-image renderer is handled by notebook-renderers.
	const messaging = vscode.notebooks.createRendererMessaging('vscode.markdown-it-renderer');
	context.subscriptions.push(messaging.onDidReceiveMessage(e => onMessage(e.message)));
}

function openImagePanel(src: string, title?: string): void {
	const panel = vscode.window.createWebviewPanel(
		'vkcode.imageViewer',
		title || vscode.l10n.t('Image'),
		{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
		{ enableScripts: false, retainContextWhenHidden: false }
	);
	const escaped = src.replace(/"/g, '&quot;');
	panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob: https: http: vscode-resource: vscode-webview-resource:; style-src 'unsafe-inline';">
	<style>
		html, body { margin: 0; height: 100%; background: #1e1e1e; }
		body { display: flex; align-items: center; justify-content: center; }
		img { max-width: 100vw; max-height: 100vh; object-fit: contain; }
	</style>
</head>
<body><img src="${escaped}" alt=""></body>
</html>`;
}

function startServer(context: vscode.ExtensionContext, parser: IMdParser): Promise<MdLanguageClient> {
	const isDebugBuild = context.extension.packageJSON.main.includes('/out/');

	const serverModule = context.asAbsolutePath(
		isDebugBuild
			// For local non bundled version of vscode-markdown-languageserver
			// ? './node_modules/vscode-markdown-languageserver/out/node/workerMain'
			? './node_modules/vscode-markdown-languageserver/dist/node/workerMain'
			: './dist/serverWorkerMain'
	);

	// The debug options for the server
	const debugOptions = { execArgv: ['--nolazy', '--inspect=' + (7000 + Math.round(Math.random() * 999))] };

	// If the extension is launch in debug mode the debug server options are use
	// Otherwise the run options are used
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
	};

	// pass the location of the localization bundle to the server
	process.env['VSCODE_L10N_BUNDLE_LOCATION'] = vscode.l10n.uri?.toString() ?? '';

	return startClient((id, name, clientOptions) => {
		return new LanguageClient(id, name, serverOptions, clientOptions);
	}, parser);
}
