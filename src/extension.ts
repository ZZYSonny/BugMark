import * as vscode from 'vscode';
import * as fs from 'fs';
import { RecordItem, getCurProp } from './record';

export class BugMarkTreeProvider implements vscode.TreeDataProvider<RecordItem> {
	private emitterOnDidChangeTreeData = new vscode.EventEmitter<RecordItem>();
	readonly onDidChangeTreeData = this.emitterOnDidChangeTreeData.event;
	private root: RecordItem;

	constructor() {
		this.loadFromFile();
	}

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

	loadFromFile(): void {
		const reviver = (key: string, value: any) => {
			if (typeof value === "object" && value &&
				Object.values(value).every(
					x => x instanceof Array || x instanceof Map
				)) {
				return new Map(Object.entries(value));
			}
			return value;
		}
		const fileURI = vscode.Uri.joinPath(
			vscode.workspace.workspaceFolders[0].uri,
			".vscode", "bugmark.json"
		);
		if (!fs.existsSync(fileURI.fsPath)) {
			this.writeToFile({});
		}
		const buffer = fs.readFileSync(fileURI.fsPath);
		const json = JSON.parse(buffer.toString(), reviver);
		this.root = new RecordItem(null, "root", json);
	}

	writeToFile(data: Object | null = null): void {
		const folderURI = vscode.Uri.joinPath(
			vscode.workspace.workspaceFolders[0].uri,
			".vscode"
		);
		const fileURI = vscode.Uri.joinPath(
			folderURI,
			"bugmark.json"
		);
		if (!data) data = this.root.serialize();
		if (!fs.existsSync(folderURI.path)) {
			fs.mkdirSync(folderURI.path, { recursive: true });
		}
		fs.writeFileSync(fileURI.fsPath, JSON.stringify(data));
	}

	updateCheckBox() {
		const changed = this.root.forEachAndRefresh((x) => x.updateCheckBox());
		this.refresh(changed.parent);
	}

	refresh(node: RecordItem | null) {
		if (node === this.root) node = null;
		this.emitterOnDidChangeTreeData.fire(node);
	}

	addItemWithPath(path: Array<string>, item: RecordItem) {
		let [i, changed] = this.root.findDown(path);
		if (changed.props) throw `Expected all folders on the path`
		const ans = changed.addDown(path.slice(i), item);
		this.refresh(changed.parent);
		return ans;
	}

	removeItem(item: RecordItem) {
		item.removeFromParent();
		this.refresh(item.parent);
	}

	renameItem(path: Array<string>, item: RecordItem) {
		this.removeItem(item);
		this.addItemWithPath(path, item)
	}
}

let provider = new BugMarkTreeProvider();

export function activate(context: vscode.ExtensionContext) {
	let view = vscode.window.createTreeView(
		"bugmark.view.bookmarks",
		{ treeDataProvider: provider }
	);
	context.subscriptions.push(view);
	context.subscriptions.push(vscode.commands.registerCommand(
		'bugmark.command.markline', async () => {
			const pathstr = await vscode.window.showInputBox({
				title: "Bookmark Name?",
				prompt: "Split with /"
			})
			const path = pathstr.split("/");
			const item = new RecordItem(null, path.pop(), [getCurProp()]);
			provider.addItemWithPath(path, item);
		}
	))
	context.subscriptions.push(vscode.commands.registerCommand(
		"bugmark.view.title.refresh", () => {
			provider.loadFromFile();
			provider.refresh(null)
			//provider.writeToFile();
		}
	))
	context.subscriptions.push(vscode.commands.registerCommand(
		"bugmark.view.item.goto", (item: RecordItem) => {
			item.revealAndHighlight(1000);
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
			const path = pathstr.split("/");
			item.label = path.pop();
			provider.renameItem(path, item);
		}
	))
	context.subscriptions.push(vscode.commands.registerCommand(
		"bugmark.view.item.remove",
		(item: RecordItem) => provider.removeItem(item)
	))
	let changeCheckbox = false;
	context.subscriptions.push(view.onDidChangeCheckboxState((ev) => {
		changeCheckbox = true;
		for (const [record, _] of ev.items)
			if (record.props) {
				const head = record.getHead();
				if (record.checked()) {
					vscode.debug.addBreakpoints([
						new vscode.SourceBreakpoint(
							new vscode.Location(
								vscode.Uri.file(head.file),
								new vscode.Position(head.lineno, 0)
							)
						)
					])
				} else {
					const bp = vscode.debug.breakpoints.find(
						(b) => record.matchBreakpoint(b)
					);
					vscode.debug.removeBreakpoints([bp]);
				}
			}
		changeCheckbox = false;
	}));
	context.subscriptions.push(vscode.debug.onDidChangeBreakpoints((ev) => {
		if (!changeCheckbox) {
			provider.updateCheckBox();
		}
	}));
}
export function deactivate() {
	provider = null;
}
