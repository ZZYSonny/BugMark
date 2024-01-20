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

function getBugmarkFromFile(): RecordJSON {
	return new Map([
		["1", new Map([
			["line 1", [{
				file: "1.js",
				lineno: 0,
				content: "line 1",
				commit: "",
				head: true
			}]],
			["line 2", [{
				file: "1.js",
				lineno: 1,
				content: "line 2",
				commit: "",
				head: true
			}]],
		])]
	]);
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
	}

	toJSON() {
		if (this.props) return this.props;
		else return this.children.map((x) => x.toJSON());
	}
}


export class BugMarkTreeProvider implements vscode.TreeDataProvider<RecordItem> {
	private emitterOnDidChangeTreeData = new vscode.EventEmitter<RecordItem>();
	readonly onDidChangeTreeData = this.emitterOnDidChangeTreeData.event;
	private root: RecordItem = this.loadFromFile();

	getTreeItem(element: RecordItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: RecordItem): Thenable<RecordItem[]> {
		if (element) return Promise.resolve(element.children);
		else return Promise.resolve(this.root.children);
	}

	getParent(element: RecordItem){
		return element.parent;
	}

	loadFromFile() {
		return new RecordItem(null, "root", getBugmarkFromFile());
	}

	addItemWithPath(pathstr: string, props: Array<RecordProp>) {
		const path = pathstr.split("/");
		let cur = this.root;
		let i = 0;
		// Follow existing folder
		for (; i < path.length - 1; i++) {
			if (cur.props) throw `${path.slice(0, i + 1).join("/")} is not a folder`
			const next = cur.children.find((x) => x.label === path[i])
			if (!next) break;
			else cur = next;
		}
		// Add new folder
		const changed = cur;
		for (; i < path.length - 1; i++) {
			const next = new RecordItem(cur, path[i], null);
			cur.children.push(next);
			cur = next;
		}
		// Add new leaf item
		cur.children.push(new RecordItem(cur, path.pop(), props))
		// Update view
		if(changed.parent) this.emitterOnDidChangeTreeData.fire(changed);
		else this.emitterOnDidChangeTreeData.fire(null);
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
			const pathstr = "1/added";
			const props = [getCurProp()];
			provider.addItemWithPath(pathstr, props);
		}
	))
	context.subscriptions.push(vscode.commands.registerCommand(
		"bugmark.view.command.refresh",
		() => { }
	))
	context.subscriptions.push(vscode.commands.registerCommand(
		"bugmark.view.item.goto",
		() => { }
	))
	context.subscriptions.push(vscode.commands.registerCommand(
		"bugmark.view.item.setbreakpoint",
		() => { }
	))

}
export function deactivate() {
	provider = null;
}
