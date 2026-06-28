/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Action2, registerAction2, MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandActionTitle } from '../../../../platform/action/common/action.js';

/**
 * Zed-style "editor controls" dropdown: a single button at the right of the editor title bar
 * that opens a menu of editor toggles (minimap, line numbers, git blame, …). Mirrors Zed's
 * editor controls; toggles that have no VS Code core equivalent (Vim/Helix mode, inline
 * diagnostics) are intentionally omitted in favour of the settings that genuinely exist.
 */
const VkcodeEditorControlsMenu = new MenuId('VkcodeEditorControls');

MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
	submenu: VkcodeEditorControlsMenu,
	title: localize2('vkcode.editorControls', "Editor Controls"),
	icon: Codicon.settings,
	group: 'navigation',
	order: 100
});

/** Register a toggle for a boolean setting, checkmarked via its `config.*` context key. */
function registerBoolToggle(id: string, title: ICommandActionTitle, setting: string, group: string, order: number): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id,
				title,
				toggled: ContextKeyExpr.equals(`config.${setting}`, true),
				menu: { id: VkcodeEditorControlsMenu, group, order }
			});
		}
		run(accessor: ServicesAccessor): void {
			const configurationService = accessor.get(IConfigurationService);
			configurationService.updateValue(setting, configurationService.getValue(setting) !== true);
		}
	});
}

/** Register a toggle for a two-state string setting (e.g. line numbers on/off). */
function registerEnumToggle(id: string, title: ICommandActionTitle, setting: string, onValue: string, offValue: string, group: string, order: number): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id,
				title,
				toggled: ContextKeyExpr.notEquals(`config.${setting}`, offValue),
				menu: { id: VkcodeEditorControlsMenu, group, order }
			});
		}
		run(accessor: ServicesAccessor): void {
			const configurationService = accessor.get(IConfigurationService);
			const current = configurationService.getValue(setting);
			configurationService.updateValue(setting, current === offValue ? onValue : offValue);
		}
	});
}

// Group 1 — View
registerBoolToggle('vkcode.editor.toggleMinimap', localize2('vkcode.ec.minimap', "Minimap"), 'editor.minimap.enabled', '1_view', 1);
registerBoolToggle('vkcode.editor.toggleEditPredictions', localize2('vkcode.ec.editPredictions', "Edit Predictions"), 'editor.inlineSuggest.enabled', '1_view', 2);

// Group 2 — Editor
registerEnumToggle('vkcode.editor.toggleLineNumbers', localize2('vkcode.ec.lineNumbers', "Line Numbers"), 'editor.lineNumbers', 'on', 'off', '2_editor', 1);
registerBoolToggle('vkcode.editor.toggleStickyScroll', localize2('vkcode.ec.stickyScroll', "Sticky Scroll"), 'editor.stickyScroll.enabled', '2_editor', 2);
registerBoolToggle('vkcode.editor.toggleSignatureHelp', localize2('vkcode.ec.signatureHelp', "Auto Signature Help"), 'editor.parameterHints.enabled', '2_editor', 3);

// Group 3 — Formatting
registerEnumToggle('vkcode.editor.toggleWordWrap', localize2('vkcode.ec.wordWrap', "Word Wrap"), 'editor.wordWrap', 'on', 'off', '3_format', 1);
registerBoolToggle('vkcode.editor.toggleIndentGuides', localize2('vkcode.ec.indentGuides', "Indent Guides"), 'editor.guides.indentation', '3_format', 2);
registerEnumToggle('vkcode.editor.toggleRenderWhitespace', localize2('vkcode.ec.renderWhitespace', "Render Whitespace"), 'editor.renderWhitespace', 'all', 'none', '3_format', 3);

// Group 4 — Git
registerBoolToggle('vkcode.editor.toggleInlineBlame', localize2('vkcode.ec.inlineBlame', "Inline Git Blame"), 'git.blame.editorDecoration.enabled', '4_git', 1);

// Group 5 — Other
registerBoolToggle('vkcode.editor.toggleBreadcrumbs', localize2('vkcode.ec.breadcrumbs', "Breadcrumbs"), 'breadcrumbs.enabled', '5_other', 1);
