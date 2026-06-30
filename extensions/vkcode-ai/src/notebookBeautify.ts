/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { isAiEnabled } from './aiStatus';
import { LlamaService } from './llama';

/** Which transformations a beautify run applies. Deterministic flags never need the model. */
interface IBeautifyOptions {
	/** Deterministic: trim trailing whitespace, collapse blank-line runs, normalize heading spacing. */
	readonly tidy: boolean;
	/** Deterministic: tidy code cells (trim trailing whitespace, ensure a single final newline). */
	readonly formatCode: boolean;
	/** Deterministic: insert `---` divider cells between top-level sections. */
	readonly dividers: boolean;
	/** AI: fix spelling, grammar and punctuation in markdown cells (meaning preserved). */
	readonly fixGrammar: boolean;
	/** AI: rewrite markdown prose for clarity and flow (meaning preserved). */
	readonly rewriteProse: boolean;
	/** AI: add a heading to sections that lack one. */
	readonly suggestTitles: boolean;
	/** AI: add/improve comments in code cells without changing the code. */
	readonly improveComments: boolean;
	/** AI: reorganize whole sections into a logical reading order. */
	readonly reorganize: boolean;
}

const PRESETS: ReadonlyArray<{ id: string; label: string; description: string; options: IBeautifyOptions }> = [
	{
		id: 'tidy',
		label: '$(symbol-ruler) Tidy',
		description: vscode.l10n.t('Formatting only — no AI (fast, offline)'),
		options: { tidy: true, formatCode: true, dividers: true, fixGrammar: false, rewriteProse: false, suggestTitles: false, improveComments: false, reorganize: false }
	},
	{
		id: 'beautify',
		label: '$(sparkle) Beautify',
		description: vscode.l10n.t('Tidy + fix grammar and add section titles with AI'),
		options: { tidy: true, formatCode: true, dividers: true, fixGrammar: true, rewriteProse: false, suggestTitles: true, improveComments: false, reorganize: false }
	},
	{
		id: 'super',
		label: '$(star-full) Super Beautify',
		description: vscode.l10n.t('Full AI pass — rewrite prose, title and reorganize sections'),
		options: { tidy: true, formatCode: true, dividers: true, fixGrammar: true, rewriteProse: true, suggestTitles: true, improveComments: false, reorganize: true }
	}
];

/** Custom-mode toggles, in display order. `value` reads the matching `IBeautifyOptions` flag. */
const TOGGLES: ReadonlyArray<{ key: keyof IBeautifyOptions; label: string; detail: string; ai: boolean }> = [
	{ key: 'fixGrammar', label: vscode.l10n.t('Fix grammar & spelling'), detail: vscode.l10n.t('Correct markdown text, preserving meaning'), ai: true },
	{ key: 'rewriteProse', label: vscode.l10n.t('Rewrite & improve prose'), detail: vscode.l10n.t('Reword explanations for clarity and flow'), ai: true },
	{ key: 'suggestTitles', label: vscode.l10n.t('Add section titles'), detail: vscode.l10n.t('Give untitled sections a heading'), ai: true },
	{ key: 'improveComments', label: vscode.l10n.t('Improve code comments'), detail: vscode.l10n.t('Add comments without changing the code'), ai: true },
	{ key: 'reorganize', label: vscode.l10n.t('Reorganize sections'), detail: vscode.l10n.t('Reorder sections into a logical flow'), ai: true },
	{ key: 'dividers', label: vscode.l10n.t('Add section dividers'), detail: vscode.l10n.t('Insert a rule between sections'), ai: false },
	{ key: 'formatCode', label: vscode.l10n.t('Format code cells'), detail: vscode.l10n.t('Trim whitespace and normalize spacing'), ai: false }
];

/**
 * A cell whose text is larger than this (≈ a couple thousand tokens) is left untouched by the AI passes:
 * sending it risks overflowing the model's context window (which errors and wastes time). Deterministic
 * tidying still applies. This is what keeps beautify safe on very large notebooks.
 */
const AI_MAX_CELL_CHARS = 8000;

/** Above this many sections, skip AI reordering — the permutation would be unreliable and slow to emit. */
const REORDER_MAX_SECTIONS = 60;

