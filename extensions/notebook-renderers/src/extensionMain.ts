/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * vkcode: opens notebook image OUTPUTS in a separate editor tab when the in-cell "open in editor"
 * button is clicked. The renderer (renderer-out/index.js) posts the image as a data URL; this
 * extension host code receives it via the renderer messaging channel and shows it in a webview
 * panel (which is viewport-sized, so the image centers correctly — unlike an overlay inside the
 * tall notebook output webview).
 */
export function activate(context: vscode.ExtensionContext): void {
	const messaging = vscode.notebooks.createRendererMessaging('vscode.builtin-renderer');
	context.subscriptions.push(messaging.onDidReceiveMessage(e => {
		const message = e.message as { type?: string; src?: string; title?: string } | undefined;
		if (message?.type === 'vkcode-open-image' && typeof message.src === 'string' && message.src.length > 0) {
			openImagePanel(message.src, message.title);
		}
	}));
}

export function deactivate(): void {
	// Nothing to clean up beyond the disposables registered on the context.
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
