/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import DOMPurify, { type Config as DOMPurifyConfig } from 'dompurify';
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import type { ActivationFunction } from 'vscode-notebook-renderer';

const allowedHtmlTags = Object.freeze(['a',
	'abbr',
	'b',
	'bdo',
	'blockquote',
	'br',
	'caption',
	'cite',
	'code',
	'col',
	'colgroup',
	'dd',
	'del',
	'details',
	'dfn',
	'div',
	'dl',
	'dt',
	'em',
	'figcaption',
	'figure',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'hr',
	'i',
	'img',
	'ins',
	'kbd',
	'label',
	'li',
	'mark',
	'ol',
	'p',
	'pre',
	'q',
	'rp',
	'rt',
	'ruby',
	'samp',
	'small',
	'small',
	'source',
	'span',
	'strike',
	'strong',
	'sub',
	'summary',
	'sup',
	'table',
	'tbody',
	'td',
	'tfoot',
	'th',
	'thead',
	'time',
	'tr',
	'tt',
	'u',
	'ul',
	'var',
	'video',
	'wbr',
]);

const allowedSvgTags = Object.freeze([
	'svg',
	'a',
	'altglyph',
	'altglyphdef',
	'altglyphitem',
	'animatecolor',
	'animatemotion',
	'animatetransform',
	'circle',
	'clippath',
	'defs',
	'desc',
	'ellipse',
	'filter',
	'font',
	'g',
	'glyph',
	'glyphref',
	'hkern',
	'image',
	'line',
	'lineargradient',
	'marker',
	'mask',
	'metadata',
	'mpath',
	'path',
	'pattern',
	'polygon',
	'polyline',
	'radialgradient',
	'rect',
	'stop',
	'style',
	'switch',
	'symbol',
	'text',
	'textpath',
	'title',
	'tref',
	'tspan',
	'view',
	'vkern',
]);

const sanitizerOptions: DOMPurifyConfig = {
	ALLOWED_TAGS: [
		...allowedHtmlTags,
		...allowedSvgTags,
	],
};

// vkcode: "view fullscreen" affordance shown on hover over markdown image cards.
const VKCODE_EXPAND_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M2 2h5v1.5H3.5V7H2V2zm12 0v5h-1.5V3.5H9V2h5zM2 9h1.5v3.5H7V14H2V9zm10.5 0H14v5H9v-1.5h3.5V9z"/></svg>';

/**
 * vkcode: opens a markdown image in a fullscreen lightbox. The overlay is appended to the image's
 * own root (the cell's shadow root) so the renderer's styles apply, and `position: fixed` makes it
 * cover the viewport. Tries the real Fullscreen API first and falls back to the overlay.
 */
function openImageLightbox(img: HTMLImageElement): void {
	const host: Node = (img.getRootNode() as ShadowRoot).host ? img.getRootNode() : document.body;

	const overlay = document.createElement('div');
	overlay.className = 'vkcode-img-lightbox';

	const big = document.createElement('img');
	big.src = img.currentSrc || img.src;
	if (img.alt) {
		big.alt = img.alt;
	}
	overlay.appendChild(big);

	const closeBtn = document.createElement('button');
	closeBtn.className = 'vkcode-lightbox-close';
	closeBtn.type = 'button';
	closeBtn.title = 'Close (Esc)';
	closeBtn.setAttribute('aria-label', 'Close');
	closeBtn.textContent = '✕';
	overlay.appendChild(closeBtn);

	const cleanup = () => {
		document.removeEventListener('keydown', onKey);
		document.removeEventListener('fullscreenchange', onFullscreenChange);
		if (document.fullscreenElement === overlay) {
			document.exitFullscreen?.().catch(() => { /* ignore */ });
		}
		overlay.remove();
	};
	const onKey = (e: KeyboardEvent) => {
		if (e.key === 'Escape') {
			cleanup();
		}
	};
	const onFullscreenChange = () => {
		if (!document.fullscreenElement) {
			cleanup();
		}
	};

	overlay.addEventListener('click', cleanup);
	closeBtn.addEventListener('click', cleanup);
	document.addEventListener('keydown', onKey);
	document.addEventListener('fullscreenchange', onFullscreenChange);

	host.appendChild(overlay);
	overlay.requestFullscreen?.().catch(() => { /* fall back to the in-webview overlay */ });
}

/**
 * vkcode: wraps each rendered markdown image in a card with a hover "open image" button. Clicking it
 * posts the image to the extension host, which opens it in a separate editor tab (`post`); if
 * messaging is unavailable it falls back to the in-cell lightbox.
 */