const SYS_GRAMMAR = 'You are a meticulous copy editor. Fix spelling, grammar and punctuation in the given Markdown. Preserve the author\'s meaning, voice, structure, links, lists, code spans and formatting exactly. Do not add or remove information. Reply with only the corrected Markdown — no commentary, no code fences.';
const SYS_PROSE = 'You are a precise technical writer. Improve the clarity and flow of the given Markdown explanation while preserving its meaning and every fact. Keep it concise. Preserve headings, links, lists and code spans. Reply with only the rewritten Markdown — no commentary, no code fences.';
const SYS_TITLE = 'You write short, descriptive section titles. Given the content of a notebook section, reply with only a Title Case heading of 3 to 6 words. No Markdown symbols, no surrounding quotes, no trailing punctuation.';
const SYS_COMMENTS = 'You add helpful comments to code. Add or improve brief comments in the given {0} code. Do NOT change any code, names, strings or formatting — only add or refine comments. Reply with only the updated code — no commentary, no code fences.';
const SYS_REORDER = 'You reorganize the sections of a technical notebook into the clearest reading order. You will get a numbered list of section summaries. Reply with only a JSON array of the section numbers in their new order — a permutation that uses every number exactly once. Keep an introduction first and a conclusion last.';

/**
 * Registers the "Beautify Notebook" command. It restructures the active Jupyter notebook — deterministic
 * tidying plus optional, user-selected AI passes (grammar, prose, titles, comments, reorganization) — and
 * applies the whole result as a single undoable edit.
 */
export function registerNotebookBeautify(context: vscode.ExtensionContext, llama: LlamaService): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('vkcode.notebook.beautify', () => runBeautify(llama)),
		vscode.commands.registerCommand('vkcode.notebook.beautifyCell', (cell?: vscode.NotebookCell) => runBeautifyCell(llama, cell))
	);
}

async function runBeautify(llama: LlamaService): Promise<void> {
	const editor = vscode.window.activeNotebookEditor;
	if (!editor) {
		void vscode.window.showWarningMessage(vscode.l10n.t('Open a notebook to beautify it.'));
		return;
	}

	const options = await pickOptions();
	if (!options) {
		return;
	}

	// When the user has a partial cell selection, offer to scope the run to it. Selected-scope only runs
	// the per-cell passes (tidy/grammar/prose/comments) — section-level changes apply to the whole notebook.
	const scope = await pickScope(editor);
	if (scope === undefined) {
		return;
	}

	const aiAvailable = await resolveAiAvailability(options, llama);
	if (aiAvailable === undefined) {
		return;
	}

	const selectionScope = scope !== 'all';
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: selectionScope ? vscode.l10n.t('Beautifying {0} cell(s)…', scope.length) : vscode.l10n.t('Beautifying notebook…'),
			cancellable: true
		},
		async (progress, token) => {
			const edit = new vscode.WorkspaceEdit();
			if (selectionScope) {
				const edits = await buildSelectedEdits(editor.notebook, scope, options, aiAvailable, llama, progress, token);
				if (token.isCancellationRequested || !edits.length) {
					return;
				}
				edit.set(editor.notebook.uri, edits);
			} else {
				const newCells = await buildCells(editor.notebook, options, aiAvailable, llama, progress, token);
				if (token.isCancellationRequested || !newCells) {
					return;
				}
				edit.set(editor.notebook.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(0, editor.notebook.cellCount), newCells)]);
			}
			await vscode.workspace.applyEdit(edit);
			void vscode.window.showInformationMessage(vscode.l10n.t('Notebook beautified. Press Undo to revert.'));
		}
	);
}

/** Beautifies a single cell — invoked from the cell's overflow menu, or the active cell from the palette. */
async function runBeautifyCell(llama: LlamaService, cellArg?: vscode.NotebookCell): Promise<void> {
	const cell = resolveCell(cellArg);
	if (!cell) {
		void vscode.window.showWarningMessage(vscode.l10n.t('Select a notebook cell to beautify.'));
		return;
	}

	const options = await pickOptions();
	if (!options) {
		return;
	}
	const aiAvailable = await resolveAiAvailability(options, llama);
	if (aiAvailable === undefined) {
		return;
	}

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Beautifying cell…'), cancellable: true },
		async (progress, token) => {
			const edits = await buildSelectedEdits(cell.notebook, [cell.index], options, aiAvailable, llama, progress, token);
			if (token.isCancellationRequested) {
				return;
			}
			if (!edits.length) {
				void vscode.window.showInformationMessage(vscode.l10n.t('No changes were needed for this cell.'));
				return;
			}
			const edit = new vscode.WorkspaceEdit();
			edit.set(cell.notebook.uri, edits);
			await vscode.workspace.applyEdit(edit);
			void vscode.window.showInformationMessage(vscode.l10n.t('Cell beautified. Press Undo to revert.'));
		}
	);
}

