import * as vscode from 'vscode';
//const gitExtension = vscode.extensions.getExtension('vscode.git').exports;
//const gitAPI = gitExtension.getAPI(1);

type RecursiveMapArray<S, T> = Array<T> | Map<S, RecursiveMapArray<S, T>>
type RecordJSON = RecursiveMapArray<string, RecordProp>

interface RecordProp {
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

	constructor(parent: RecordItem | null, name: string, json: RecordJSON) {
		if (json instanceof Array) {
			super(name, vscode.TreeItemCollapsibleState.None);
			this.props = json;
		} else {
			super(name, vscode.TreeItemCollapsibleState.Expanded);
			this.children = Array.from(json).map(
				([name, node]) => new RecordItem(this, name, node)
			)
		}
		this.parent = parent;
		this.command = {
			command: "bugmark.view.item.goto",
			title: "Goto file",
			arguments: [this]
		}
		this.updateCheckBox();
	}

	getHead() {
		return this.props.find((x) => x.head);
	}

	matchBreakpoint(bp: vscode.Breakpoint): boolean {
		const head = this.getHead();
		return (
			(bp instanceof vscode.SourceBreakpoint) &&
			(bp.location.uri.path === head.file) &&
			(bp.location.range.start.line === head.lineno)
		);
	}

	toJSON() {
		if (this.props) return this.props;
		else return this.children.map((x) => x.toJSON());
	}

	checked() {
		if (this.checkboxState instanceof Object) {
			return this.checkboxState.state === vscode.TreeItemCheckboxState.Checked;
		} else {
			return this.checkboxState === vscode.TreeItemCheckboxState.Checked;
		}
	}

	updateCheckBox() {
		let checked = false;
		if (this.props) {
			checked = vscode.debug.breakpoints.some(
				(bp) => this.matchBreakpoint(bp)
			);
		} if (this.children.length > 0) {
			checked = this.children.every((c) => c.checked());
		}
		this.checkboxState = checked
			? vscode.TreeItemCheckboxState.Checked
			: vscode.TreeItemCheckboxState.Unchecked;
	}

	forEach(f: (x: RecordItem) => void): void {
		if (this.children.length > 0) {
			this.children.forEach((x) => x.forEach(f))
		}
		f(this);
	}

	getChildIDByName(name: string) {
		return this.children.findIndex((x) => x.label === name);
	}

	findDown(path: Array<string>): [number, RecordItem] {
		let id = this.getChildIDByName(path[0]);
		if (id == -1) {
			return [0, this];
		} else {
			let ans = this.children[id].findDown(path.slice(1));
			ans[0] += 1;
			return ans;
		}
	}

	addDown(path: Array<string>, props: Array<RecordProp>) {
		if (path.length === 1) {
			this.children.push(new RecordItem(this, path[0], props))
		} else {
			const next = new RecordItem(this, path[0], new Map());
			next.addDown(path.slice(1), props);
		}
	}

	removeUp(): RecordItem {
		if (this.parent == null) {
			return this;
		} else if (this.parent.children.length == 1) {
			this.parent.children = [];
			return this.parent.removeUp();
		} else {
			const id = this.parent.getChildIDByName(this.label.toString());
			this.parent.children.splice(id, 1);
			return this;
		}
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

	writeToFile(): void {

	}

	updateCheckBox() {
		this.root.forEach((x) => x.updateCheckBox());
	}

	refresh(node: RecordItem | null) {
		if (node === this.root) node = null;
		this.emitterOnDidChangeTreeData.fire(node);
	}

	addItemWithPath(pathstr: string, props: Array<RecordProp>): void {
		const path = pathstr.split("/");
		let [i, changed] = this.root.findDown(path);
		if (i == path.length) throw `${pathstr} already exists`
		if (changed.props) throw `${path.slice(0, i).join("/")} is not a folder`
		changed.addDown(path.slice(i), props);
		this.refresh(changed.parent);
	}

	removeItem(item: RecordItem) {
		const changed = item.removeUp();
		this.refresh(changed.parent);
	}

	renameItem(item: RecordItem, newpath: string) {
		this.removeItem(item);
		this.addItemWithPath(newpath, item.props)
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
			const props = [getCurProp()];
			const path = await vscode.window.showInputBox({
				title: "Bookmark Name?",
				prompt: "Split with /"
			})
			provider.addItemWithPath(path, props);
		}
	))
	context.subscriptions.push(vscode.commands.registerCommand(
		"bugmark.view.title.refresh", () => {
			provider.loadFromFile();
			provider.refresh(null)
		}
	))
	let gotoDecorationLocation = [];
	const gotoDecoration = vscode.window.createTextEditorDecorationType({
		borderWidth: '1px',
		borderStyle: 'solid'
	})
	context.subscriptions.push(vscode.commands.registerCommand(
		"bugmark.view.item.goto", async (item: RecordItem) => {
			const head = item.getHead();
			const doc = await vscode.workspace.openTextDocument(head.file);
			const editor = await vscode.window.showTextDocument(doc);
			const range = editor.document.lineAt(head.lineno).range;
			// Reveal
			editor.revealRange(range);
			// Highlight line for 1 sec
			gotoDecorationLocation = [range];
			editor.setDecorations(gotoDecoration, gotoDecorationLocation);
			await new Promise((resolve) => setTimeout(resolve, 1000));
			if (gotoDecorationLocation[0] == range) {
				editor.setDecorations(gotoDecoration, []);
				gotoDecorationLocation = []
			}
		}
	))
	context.subscriptions.push(vscode.commands.registerCommand(
		"bugmark.view.item.rename", async (item: RecordItem) => {
			const path = await vscode.window.showInputBox({
				title: "New Bookmark Name?",
				prompt: "Split with /"
			})
			provider.renameItem(item, path);
		}
	))
	context.subscriptions.push(vscode.commands.registerCommand(
		"bugmark.view.item.remove",
		(item: RecordItem) => provider.removeItem(item)
	))
	view.onDidChangeCheckboxState((ev) => {
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
	})
	vscode.debug.onDidChangeBreakpoints((ev) => {
		provider.updateCheckBox();
		provider.refresh(null);
	})
}
export function deactivate() {
	provider = null;
}