function enhanceMarkdownImages(root: ParentNode, post: ((message: unknown) => void) | undefined): void {
	for (const img of Array.from(root.querySelectorAll('img'))) {
		if (img.closest('.vkcode-img-card')) {
			continue;
		}
		const card = document.createElement('span');
		card.className = 'vkcode-img-card';

		const button = document.createElement('button');
		button.className = 'vkcode-img-expand';
		button.type = 'button';
		button.title = 'Open image in editor';
		button.setAttribute('aria-label', 'Open image in editor');
		button.innerHTML = VKCODE_EXPAND_ICON;
		button.addEventListener('click', e => {
			e.preventDefault();
			e.stopPropagation();
			const src = img.currentSrc || img.src;
			if (post && src) {
				post({ type: 'vkcode-open-image', src, title: img.alt || undefined });
			} else {
				openImageLightbox(img);
			}
		});

		img.replaceWith(card);
		card.appendChild(img);
		card.appendChild(button);
	}
}

export const activate: ActivationFunction<void> = (ctx) => {
	const markdownIt: MarkdownIt = new MarkdownIt({
		html: true,
		linkify: true,
		highlight: (str: string, lang?: string) => {
			if (lang) {
				return `<div class="vscode-code-block" data-vscode-code-block-lang="${markdownIt.utils.escapeHtml(lang)}">${markdownIt.utils.escapeHtml(str)}</div>`;
			}
			return markdownIt.utils.escapeHtml(str);
		}
	});
	markdownIt.linkify.set({ fuzzyLink: false });

	addNamedHeaderRendering(markdownIt);
	addLinkRenderer(markdownIt);

	const style = document.createElement('style');
	style.textContent = `
		.emptyMarkdownCell::before {
			content: "${document.documentElement.style.getPropertyValue('--notebook-cell-markup-empty-content')}";
			font-style: italic;
			opacity: 0.6;
		}

		img {
			max-width: 100%;
			max-height: 100%;
		}

		a {
			text-decoration: none;
		}

		a:hover {
			text-decoration: underline;
		}

		a:focus,
		input:focus,
		select:focus,
		textarea:focus {
			outline: 1px solid -webkit-focus-ring-color;
			outline-offset: -1px;
		}

		hr {
			border: 0;
			height: 2px;
			border-bottom: 2px solid;
		}

		h2, h3, h4, h5, h6 {
			font-weight: normal;
		}

		h1 {
			font-size: 2.3em;
		}

		h2 {
			font-size: 2em;
		}

		h3 {
			font-size: 1.7em;
		}

		h3 {
			font-size: 1.5em;
		}

		h4 {
			font-size: 1.3em;
		}

		h5 {
			font-size: 1.2em;
		}

		h1,
		h2,
		h3 {
			font-weight: normal;
		}

		div {
			width: 100%;
		}

		/* Adjust margin of first item in markdown cell */
		*:first-child {
			margin-top: 0px;
		}

		/* h1 tags don't need top margin */
		h1:first-child {
			margin-top: 0;
		}

		/* Removes bottom margin when only one item exists in markdown cell */
		#preview > *:only-child,
		#preview > *:last-child {
			margin-bottom: 0;
			padding-bottom: 0;
		}

		/* makes all markdown cells consistent */
		div {
			min-height: var(--notebook-markdown-min-height);
		}

		table {
			border-collapse: collapse;
			border-spacing: 0;
		}

		table th,
		table td {
			border: 1px solid;
		}

		table > thead > tr > th {
			text-align: left;
			border-bottom: 1px solid;
		}

		table > thead > tr > th,
		table > thead > tr > td,
		table > tbody > tr > th,
		table > tbody > tr > td {
			padding: 5px 10px;
		}

		table > tbody > tr + tr > td {
			border-top: 1px solid;
		}

		blockquote {
			margin: 0 7px 0 5px;
			padding: 0 16px 0 10px;
			border-left-width: 5px;
			border-left-style: solid;
		}

		code {
			font-size: 1em;
			font-family: var(--vscode-editor-font-family);
		}

		pre code {
			line-height: 1.357em;
			white-space: pre-wrap;
			padding: 0;
		}

		li p {
			margin-bottom: 0.7em;
		}

		ul,
		ol {
			margin-bottom: 0.7em;
		}

		/* vkcode: refined notebook markdown typography */
		#preview { line-height: 1.6; }
		#preview h1, #preview h2, #preview h3, #preview h4, #preview h5, #preview h6 {
			font-weight: 600;
			line-height: 1.3;
			margin: 1.2em 0 0.5em;
			letter-spacing: -0.01em;
		}
		#preview h1 {
			font-size: 1.9em;
			padding-bottom: 0.24em;
			border-bottom: 1px solid var(--vscode-widget-border, rgba(130, 130, 130, 0.25));
		}
		#preview h2 {
			font-size: 1.5em;
			padding-bottom: 0.2em;
			border-bottom: 1px solid var(--vscode-widget-border, rgba(130, 130, 130, 0.18));
		}
		#preview h3 { font-size: 1.25em; }
		#preview h4 { font-size: 1.1em; }
		#preview h5 { font-size: 1em; }
		#preview h6 { font-size: 0.9em; color: var(--vscode-descriptionForeground); }
		#preview p { margin: 0.6em 0; }
		#preview a { color: var(--vscode-textLink-foreground); }
		#preview blockquote {
			margin: 0.8em 0;
			padding: 0.2em 1em;
			color: var(--vscode-textBlockQuote-foreground, var(--vscode-descriptionForeground));
			border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-textLink-foreground));
			background: var(--vscode-textBlockQuote-background, rgba(130, 130, 130, 0.06));
			border-radius: 0 4px 4px 0;
		}
		#preview :not(pre) > code {
			padding: 0.15em 0.4em;
			border-radius: 4px;
			background: var(--vscode-textCodeBlock-background, rgba(130, 130, 130, 0.14));
		}
		#preview pre {
			padding: 12px 14px;
			border-radius: 8px;
			overflow: auto;
			background: var(--vscode-textCodeBlock-background, rgba(130, 130, 130, 0.10));
			border: 1px solid var(--vscode-widget-border, transparent);
		}

		/* vkcode: markdown image cards with a hover "view fullscreen" button */
		.vkcode-img-card {
			position: relative;
			display: inline-block;
			max-width: 100%;
			margin: 6px 0;
			padding: 6px;
			border-radius: 10px;
			line-height: 0;
			background: var(--vscode-editorWidget-background, transparent);
			border: 1px solid var(--vscode-widget-border, transparent);
			box-shadow: 0 1px 2px rgba(0, 0, 0, 0.16), 0 6px 18px rgba(0, 0, 0, 0.10);
			transition: box-shadow 0.15s ease;
		}
		.vkcode-img-card:hover {
			box-shadow: 0 2px 6px rgba(0, 0, 0, 0.24), 0 12px 30px rgba(0, 0, 0, 0.16);
		}
		.vkcode-img-card > img {
			display: block;
			max-width: 100%;
			max-height: 360px;
			width: auto;
			height: auto;
			border-radius: 6px;
			object-fit: contain;
		}
		.vkcode-img-expand {
			position: absolute;
			top: 12px;
			right: 12px;
			width: 28px;
			height: 28px;
			padding: 0;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			border: 1px solid var(--vscode-widget-border, transparent);
			border-radius: 6px;
			background: var(--vscode-button-secondaryBackground, rgba(0, 0, 0, 0.6));
			color: var(--vscode-button-secondaryForeground, #ffffff);
			cursor: pointer;
			opacity: 0;
			transition: opacity 0.15s ease, background 0.15s ease;
		}
		.vkcode-img-card:hover .vkcode-img-expand,
		.vkcode-img-expand:focus-visible {
			opacity: 1;
		}
		.vkcode-img-expand:hover {
			background: var(--vscode-button-hoverBackground, rgba(0, 0, 0, 0.8));
		}
		.vkcode-img-lightbox {
			position: fixed;
			inset: 0;
			z-index: 2147483647;
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 24px;
			box-sizing: border-box;
			background: rgba(0, 0, 0, 0.86);
			cursor: zoom-out;
		}
		.vkcode-img-lightbox img {
			max-width: 96vw;
			max-height: 94vh;
			object-fit: contain;
			border-radius: 8px;
			box-shadow: 0 10px 48px rgba(0, 0, 0, 0.6);
		}
		.vkcode-lightbox-close {
			position: fixed;
			top: 16px;
			right: 20px;
			width: 34px;
			height: 34px;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			border: none;
			border-radius: 50%;
			background: rgba(255, 255, 255, 0.12);
			color: #ffffff;
			font-size: 16px;
			line-height: 1;
			cursor: pointer;
		}
		.vkcode-lightbox-close:hover {
			background: rgba(255, 255, 255, 0.24);
		}
	`;
	const template = document.createElement('template');
	template.classList.add('markdown-style');
	template.content.appendChild(style);
	document.head.appendChild(template);

	return {
		renderOutputItem: (outputInfo, element) => {
			let previewNode: HTMLElement;
			if (!element.shadowRoot) {
				const previewRoot = element.attachShadow({ mode: 'open' });

				// Insert styles into markdown preview shadow dom so that they are applied.
				// First add default webview style
				const defaultStyles = document.getElementById('_defaultStyles') as HTMLStyleElement;
				previewRoot.appendChild(defaultStyles.cloneNode(true));

				// And then contributed styles
				for (const element of document.getElementsByClassName('markdown-style')) {
					if (element instanceof HTMLTemplateElement) {
						previewRoot.appendChild(element.content.cloneNode(true));
					} else {
						previewRoot.appendChild(element.cloneNode(true));
					}
				}

				previewNode = document.createElement('div');
				previewNode.id = 'preview';
				previewRoot.appendChild(previewNode);
			} else {
				previewNode = element.shadowRoot.getElementById('preview')!;
			}

			const text = outputInfo.text();
			if (text.trim().length === 0) {
				previewNode.innerText = '';
				previewNode.classList.add('emptyMarkdownCell');
			} else {
				previewNode.classList.remove('emptyMarkdownCell');
				const markdownText = outputInfo.mime.startsWith('text/x-') ? `\`\`\`${outputInfo.mime.substr(7)}\n${text}\n\`\`\``
					: (outputInfo.mime.startsWith('application/') ? `\`\`\`${outputInfo.mime.substr(12)}\n${text}\n\`\`\`` : text);
				const unsanitizedRenderedMarkdown = markdownIt.render(markdownText, {
					outputItem: outputInfo,
				});
				previewNode.innerHTML = (ctx.workspace.isTrusted
					? unsanitizedRenderedMarkdown
					: DOMPurify.sanitize(unsanitizedRenderedMarkdown, sanitizerOptions)) as string;
				// vkcode: present markdown images as cards with an "open in editor" button.
				enhanceMarkdownImages(previewNode, ctx.postMessage?.bind(ctx));
			}
		},
		extendMarkdownIt: (f: (md: typeof markdownIt) => void) => {
			try {
				f(markdownIt);
			} catch (err) {
				console.error('Error extending markdown-it', err);
			}
		}
	};
};