/** Resolves the target cell from the command argument, falling back to the active notebook's active cell. */
function resolveCell(arg: vscode.NotebookCell | undefined): vscode.NotebookCell | undefined {
	if (arg && typeof arg === 'object' && typeof arg.index === 'number' && arg.notebook) {
		return arg;
	}
	const editor = vscode.window.activeNotebookEditor;
	if (!editor) {
		return undefined;
	}
	const index = selectedIndices(editor)[0] ?? editor.selection.start;
	return index < editor.notebook.cellCount ? editor.notebook.cellAt(index) : undefined;
}

/**
 * Resolves whether the AI passes can run for the chosen options. Returns the effective availability, or
 * undefined if the user cancelled the "AI is off — format only?" prompt.
 */
async function resolveAiAvailability(options: IBeautifyOptions, llama: LlamaService): Promise<boolean | undefined> {
	const needsAi = options.fixGrammar || options.rewriteProse || options.suggestTitles || options.improveComments || options.reorganize;
	if (needsAi && (!isAiEnabled() || !llama.modelFileExists)) {
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t('This beautify level uses the local AI, which is off or has no model configured. Run formatting only?'),
			{ modal: true },
			vscode.l10n.t('Format Only')
		);
		if (!choice) {
			return undefined;
		}
	}
	return needsAi && isAiEnabled() && llama.modelFileExists;
}

/**
 * Asks whether to beautify the selected cells or the whole notebook, but only when a meaningful partial
 * selection exists. Returns `'all'` for the whole notebook, the selected indices, or undefined if cancelled.
 */
async function pickScope(editor: vscode.NotebookEditor): Promise<'all' | number[] | undefined> {
	const selected = selectedIndices(editor);
	const total = editor.notebook.cellCount;
	if (selected.length === 0 || selected.length >= total) {
		return 'all';
	}
	const selectedItem = { label: vscode.l10n.t('$(list-selection) Selected cells ({0})', selected.length), scope: selected as 'all' | number[] };
	const allItem = { label: vscode.l10n.t('$(book) Whole notebook ({0})', total), scope: 'all' as 'all' | number[] };
	// Put the more likely intent first so Enter does the right thing: selection when several are picked,
	// the whole notebook when only the active cell is "selected".
	const items = selected.length >= 2 ? [selectedItem, allItem] : [allItem, selectedItem];
	const picked = await vscode.window.showQuickPick(items, {
		title: vscode.l10n.t('Beautify Notebook'),
		placeHolder: vscode.l10n.t('Beautify which cells?')
	});
	return picked?.scope;
}

/** The sorted, de-duplicated indices of the cells currently selected in the editor. */
function selectedIndices(editor: vscode.NotebookEditor): number[] {
	const indices = new Set<number>();
	for (const range of editor.selections) {
		for (let i = range.start; i < range.end; i++) {
			indices.add(i);
		}
	}
	return [...indices].sort((a, b) => a - b);
}

/**
 * Builds per-cell edits for a selected subset: deterministic tidy plus the AI per-cell passes
 * (grammar/prose/comments). Cell count is preserved, so each changed cell is replaced in place and the
 * whole set applies as one undoable edit. Section-level passes (titles/dividers/reorganize) are skipped.
 */
async function buildSelectedEdits(
	notebook: vscode.NotebookDocument,
	indices: number[],
	options: IBeautifyOptions,
	ai: boolean,
	llama: LlamaService,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	token: vscode.CancellationToken
): Promise<vscode.NotebookEdit[]> {
	const edits: vscode.NotebookEdit[] = [];
	for (let n = 0; n < indices.length; n++) {
		if (token.isCancellationRequested) {
			return [];
		}
		const index = indices[n];
		const cell = toWorking(notebook.cellAt(index));
		const original = cell.value;
		progress.report({ message: vscode.l10n.t('Polishing cell {0}/{1}…', n + 1, indices.length) });

		const markup = cell.kind === vscode.NotebookCellKind.Markup;
		if (markup) {
			cell.value = tidyMarkdown(cell.value);
		} else if (options.formatCode) {
			cell.value = tidyCode(cell.value);
		}

		const wantsCell = markup ? (options.rewriteProse || options.fixGrammar) : options.improveComments;
		if (ai && wantsCell && cell.value.trim() && cell.value.length <= AI_MAX_CELL_CHARS) {
			const system = markup ? (options.rewriteProse ? SYS_PROSE : SYS_GRAMMAR) : SYS_COMMENTS.replace('{0}', cell.languageId);
			cell.value = await transform(llama, system, cell.value, token, cell.value);
		}

		if (cell.value !== original) {
			edits.push(vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(index, index + 1), [toCellData(cell)]));
		}
	}
	return edits;
}

