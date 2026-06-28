/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { IsMacNativeContext } from '../../../../platform/contextkey/common/contextkeys.js';

// vkcode: Zed-style application menu — a leading "vkcode" menu grouping About,
// settings, keymap, themes, extensions and quit (mirrors the Zed app menu).
const MenubarVkcodeMenu = new MenuId('MenubarVkcodeMenu');

MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
	submenu: MenubarVkcodeMenu,
	title: {
		value: 'vkcode',
		original: 'vkcode',
		mnemonicTitle: localize({ key: 'mVkcode', comment: ['&& denotes a mnemonic'] }, "&&vkcode")
	},
	when: IsMacNativeContext.negate(),
	order: 0
});

// Group 1 — About / Updates
MenuRegistry.appendMenuItem(MenubarVkcodeMenu, {
	command: { id: 'workbench.action.showAboutDialog', title: localize('vkcode.about', "About vkcode") },
	group: '1_about', order: 1
});
MenuRegistry.appendMenuItem(MenubarVkcodeMenu, {
	command: { id: 'update.checkForUpdate', title: localize('vkcode.checkUpdates', "Check for Updates…") },
	group: '1_about', order: 2
});

// Group 2 — Settings
MenuRegistry.appendMenuItem(MenubarVkcodeMenu, {
	command: { id: 'workbench.action.openSettings', title: localize('vkcode.openSettings', "Open Settings") },
	group: '2_settings', order: 1
});
MenuRegistry.appendMenuItem(MenubarVkcodeMenu, {
	command: { id: 'workbench.action.openSettingsJson', title: localize('vkcode.openSettingsFile', "Open Settings File") },
	group: '2_settings', order: 2
});
MenuRegistry.appendMenuItem(MenubarVkcodeMenu, {
	command: { id: 'workbench.action.openWorkspaceSettings', title: localize('vkcode.openProjectSettings', "Open Project Settings") },
	group: '2_settings', order: 3
});
MenuRegistry.appendMenuItem(MenubarVkcodeMenu, {
	command: { id: 'workbench.action.openWorkspaceSettingsFile', title: localize('vkcode.openProjectSettingsFile', "Open Project Settings File") },
	group: '2_settings', order: 4
});
MenuRegistry.appendMenuItem(MenubarVkcodeMenu, {
	command: { id: 'workbench.action.openRawDefaultSettings', title: localize('vkcode.openDefaultSettings', "Open Default Settings") },
	group: '2_settings', order: 5
});

// Group 3 — Keymap
MenuRegistry.appendMenuItem(MenubarVkcodeMenu, {
	command: { id: 'workbench.action.openGlobalKeybindings', title: localize('vkcode.openKeymap', "Open Keymap") },
	group: '3_keymap', order: 1
});
MenuRegistry.appendMenuItem(MenubarVkcodeMenu, {
	command: { id: 'workbench.action.openGlobalKeybindingsFile', title: localize('vkcode.openKeymapFile', "Open Keymap File") },
	group: '3_keymap', order: 2
});
MenuRegistry.appendMenuItem(MenubarVkcodeMenu, {
	command: { id: 'workbench.action.openDefaultKeybindingsFile', title: localize('vkcode.openDefaultKeybindings', "Open Default Key Bindings") },
	group: '3_keymap', order: 3
});

// Group 4 — Themes
MenuRegistry.appendMenuItem(MenubarVkcodeMenu, {
	command: { id: 'workbench.action.selectTheme', title: localize('vkcode.selectTheme', "Select Theme…") },
	group: '4_theme', order: 1
});
MenuRegistry.appendMenuItem(MenubarVkcodeMenu, {
	command: { id: 'workbench.action.selectIconTheme', title: localize('vkcode.selectIconTheme', "Select Icon Theme…") },
	group: '4_theme', order: 2
});

// Group 5 — Extensions
MenuRegistry.appendMenuItem(MenubarVkcodeMenu, {
	command: { id: 'workbench.view.extensions', title: localize('vkcode.extensions', "Extensions") },
	group: '5_extensions', order: 1
});

// Group 6 — Quit
MenuRegistry.appendMenuItem(MenubarVkcodeMenu, {
	command: { id: 'workbench.action.quit', title: localize('vkcode.quit', "Quit vkcode") },
	group: '6_quit', order: 1
});

MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
	submenu: MenuId.MenubarFileMenu,
	title: {
		value: 'File',
		original: 'File',
		mnemonicTitle: localize({ key: 'mFile', comment: ['&& denotes a mnemonic'] }, "&&File"),
	},
	order: 1
});

MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
	submenu: MenuId.MenubarEditMenu,
	title: {
		value: 'Edit',
		original: 'Edit',
		mnemonicTitle: localize({ key: 'mEdit', comment: ['&& denotes a mnemonic'] }, "&&Edit")
	},
	order: 2
});

MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
	submenu: MenuId.MenubarSelectionMenu,
	title: {
		value: 'Selection',
		original: 'Selection',
		mnemonicTitle: localize({ key: 'mSelection', comment: ['&& denotes a mnemonic'] }, "&&Selection")
	},
	order: 3
});

MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
	submenu: MenuId.MenubarViewMenu,
	title: {
		value: 'View',
		original: 'View',
		mnemonicTitle: localize({ key: 'mView', comment: ['&& denotes a mnemonic'] }, "&&View")
	},
	order: 4
});

MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
	submenu: MenuId.MenubarGoMenu,
	title: {
		value: 'Go',
		original: 'Go',
		mnemonicTitle: localize({ key: 'mGoto', comment: ['&& denotes a mnemonic'] }, "&&Go")
	},
	order: 5
});

MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
	submenu: MenuId.MenubarTerminalMenu,
	title: {
		value: 'Terminal',
		original: 'Terminal',
		mnemonicTitle: localize({ key: 'mTerminal', comment: ['&& denotes a mnemonic'] }, "&&Terminal")
	},
	order: 7
});

MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
	submenu: MenuId.MenubarHelpMenu,
	title: {
		value: 'Help',
		original: 'Help',
		mnemonicTitle: localize({ key: 'mHelp', comment: ['&& denotes a mnemonic'] }, "&&Help")
	},
	order: 8
});

MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
	submenu: MenuId.MenubarPreferencesMenu,
	title: {
		value: 'Preferences',
		original: 'Preferences',
		mnemonicTitle: localize({ key: 'mPreferences', comment: ['&& denotes a mnemonic'] }, "&&Preferences")
	},
	when: IsMacNativeContext,
	order: 9
});