function addNamedHeaderRendering(md: MarkdownIt): void {
	const slugCounter = new Map<string, number>();

	const originalHeaderOpen = md.renderer.rules.heading_open;
	md.renderer.rules.heading_open = (tokens: Token[], idx: number, options, env, self) => {
		const title = tokens[idx + 1].children!.reduce<string>((acc: string, t: Token) => acc + t.content, '');
		let slug = slugify(title);

		if (slugCounter.has(slug)) {
			const count = slugCounter.get(slug)!;
			slugCounter.set(slug, count + 1);
			slug = slugify(slug + '-' + (count + 1));
		} else {
			slugCounter.set(slug, 0);
		}

		tokens[idx].attrSet('id', slug);

		if (originalHeaderOpen) {
			return originalHeaderOpen(tokens, idx, options, env, self);
		} else {
			return self.renderToken(tokens, idx, options);
		}
	};

	const originalRender = md.render;
	md.render = function (str: string, env?: unknown) {
		slugCounter.clear();
		return originalRender.call(this, str, env);
	};
}

function addLinkRenderer(md: MarkdownIt): void {
	const original = md.renderer.rules.link_open;

	md.renderer.rules.link_open = (tokens: Token[], idx: number, options, env, self) => {
		const token = tokens[idx];
		const href = token.attrGet('href');
		if (typeof href === 'string' && href.startsWith('#')) {
			token.attrSet('href', '#' + slugify(href.slice(1)));
		}
		if (original) {
			return original(tokens, idx, options, env, self);
		} else {
			return self.renderToken(tokens, idx, options);
		}
	};
}

function slugify(text: string): string {
	const slugifiedHeading = encodeURI(
		text.trim()
			.toLowerCase()
			.replace(/\s+/g, '-') // Replace whitespace with -
			// allow-any-unicode-next-line
			.replace(/[\]\[\!\/\'\"\#\$\%\&\(\)\*\+\,\.\/\:\;\<\=\>\?\@\\\^\{\|\}\~\`。，、；：？！…—·ˉ¨‘’“”々～‖∶＂＇｀｜〃〔〕〈〉《》「」『』．〖〗【】（）［］｛｝]/g, '') // Remove known punctuators
			.replace(/^\-+/, '') // Remove leading -
			.replace(/\-+$/, '') // Remove trailing -
	);
	return slugifiedHeading;
}