/** Shows the preset QuickPick, then the custom multi-select when "Custom…" is chosen. */
async function pickOptions(): Promise<IBeautifyOptions | undefined> {
	const items = [
		...PRESETS.map(p => ({ label: p.label, description: p.description, preset: p })),
		{ label: '$(settings-gear) Custom…', description: vscode.l10n.t('Choose exactly which changes to apply'), preset: undefined }
	];
	const picked = await vscode.window.showQuickPick(items, {
		title: vscode.l10n.t('Beautify Notebook'),
		placeHolder: vscode.l10n.t('Choose how much to change')
	});
	if (!picked) {
		return undefined;
	}
	if (picked.preset) {
		return picked.preset.options;
	}
	return pickCustom();
}

async function pickCustom(): Promise<IBeautifyOptions | undefined> {
	const picks = await vscode.window.showQuickPick(
		TOGGLES.map(t => ({ label: t.label, detail: t.detail, description: t.ai ? vscode.l10n.t('AI') : vscode.l10n.t('Formatting'), key: t.key, picked: !t.ai })),
		{
			title: vscode.l10n.t('Custom Beautify'),
			placeHolder: vscode.l10n.t('Select the changes to apply'),
			canPickMany: true
		}
	);
	if (!picks) {
		return undefined;
	}
	const on = new Set(picks.map(p => p.key));
	return {
		tidy: true,
		formatCode: on.has('formatCode'),
		dividers: on.has('dividers'),
		fixGrammar: on.has('fixGrammar'),
		rewriteProse: on.has('rewriteProse'),
		suggestTitles: on.has('suggestTitles'),
		improveComments: on.has('improveComments'),
		reorganize: on.has('reorganize')
	};
}

/** A working copy of a cell that beautify passes mutate before it is turned back into cell data. */
interface IWorkingCell {
	kind: vscode.NotebookCellKind;
	value: string;
	languageId: string;
	readonly outputs: readonly vscode.NotebookCellOutput[];
	readonly metadata: { readonly [key: string]: unknown } | undefined;
	readonly executionSummary: vscode.NotebookCellExecutionSummary | undefined;
}

/** A contiguous run of cells led by a markdown heading (or the cells before the first heading). */
interface ISection {
	cells: IWorkingCell[];
}

