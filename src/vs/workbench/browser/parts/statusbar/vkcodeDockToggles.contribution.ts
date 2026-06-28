/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarService, IStatusbarEntry, IStatusbarEntryAccessor, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { ViewContainerLocation } from '../../../common/views.js';

const EXPLORER_VIEWLET_ID = 'workbench.view.explorer';
const SCM_VIEWLET_ID = 'workbench.view.scm';
const TOGGLE_EXPLORER_COMMAND = 'vkcode.toggleExplorer';
const TOGGLE_SCM_COMMAND = 'vkcode.toggleSourceControl';

/**
 * Zed-style side-bar view toggle: open and focus the given side-bar view; if that view is already
 * the active one, hide the side bar instead. This also lets the user leave another view (e.g. the
 * Extensions view) by switching straight to the target view.
 */
function registerViewletToggle(commandId: string, viewletId: string): void {
	CommandsRegistry.registerCommand(commandId, (accessor: ServicesAccessor) => {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const paneCompositeService = accessor.get(IPaneCompositePartService);

		const sidebarVisible = layoutService.isVisible(Parts.SIDEBAR_PART, mainWindow);
		const active = paneCompositeService.getActivePaneComposite(ViewContainerLocation.Sidebar);

		if (sidebarVisible && active?.getId() === viewletId) {
			layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
		} else {
			paneCompositeService.openPaneComposite(viewletId, ViewContainerLocation.Sidebar, true);
		}
	});
}

registerViewletToggle(TOGGLE_EXPLORER_COMMAND, EXPLORER_VIEWLET_ID);
registerViewletToggle(TOGGLE_SCM_COMMAND, SCM_VIEWLET_ID);

/** "On" when the side bar is visible and showing the given view. */
function isViewletActive(layoutService: IWorkbenchLayoutService, paneCompositeService: IPaneCompositePartService, viewletId: string): boolean {
	return layoutService.isVisible(Parts.SIDEBAR_PART, mainWindow) &&
		paneCompositeService.getActivePaneComposite(ViewContainerLocation.Sidebar)?.getId() === viewletId;
}

interface IDockToggleDescriptor {
	readonly part: Parts;
	readonly id: string;
	readonly name: string;
	readonly command: string;
	readonly onIcon: string;
	readonly offIcon: string;
	readonly alignment: StatusbarAlignment;
	readonly priority: number;
	readonly label: string;
	/** Overrides the "on" state used to pick the icon (defaults to part visibility). */
	readonly isOn?: (accessor: { layoutService: IWorkbenchLayoutService; paneCompositeService: IPaneCompositePartService }) => boolean;
}

/**
 * Zed-style dock toggles in the bottom status bar: show/hide the Explorer (left), the panel and
 * the secondary side bar (right). Essential here because the activity bar is hidden, so otherwise
 * there is no affordance to close an open side bar or switch away from the Extensions view.
 */
class VkcodeDockToggles extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vkcodeDockToggles';

	private readonly descriptors: IDockToggleDescriptor[] = [
		{
			part: Parts.SIDEBAR_PART,
			id: 'vkcode.status.toggleSidebar',
			name: localize('vkcode.dock.explorer', "Explorer"),
			command: TOGGLE_EXPLORER_COMMAND,
			onIcon: 'layout-sidebar-left',
			offIcon: 'layout-sidebar-left-off',
			alignment: StatusbarAlignment.LEFT,
			priority: 100,
			label: localize('vkcode.dock.explorer.toggle', "Toggle Explorer"),
			isOn: ({ layoutService, paneCompositeService }) => isViewletActive(layoutService, paneCompositeService, EXPLORER_VIEWLET_ID)
		},
		{
			part: Parts.SIDEBAR_PART,
			id: 'vkcode.status.toggleSourceControl',
			name: localize('vkcode.dock.scm', "Source Control"),
			command: TOGGLE_SCM_COMMAND,
			onIcon: 'source-control',
			offIcon: 'source-control',
			alignment: StatusbarAlignment.LEFT,
			priority: 99,
			label: localize('vkcode.dock.scm.toggle', "Toggle Source Control"),
			isOn: ({ layoutService, paneCompositeService }) => isViewletActive(layoutService, paneCompositeService, SCM_VIEWLET_ID)
		},
		{
			part: Parts.PANEL_PART,
			id: 'vkcode.status.togglePanel',
			name: localize('vkcode.dock.console', "Console"),
			command: 'workbench.action.togglePanel',
			onIcon: 'terminal',
			offIcon: 'terminal',
			alignment: StatusbarAlignment.RIGHT,
			priority: 50,
			label: localize('vkcode.dock.console.toggle', "Toggle Console")
		}
		// vkcode: no Secondary Side Bar toggle — that dock only hosts the (hidden) chat view, so the
		// toggle would just open AI chat. The right dock is the Console (panel) above.
	];

	private readonly accessors = this._register(new DisposableMap<string, IStatusbarEntryAccessor>());

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
	) {
		super();

		for (const descriptor of this.descriptors) {
			this.accessors.set(descriptor.id, this.statusbarService.addEntry(this.entry(descriptor), descriptor.id, descriptor.alignment, descriptor.priority));
		}

		this._register(this.layoutService.onDidChangePartVisibility(() => this.refresh()));
		this._register(this.paneCompositeService.onDidPaneCompositeOpen(() => this.refresh()));
		this._register(this.paneCompositeService.onDidPaneCompositeClose(() => this.refresh()));
	}

	private entry(descriptor: IDockToggleDescriptor): IStatusbarEntry {
		const on = descriptor.isOn
			? descriptor.isOn({ layoutService: this.layoutService, paneCompositeService: this.paneCompositeService })
			: this.layoutService.isVisible(descriptor.part, mainWindow);
		const icon = on ? descriptor.onIcon : descriptor.offIcon;
		return {
			name: descriptor.name,
			text: `$(${icon})`,
			ariaLabel: descriptor.label,
			tooltip: descriptor.label,
			command: descriptor.command
		};
	}

	private refresh(): void {
		for (const descriptor of this.descriptors) {
			this.accessors.get(descriptor.id)?.update(this.entry(descriptor));
		}
	}
}

registerWorkbenchContribution2(VkcodeDockToggles.ID, VkcodeDockToggles, WorkbenchPhase.AfterRestored);
