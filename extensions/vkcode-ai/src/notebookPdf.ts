/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import MarkdownIt = require('markdown-it');

const md = new MarkdownIt({ html: true, linkify: true, breaks: false });

/**
 * Registers "Export Notebook to PDF". It renders the active notebook to a styled, self-contained HTML
 * document (markdown prose, highlighted code, text and image outputs) and prints it to a PDF with a
 * headless Chromium browser (Edge or Chrome). When no browser is found it opens the HTML so the user
 * can print it from their browser instead.
 */
export function registerNotebookPdf(context: vscode.ExtensionContext): void {
	context.subscriptions.push(vscode.commands.registerCommand('vkcode.notebook.exportPdf', () => runExport()));
}

async function runExport(): Promise<void> {
	const editor = vscode.window.activeNotebookEditor;
	if (!editor) {
		void vscode.window.showWarningMessage(vscode.l10n.t('Open a notebook to export it to PDF.'));
		return;
	}
	const notebook = editor.notebook;

	const defaultPath = notebook.uri.scheme === 'file'
		? vscode.Uri.file(notebook.uri.fsPath.replace(/\.ipynb$/i, '') + '.pdf')
		: vscode.Uri.file(path.join(os.homedir(), 'notebook.pdf'));
	const target = await vscode.window.showSaveDialog({
		defaultUri: defaultPath,
		filters: { PDF: ['pdf'] },
		title: vscode.l10n.t('Export Notebook to PDF')
	});
	if (!target) {
		return;
	}

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Exporting notebook to PDF…') },
		async () => {
			const html = renderHtml(notebook);
			const htmlPath = path.join(os.tmpdir(), `vkcode-notebook-${process.pid}-${notebook.cellCount}.html`);
			await fs.promises.writeFile(htmlPath, html, 'utf8');

			const browser = findBrowser();
			if (!browser) {
				await vscode.env.openExternal(vscode.Uri.file(htmlPath));
				void vscode.window.showInformationMessage(vscode.l10n.t('No Edge or Chrome found to print silently — opened the notebook in your browser. Use Print → Save as PDF.'));
				return;
			}

			try {
				await printToPdf(browser, htmlPath, target.fsPath);
			} catch (err) {
				await vscode.env.openExternal(vscode.Uri.file(htmlPath));
				void vscode.window.showWarningMessage(vscode.l10n.t('Could not print the PDF automatically ({0}). Opened it in your browser instead — use Print → Save as PDF.', err instanceof Error ? err.message : String(err)));
				return;
			} finally {
				void fs.promises.unlink(htmlPath).then(undefined, () => undefined);
			}

			const open = await vscode.window.showInformationMessage(vscode.l10n.t('Exported to {0}', path.basename(target.fsPath)), vscode.l10n.t('Open'));
			if (open) {
				await vscode.env.openExternal(target);
			}
		}
	);
}

/** Spawns the headless browser to print `htmlPath` to `pdfPath`, rejecting on a non-zero exit. */
function printToPdf(browser: string, htmlPath: string, pdfPath: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const args = [
			'--headless=new',
			'--disable-gpu',
			'--no-first-run',
			'--no-default-browser-check',
			'--no-pdf-header-footer',
			// Without these, headless Chromium snapshots the page before images (matplotlib output, embedded
			// pictures) finish decoding and they are missing from the PDF. The compositor flag forces a full
			// paint and the virtual-time budget lets image decode/layout complete first.
			'--run-all-compositor-stages-before-draw',
			'--virtual-time-budget=15000',
			`--print-to-pdf=${pdfPath}`,
			pathToFileUrl(htmlPath)
		];
		const proc = cp.spawn(browser, args, { windowsHide: true });
		let stderr = '';
		proc.stderr?.setEncoding('utf8');
		proc.stderr?.on('data', (chunk: string) => { stderr += chunk; });
		proc.on('error', reject);
		proc.on('exit', code => {
			if (code === 0 && fs.existsSync(pdfPath)) {
				resolve();
			} else {
				reject(new Error(stderr.trim().split('\n').pop() || `exit code ${code}`));
			}
		});
	});
}