/** Runs the full beautify pipeline and returns the new cells, or undefined if cancelled. */
async function buildCells(
	notebook: vscode.NotebookDocument,
	options: IBeautifyOptions,
	ai: boolean,
	llama: LlamaService,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	token: vscode.CancellationToken
): Promise<vscode.NotebookCellData[] | undefined> {
	let cells: IWorkingCell[] = notebook.getCells().map(toWorking);

	// 1) Deterministic tidy of every cell's text.
	for (const cell of cells) {
		if (cell.kind === vscode.NotebookCellKind.Markup) {
			cell.value = tidyMarkdown(cell.value);
		} else if (options.formatCode) {
			cell.value = tidyCode(cell.value);
		}
	}
	// Drop cells that are now empty (stray blank cells); always keep at least one.
	cells = cells.filter(c => c.value.trim().length > 0 || c.outputs.length > 0);
	if (cells.length === 0) {
		cells = [{ kind: vscode.NotebookCellKind.Code, value: '', languageId: 'python', outputs: [], metadata: undefined, executionSummary: undefined }];
	}

	// 2) AI per-cell passes. Each call is failure-isolated and oversized cells are skipped, so a long
	// notebook degrades gracefully (some cells untouched) instead of erroring or hanging.
	let skipped = 0;
	if (ai && (options.fixGrammar || options.rewriteProse || options.improveComments)) {
		for (let i = 0; i < cells.length; i++) {
			if (token.isCancellationRequested) {
				return undefined;
			}
			const cell = cells[i];
			progress.report({ message: vscode.l10n.t('Polishing cell {0}/{1}…', i + 1, cells.length) });
			const markup = cell.kind === vscode.NotebookCellKind.Markup;
			const wantsCell = markup ? (options.rewriteProse || options.fixGrammar) : options.improveComments;
			if (!wantsCell || !cell.value.trim()) {
				continue;
			}
			if (cell.value.length > AI_MAX_CELL_CHARS) {
				skipped++;
				continue; // too large for a safe single request — leave it tidied but otherwise untouched
			}
			if (markup) {
				const system = options.rewriteProse ? SYS_PROSE : SYS_GRAMMAR;
				cell.value = await transform(llama, system, cell.value, token, cell.value);
			} else {
				cell.value = await transform(llama, SYS_COMMENTS.replace('{0}', cell.languageId), cell.value, token, cell.value);
			}
		}
		if (skipped > 0) {
			progress.report({ message: vscode.l10n.t('{0} large cell(s) left as-is', skipped) });
		}
	}

	// Group into sections (heading-led runs) for titling, reordering and dividers.
	let sections = splitSections(cells);

	// 3) AI: title untitled sections.
	if (ai && options.suggestTitles) {
		for (const section of sections) {
			if (token.isCancellationRequested) {
				return undefined;
			}
			if (!startsWithHeading(section.cells)) {
				progress.report({ message: vscode.l10n.t('Titling sections…') });
				const title = await suggestTitle(llama, section, token);
				if (title) {
					section.cells.unshift(markdownCell(`## ${title}`));
				}
			}
		}
	}

	// 4) AI: reorganize sections (whole sections move as units; validated as a permutation).
	if (ai && options.reorganize && sections.length > 2 && sections.length <= REORDER_MAX_SECTIONS) {
		if (token.isCancellationRequested) {
			return undefined;
		}
		progress.report({ message: vscode.l10n.t('Reorganizing sections…') });
		sections = await reorderSections(llama, sections, token);
	}

	// 5) Deterministic: dividers between sections.
	const result: IWorkingCell[] = [];
	sections.forEach((section, index) => {
		if (options.dividers && index > 0 && section.cells.length) {
			result.push(markdownCell('---'));
		}
		result.push(...section.cells);
	});

	return result.map(toCellData);
}

/** Sends `text` through the model with `system`, returning the cleaned answer or `fallback` on failure. */
async function transform(llama: LlamaService, system: string, text: string, token: vscode.CancellationToken, fallback: string): Promise<string> {
	if (!text.trim()) {
		return text;
	}
	const source = new vscode.CancellationTokenSource();
	const sub = token.onCancellationRequested(() => source.cancel());
	try {
		const budget = Math.min(2048, Math.max(256, Math.ceil(text.length / 2)));
		const answer = (await llama.instruct(system, text, { maxTokens: budget, temperature: 0.2, signal: toSignal(source.token) })).trim();
		const cleaned = stripFences(answer);
		return cleaned.length > 0 ? cleaned : fallback;
	} catch {
		// Never let one cell's failure abort the whole notebook — keep the original text.
		return fallback;
	} finally {
		sub.dispose();
		source.dispose();
	}
}

