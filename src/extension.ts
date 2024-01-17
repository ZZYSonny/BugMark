import * as vscode from 'vscode';

class Dependency extends vscode.TreeItem {
	constructor() {
		super("label", 1);
	}
}

export class NodeDependenciesProvider implements vscode.TreeDataProvider<Dependency> {
	constructor() { }

	getTreeItem(element: Dependency): vscode.TreeItem {
		return element;
	}

	getChildren(element?: Dependency): Thenable<Dependency[]> {
		if (!element) {
			return Promise.resolve([new Dependency()]);
		} else {
			return Promise.resolve([new Dependency()]);
		}
	}
}

const bookmarkProvider = new NodeDependenciesProvider();
const bookmarkView = vscode.window.createTreeView("bugmark.view.bookmarks", { treeDataProvider: bookmarkProvider });
vscode.commands.registerCommand('bugmark.command.markline', () => {
	// The code you place here will be executed every time your command is executed
	// Display a message box to the user
	let editor = vscode.window.activeTextEditor;
	let document = editor.document;
	let cursor = editor.selection.active;
	let file = document.fileName;
	let line = document.lineAt(cursor).lineNumber;
	vscode.window.showInformationMessage(`Bookmark ${line}`);
	//vscode.debug.addBreakpoints
})

//context.subscriptions.push();
export function activate(context: vscode.ExtensionContext) { }
export function deactivate() { }