/** Finds an installed Edge or Chrome executable, honoring the `vkcode.notebook.pdf.browserPath` override. */
function findBrowser(): string | undefined {
	const override = vscode.workspace.getConfiguration('vkcode').get<string>('notebook.pdf.browserPath', '').trim();
	if (override && fs.existsSync(override)) {
		return override;
	}
	const candidates: string[] = [];
	if (process.platform === 'win32') {
		const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter((r): r is string => !!r);
		for (const root of roots) {
			candidates.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
			candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
		}
	} else if (process.platform === 'darwin') {
		candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
		candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
		candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
	} else {
		candidates.push('/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
	}
	return candidates.find(c => fs.existsSync(c));
}

/** Builds the full standalone HTML document for the notebook. */
function renderHtml(notebook: vscode.NotebookDocument): string {
	const title = escapeHtml(path.basename(notebook.uri.path).replace(/\.ipynb$/i, ''));
	const body = notebook.getCells().map(renderCell).join('\n');
	// Resolve relative image paths in markdown cells against the notebook's own folder.
	const base = notebook.uri.scheme === 'file'
		? `\n<base href="${escapeHtml(vscode.Uri.file(path.dirname(notebook.uri.fsPath) + path.sep).toString())}">`
		: '';
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">${base}
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="notebook">
${body}
</main>
</body>
</html>`;
}

/** Renders one cell: markdown prose, or a code cell with its rendered outputs. */
function renderCell(cell: vscode.NotebookCell): string {
	if (cell.kind === vscode.NotebookCellKind.Markup) {
		const text = cell.document.getText().trim();
		if (text === '---' || text === '***') {
			return '<hr class="divider">';
		}
		return `<section class="md">${inlineAttachments(md.render(text), cell.metadata)}</section>`;
	}
	const code = `<pre class="code"><code class="language-${escapeHtml(cell.document.languageId)}">${escapeHtml(cell.document.getText())}</code></pre>`;
	const outputs = cell.outputs.map(renderOutput).filter(Boolean).join('\n');
	return `<section class="cell">${code}${outputs ? `<div class="outputs">${outputs}</div>` : ''}</section>`;
}

/**
 * Replaces `attachment:NAME` image sources (pasted images stored in the cell's metadata) with inline
 * data URIs, so they survive being rendered from a standalone HTML file.
 */
function inlineAttachments(html: string, metadata: { readonly [key: string]: unknown } | undefined): string {
	const attachments = metadata?.['attachments'] as Record<string, Record<string, string>> | undefined;
	if (!attachments) {
		return html;
	}
	return html.replace(/(["'])attachment:([^"']+)\1/g, (whole, quote: string, rawName: string) => {
		const entry = attachments[decodeURIComponent(rawName)] ?? attachments[rawName];
		if (!entry) {
			return whole;
		}
		const mime = Object.keys(entry)[0];
		return mime ? `${quote}data:${mime};base64,${entry[mime]}${quote}` : whole;
	});
}

/** Renders a single cell output, picking the richest mime type it knows how to show. */
function renderOutput(output: vscode.NotebookCellOutput): string {
	const byMime = new Map(output.items.map(item => [item.mime, item]));
	const pick = (...mimes: string[]) => mimes.map(m => byMime.get(m)).find(Boolean);

	const image = pick('image/png', 'image/jpeg', 'image/gif');
	if (image) {
		return `<div class="output-image"><img src="data:${image.mime};base64,${Buffer.from(image.data).toString('base64')}"></div>`;
	}
	const svg = byMime.get('image/svg+xml');
	if (svg) {
		return `<div class="output-image">${decode(svg.data)}</div>`;
	}
	const html = byMime.get('text/html');
	if (html) {
		return `<div class="output-html">${decode(html.data)}</div>`;
	}
	const error = byMime.get('application/vnd.code.notebook.error');
	if (error) {
		try {
			const parsed = JSON.parse(decode(error.data)) as { name?: string; message?: string; stack?: string };
			const detail = parsed.stack || `${parsed.name ?? 'Error'}: ${parsed.message ?? ''}`;
			return `<pre class="output-error">${escapeHtml(stripAnsi(detail))}</pre>`;
		} catch {
			return `<pre class="output-error">${escapeHtml(decode(error.data))}</pre>`;
		}
	}
	const text = pick('text/plain', 'application/vnd.code.notebook.stdout', 'application/vnd.code.notebook.stderr');
	if (text) {
		return `<pre class="output-text">${escapeHtml(stripAnsi(decode(text.data)))}</pre>`;
	}
	return '';
}

function decode(data: Uint8Array): string {
	return Buffer.from(data).toString('utf8');
}

/** Removes ANSI color escape sequences so terminal-styled output stays readable in print. */
function stripAnsi(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\[[0-9;]*m/g, '');
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]!));
}

function pathToFileUrl(filePath: string): string {
	return vscode.Uri.file(filePath).toString();
}

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
	font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
	color: #1f2328; background: #ffffff; line-height: 1.6; font-size: 14px;
	-webkit-print-color-adjust: exact; print-color-adjust: exact;
}
.notebook { max-width: 820px; margin: 0 auto; padding: 32px 28px; }
.md { margin: 0 0 18px; }
.md h1, .md h2, .md h3, .md h4 { line-height: 1.25; margin: 22px 0 10px; font-weight: 650; }
.md h1 { font-size: 1.9em; border-bottom: 1px solid #e2e4e8; padding-bottom: 6px; }
.md h2 { font-size: 1.45em; border-bottom: 1px solid #eceef1; padding-bottom: 4px; }
.md h3 { font-size: 1.2em; }
.md p { margin: 8px 0; }
.md a { color: #0969da; text-decoration: none; }
.md code { background: #f3f4f6; padding: 0.15em 0.35em; border-radius: 5px; font-size: 0.88em; font-family: "Cascadia Code", "SF Mono", Consolas, monospace; }
.md pre { background: #f6f8fa; padding: 12px 14px; border-radius: 8px; overflow-x: auto; }
.md pre code { background: none; padding: 0; }
.md blockquote { margin: 10px 0; padding: 4px 14px; border-left: 3px solid #d0d7de; color: #57606a; }
.md table { border-collapse: collapse; margin: 12px 0; }
.md th, .md td { border: 1px solid #d0d7de; padding: 6px 12px; }
.md img { max-width: 100%; border-radius: 8px; }
.divider { border: none; border-top: 1px solid #e2e4e8; margin: 26px 0; }
.cell { margin: 0 0 18px; }
.code {
	background: #f6f8fa; border: 1px solid #eceef1; border-radius: 8px;
	padding: 12px 14px; overflow-x: auto; margin: 0;
	font-family: "Cascadia Code", "SF Mono", Consolas, monospace; font-size: 0.85em; line-height: 1.5;
}
.outputs { margin: 6px 0 0 0; padding-left: 12px; border-left: 3px solid #e2e4e8; }
.output-text, .output-error {
	white-space: pre-wrap; word-break: break-word; margin: 6px 0;
	font-family: "Cascadia Code", "SF Mono", Consolas, monospace; font-size: 0.82em;
}
.output-error { color: #cf222e; }
.output-image img { max-width: 100%; border-radius: 8px; margin: 6px 0; }
.output-html { margin: 6px 0; }
@page { margin: 14mm; }
@media print {
	.notebook { max-width: none; padding: 0; }
	.cell, .md, .output-image { break-inside: avoid; }
	.md h1, .md h2, .md h3 { break-after: avoid; }
}
`;