/** Asks the model for a short title summarizing a section's text. */
async function suggestTitle(llama: LlamaService, section: ISection, token: vscode.CancellationToken): Promise<string> {
	const text = section.cells.map(c => c.value).join('\n\n').slice(0, 1500);
	const source = new vscode.CancellationTokenSource();
	const sub = token.onCancellationRequested(() => source.cancel());
	try {
		const answer = (await llama.instruct(SYS_TITLE, text, { maxTokens: 24, temperature: 0.3, signal: toSignal(source.token) })).trim();
		return answer.replace(/^#+\s*/, '').replace(/^["']|["']$/g, '').replace(/[.:]\s*$/, '').split('\n')[0].slice(0, 80).trim();
	} catch {
		return '';
	} finally {
		sub.dispose();
		source.dispose();
	}
}

/** Asks the model for a new section order and returns sections reordered, or unchanged if the answer is invalid. */
async function reorderSections(llama: LlamaService, sections: ISection[], token: vscode.CancellationToken): Promise<ISection[]> {
	const summaries = sections.map((s, i) => `${i}. ${sectionSummary(s)}`).join('\n');
	const source = new vscode.CancellationTokenSource();
	const sub = token.onCancellationRequested(() => source.cancel());
	try {
		const answer = await llama.instruct(SYS_REORDER, summaries, { maxTokens: 256, temperature: 0.2, signal: toSignal(source.token) });
		const match = answer.match(/\[[\s\S]*?\]/);
		if (!match) {
			return sections;
		}
		const order = JSON.parse(match[0]) as unknown;
		if (!isPermutation(order, sections.length)) {
			return sections;
		}
		return (order as number[]).map(i => sections[i]);
	} catch {
		return sections;
	} finally {
		sub.dispose();
		source.dispose();
	}
}

/** A one-line description of a section for the reordering prompt. */
function sectionSummary(section: ISection): string {
	const heading = section.cells.find(c => c.kind === vscode.NotebookCellKind.Markup && /^#+\s/.test(c.value));
	if (heading) {
		return heading.value.replace(/^#+\s*/, '').split('\n')[0].slice(0, 80);
	}
	const first = section.cells[0];
	const kind = first?.kind === vscode.NotebookCellKind.Code ? `code: ` : '';
	return `${kind}${(first?.value ?? '').replace(/\s+/g, ' ').slice(0, 80)}`;
}

/** True if `value` is an array containing every integer in [0, length) exactly once. */
function isPermutation(value: unknown, length: number): boolean {
	if (!Array.isArray(value) || value.length !== length) {
		return false;
	}
	const seen = new Set<number>();
	for (const entry of value) {
		if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0 || entry >= length || seen.has(entry)) {
			return false;
		}
		seen.add(entry);
	}
	return true;
}

/** Splits a flat cell list into sections, each beginning at a markdown heading. */
function splitSections(cells: IWorkingCell[]): ISection[] {
	const sections: ISection[] = [];
	let current: ISection | undefined;
	for (const cell of cells) {
		const isHeading = cell.kind === vscode.NotebookCellKind.Markup && /^#{1,3}\s/.test(cell.value.trimStart());
		if (isHeading || !current) {
			current = { cells: [] };
			sections.push(current);
		}
		current.cells.push(cell);
	}
	return sections;
}

function startsWithHeading(cells: IWorkingCell[]): boolean {
	const first = cells[0];
	return !!first && first.kind === vscode.NotebookCellKind.Markup && /^#{1,3}\s/.test(first.value.trimStart());
}

/** Deterministic markdown tidy: trim trailing whitespace, collapse blank-line runs, blank line after headings. */
function tidyMarkdown(text: string): string {
	const lines = text.replace(/\r\n/g, '\n').split('\n').map(line => line.replace(/\s+$/, ''));
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const blank = line.length === 0;
		if (blank && out.length > 0 && out[out.length - 1].length === 0) {
			continue; // collapse consecutive blank lines
		}
		out.push(line);
		// Ensure a blank line follows a heading for readability.
		if (/^#{1,6}\s/.test(line) && i + 1 < lines.length && lines[i + 1].length !== 0) {
			out.push('');
		}
	}
	return out.join('\n').trim();
}

/** Deterministic code tidy: trim trailing whitespace per line, drop trailing blank lines. */
function tidyCode(text: string): string {
	return text.replace(/\r\n/g, '\n').split('\n').map(line => line.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
}

/** Removes a wrapping ``` code fence the model may have added around its answer. */
function stripFences(text: string): string {
	const fenced = text.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$/);
	return (fenced ? fenced[1] : text).trim();
}

function markdownCell(value: string): IWorkingCell {
	return { kind: vscode.NotebookCellKind.Markup, value, languageId: 'markdown', outputs: [], metadata: undefined, executionSummary: undefined };
}

function toWorking(cell: vscode.NotebookCell): IWorkingCell {
	return {
		kind: cell.kind,
		value: cell.document.getText(),
		languageId: cell.document.languageId,
		outputs: cell.outputs,
		metadata: cell.metadata,
		executionSummary: cell.executionSummary
	};
}

function toCellData(cell: IWorkingCell): vscode.NotebookCellData {
	const data = new vscode.NotebookCellData(cell.kind, cell.value, cell.languageId);
	data.outputs = [...cell.outputs];
	data.metadata = cell.metadata;
	data.executionSummary = cell.executionSummary;
	return data;
}

/** Bridges a {@link vscode.CancellationToken} to the `AbortSignal` the model client expects. */
function toSignal(token: vscode.CancellationToken): AbortSignal {
	const controller = new AbortController();
	if (token.isCancellationRequested) {
		controller.abort();
	} else {
		token.onCancellationRequested(() => controller.abort());
	}
	return controller.signal;
}
