import * as vscode from 'vscode';
import { RecordItem, RecordProp } from './record';
import { GitExtension } from './git';

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
		this.updateCheckBox();
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

	async updateCheckBox() {
		//const start = Date.now();
		const fileCache = new Map<string, Promise<any>>();
		await this.root.forEach(
			(x) => x.updateCheckBox(fileCache)
		);
		this.refresh(this.root);
		//const end = Date.now();
		//console.log((end - start) / 1000);
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
}

let provider = new BugMarkTreeProvider();

function waitGitInitialize() {
	return new Promise<void>(async (resolve, reject) => {
		const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
		const gitActivated = await gitExtension.activate();
		const gitAPI = gitActivated.getAPI(1);

		if (gitAPI.state == "initialized") resolve();
		else {
			gitAPI.onDidChangeState((ev) => {
				if (ev == "initialized") resolve();
			})
		}
	})
}

export async function activate(context: vscode.ExtensionContext) {
	await waitGitInitialize();
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
					await RecordProp.fromCursor()
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
				const prop = await item.getAdaptedProp();
				const document = await prop.openTextDocument();
				await prop.reveal(document, 1000);
				provider.writeToFile();
			}
		}
	))
	context.subscriptions.push(vscode.commands.registerCommand(
		"bugmark.view.item.rename", async (item: RecordItem) => {
			const oldname = item.getTreePath();
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
		for (const [record, _] of ev.items) {
			if (record.prop) {
				const prop = await record.getAdaptedProp();
				if (record.getCheckboxState()) {
					prop.addBreakpoint();
				} else {
					prop.removeBreakpoint();
				}
			}
		}
		provider.writeToFile();
		changeCheckbox = false;
	}));
	// Update checkbox when new breakpoint is added or removed
	context.subscriptions.push(vscode.debug.onDidChangeBreakpoints((ev) => {
		if (!changeCheckbox) {
			if (ev.changed.length == 0) {
				provider.updateCheckBox();
			}
		}
	}));
}
export function deactivate() {
	provider = null;
}
