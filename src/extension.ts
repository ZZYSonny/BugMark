import * as vscode from 'vscode';

type RecursiveMapArray<S, T> = Array<T> | Map<S, RecursiveMapArray<S, T>>
type RecordJSON = RecursiveMapArray<string, RecordProp>

class RecordProp {
	file: string
	lineno: number
	content: string
	commit: string
	head: boolean
}

function getCurProp(): RecordProp {
	const editor = vscode.window.activeTextEditor;
	const document = editor.document;
	const cursor = editor.selection.active;

	return {
		file: document.fileName,
		lineno: document.lineAt(cursor).lineNumber,
		content: "",
		commit: "",
		head: true
	}
}

class RecordItem extends vscode.TreeItem {
	parent: RecordItem | null
	props: Array<RecordProp> | null = null
	children: Array<RecordItem> = []

	constructor(parent: RecordItem | null, name: string, json: RecordJSON | null) {
		if (json instanceof Array) {
			super(name, vscode.TreeItemCollapsibleState.None);
			this.props = json;
		} else {
			super(name, vscode.TreeItemCollapsibleState.Expanded);
			if (json) {
				this.children = Array.from(json).map(
					([name, node]) => new RecordItem(this, name, node)
				)
			}
		}
		this.parent = parent;
		this.command = {
			command: "bugmark.view.item.goto",
			title: "Goto file",
			arguments: [this]
		}
	}

	toJSON() {
		if (this.props) return this.props;
		else return this.children.map((x) => x.toJSON());
	}
}


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
		const json = new Map([
			["1", new Map([
				["line 1", [{
					file: "/home/zzysonny/Documents/Code/Projects/VSCExtension/ExtDebugFolder/1.js",
					lineno: 0,
					content: "line 1",
					commit: "",
					head: true
				}]],
				["line 2", [{
					file: "/home/zzysonny/Documents/Code/Projects/VSCExtension/ExtDebugFolder/1.js",
					lineno: 1,
					content: "line 2",
					commit: "",
					head: true
				}]],
			])]
		]);
		this.root = new RecordItem(null, "root", json);
	}

	refresh() {
		this.emitterOnDidChangeTreeData.fire(null);
	}

	findItemWithPath(path: Array<string>): [number, RecordItem] {
		let cur = this.root;
		let i = 0;
		for (; i < path.length; i++) {
			const next = cur.children.find((x) => x.label === path[i])
			if (!next) break;
			else cur = next;
		}
		return [i, cur];
	}

	addItemWithPath(pathstr: string, props: Array<RecordProp>): void {
		const path = pathstr.split("/");
		// Follow existing folder
		let [i, changed] = this.findItemWithPath(path);
		if (i == path.length) throw `${pathstr} already exists`
		if (changed.props) throw `${path.slice(0, i).join("/")} is not a folder`
		// Add new folder
		let cur = changed;
		for (; i < path.length - 1; i++) {
			const next = new RecordItem(cur, path[i], null);
			cur.children.push(next);
			cur = next;
		}
		// Add new leaf item
		cur.children.push(new RecordItem(cur, path.pop(), props))
		// Update view
		this.emitterOnDidChangeTreeData.fire(changed.parent);
	}

	removeItem(item: RecordItem) {
		let cur = item;
		while (cur.parent) {
			const parent = cur.parent;
			const id = parent.children.findIndex((x) => x == cur);
			parent.children.splice(id, 1);
			cur = parent;
			if (cur.children.length > 0) break;
		}
		// Update view
		this.emitterOnDidChangeTreeData.fire(cur);
	}

	renameItem(item: RecordItem, newpath: string) {
		this.removeItem(item);
		this.addItemWithPath(newpath, item.props)
	}
}

let provider = new BugMarkTreeProvider();

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.window.registerTreeDataProvider(
		"bugmark.view.bookmarks",
		provider
	))
	context.subscriptions.push(vscode.commands.registerCommand(
		'bugmark.command.markline',
		() => {
			const props = [getCurProp()];
			const path = "2/added";
			provider.addItemWithPath(path, props);
		}
	))
	context.subscriptions.push(vscode.commands.registerCommand(
		"bugmark.view.title.refresh",
		() => {
			provider.loadFromFile();
			provider.refresh()
		}
	))
	context.subscriptions.push(vscode.commands.registerCommand(
		"bugmark.view.item.goto",
		async (item: RecordItem) => {
			const headProp = item.props.find((x) => x.head);
			const doc = await vscode.workspace.openTextDocument(headProp.file);
			const editor = await vscode.window.showTextDocument(doc);
			const range = editor.document.lineAt(headProp.lineno).range;
			editor.selection = new vscode.Selection(range.start, range.end);
			editor.revealRange(range);
		}
	))
	context.subscriptions.push(vscode.commands.registerCommand(
		"bugmark.view.item.rename",
		(item: RecordItem) => {
			const path = "1/line 3";
			provider.renameItem(item, path);
		}
	))
	context.subscriptions.push(vscode.commands.registerCommand(
		"bugmark.view.item.remove",
		(item: RecordItem) => provider.removeItem(item)
	))
	context.subscriptions.push(vscode.commands.registerCommand(
		"bugmark.view.item.breakpoint",
		() => { }
	))

}
export function deactivate() {
	provider = null;
}
