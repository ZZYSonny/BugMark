import * as vscode from 'vscode';

class RecordProp {
	file: string
	lineno: number
	content: string
	commit: string
	head: boolean
}

type RecordLeaf = Array<RecordProp>
type RecordParent = Map<string, RecordNode>
type RecordNode = RecordLeaf | RecordParent

let RecordRoot: RecordNode = new Map([
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
])

class RecordItem extends vscode.TreeItem {
	constructor(name: string, public node: RecordNode) {
		let collapseState = (node instanceof Map)?2:0;
		super(name, collapseState);
	}
}

export class BugMarkTreeProvider implements vscode.TreeDataProvider<RecordItem> {
	constructor() { }

	getTreeItem(element: RecordItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: RecordItem): Thenable<RecordItem[]> {
		let node: RecordNode = element ? element.node : RecordRoot;
		if (node instanceof Map) {
			return Promise.resolve(
				Array.from(node).map(
					([name, child]) => new RecordItem(name, child))
			)
		} else {
			throw "Bugmark: getChildren on a leaf node";
		}
	}
}

let provider = new BugMarkTreeProvider();

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.window.registerTreeDataProvider(
		"bugmark.view.bookmarks", provider
	))
	context.subscriptions.push(vscode.commands.registerCommand(
		'bugmark.command.markline',
		() => {
			let editor = vscode.window.activeTextEditor;
			let document = editor.document;
			let cursor = editor.selection.active;
			let file = document.fileName;
			let line = document.lineAt(cursor).lineNumber;
			vscode.window.showInformationMessage(`Bookmark ${line}`);
			//vscode.debug.addBreakpoints
		}
	))
}
export function deactivate() {
	RecordRoot = null;
	provider = null;
}
