import * as vscode from 'vscode';
import { RecordItem, RecordProp } from './record';

export class BugMarkTreeProvider implements vscode.TreeDataProvider<RecordItem> {
	private emitterOnDidChangeTreeData = new vscode.EventEmitter<RecordItem>();
	readonly onDidChangeTreeData = this.emitterOnDidChangeTreeData.event;
	private root: RecordItem;

	constructor() {
		this.loadFromFile();
	}

	// Tree Provider Ops
	getTreeItem(element: RecordItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: RecordItem): Thenable<RecordItem[]> {
		if (element) return Promise.resolve(element.children);
		else return Promise.resolve(this.root.children);
	}

	getParent(element: RecordItem) {
		return element.parent;
	}

	// Load / Store Ops
	loadFromFile(): void {
		const json = vscode.workspace.getConfiguration("bugmark").get("bookmarks") as any;
		this.root = RecordItem.deserialize("", json);
	}

	writeToFile(): void {
		const json = this.root.serialize();
		vscode.workspace.getConfiguration("bugmark").update("bookmarks", json)
	}

	// Command related ops.
	refresh(node: RecordItem | null) {
		if (node === this.root) node = null;
		this.emitterOnDidChangeTreeData.fire(node);
	}

	updateCheckBox() {
		const changed = this.root.forEach(
			(x) => x.updateCheckBox()
		);
		if (changed) this.refresh(changed.parent);
	}

	addItemWithPath(path: Array<string>, item: RecordItem) {
		let [i, changed] = this.root.findDown(path);
		if (changed.prop) throw `Expected all folders on the path`
		const ans = changed.addDown(path.slice(i), item);
		this.refresh(changed.parent);
		this.writeToFile();
		return ans;
	}

	removeItem(item: RecordItem) {
		item.removeFromParent();
		this.refresh(item.parent);
		this.writeToFile();
	}

	renameItem(path: Array<string>, item: RecordItem) {
		this.removeItem(item);
		this.addItemWithPath(path, item);
	}

	// Edit Ops
	applyEdit(ev: vscode.TextDocumentChangeEvent) {
		if (ev.contentChanges.length > 0) {
			const changed = this.root.forEach((x) => {
				if (x.prop && x.prop.file === ev.document.uri.path) {
					return x.prop.applyEdit(ev);
				}
				return false;
			})
			if (changed) this.writeToFile();
		}
	}

	applyRename(ev: vscode.FileRenameEvent) {
		const changed = this.root.forEach((x) => {
			if (x.prop) {
				return x.prop.applyRename(ev);
			}
			return false;
		})
		if (changed) this.writeToFile();
	}
}

let provider = new BugMarkTreeProvider();

export function activate(context: vscode.ExtensionContext) {
	// Register view
	let view = vscode.window.createTreeView(
		"bugmark.view.bookmarks",
		{ treeDataProvider: provider }
	);
	context.subscriptions.push(view);
	// Register command
	context.subscriptions.push(vscode.commands.registerCommand(
		'bugmark.command.markline', async () => {
			const pathstr = await vscode.window.showInputBox({
				title: "Bookmark Name?",
				prompt: "Split with /"
			})
			if (pathstr) {
				const path = pathstr.split("/");
				const item = new RecordItem(
					path.pop(),
					RecordProp.fromCursor()
				);
				provider.addItemWithPath(path, item);
			} else {
				throw "No input"
			}
		}
	))
	context.subscriptions.push(vscode.commands.registerCommand(
		"bugmark.view.title.edit", () => {
			vscode.commands.executeCommand(
				'workbench.action.openWorkspaceSettingsFile', {
				revealSetting: {
					key: 'bugmark.bookmarks',
					edit: true
				}
			});
		}
	))
	context.subscriptions.push(vscode.commands.registerCommand(
		"bugmark.view.title.reload", () => {
			provider.loadFromFile();
			provider.refresh(null)
		}
	))
	context.subscriptions.push(vscode.commands.registerCommand(
		"bugmark.view.item.goto", async (item: RecordItem) => {
			if (item.prop) {
				const document = await item.prop.openTextDocument();
				const [changed, head] = item.getHeadWithCorrection(document);
				await head.reveal(document, 1000);
				if (changed) provider.writeToFile();
			}
		}
	))
	context.subscriptions.push(vscode.commands.registerCommand(
		"bugmark.view.item.rename", async (item: RecordItem) => {
			const oldname = item.getFullPath();
			const pathstr = await vscode.window.showInputBox({
				title: "New Bookmark Name?",
				prompt: "Split with /",
				value: oldname
			})
			if (pathstr) {
				const path = pathstr.split("/");
				item.label = path.pop();
				provider.renameItem(path, item);
			} else {
				throw "No input"
			}
		}
	))
	context.subscriptions.push(vscode.commands.registerCommand(
		"bugmark.view.item.remove",
		(item: RecordItem) => provider.removeItem(item)
	))
	// Change breakpoint when checkbox state changes
	let changeCheckbox = false;
	context.subscriptions.push(view.onDidChangeCheckboxState(async (ev) => {
		changeCheckbox = true;
		let changedValidity = false;
		for (const [record, _] of ev.items) {
			if (record.prop) {
				const document = await record.prop.openTextDocument();
				const [changed, head] = record.getHeadWithCorrection(document);
				changedValidity = changedValidity || changed;
				if (record.getCheckboxState()) {
					head.addBreakpoint();
				} else {
					head.removeBreakpoint();
				}
			}
		}
		if (changedValidity) provider.writeToFile();
		changeCheckbox = false;
	}));
	// Update checkbox when breakpoint changes
	context.subscriptions.push(vscode.debug.onDidChangeBreakpoints((ev) => {
		if (!changeCheckbox) provider.updateCheckBox();
	}));
	// Update source location
	vscode.workspace.onDidChangeTextDocument((ev) => {
		provider.applyEdit(ev);
	})
	vscode.workspace.onDidRenameFiles((ev) => {
		provider.applyRename(ev);
	})
}
export function deactivate() {
	provider = null;
}
