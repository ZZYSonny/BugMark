import * as vscode from 'vscode';

type RecursiveMapArray<S, T> = Array<T> | Map<S, RecursiveMapArray<S, T>>
export type RecordJSON = RecursiveMapArray<string, RecordProp>

const gotoDecoration = vscode.window.createTextEditorDecorationType({
	borderWidth: '1px',
	borderStyle: 'solid'
})
let gotoLocation = [];

export class RecordProp {
	constructor(
		public file: string,
		public lineno: number,
		public content: string,
		public commit: string,
		public head: boolean,
		public deleted: boolean
	) { }

	static fromCursor(): RecordProp {
		const editor = vscode.window.activeTextEditor;
		const document = editor.document;
		const cursor = editor.selection.active;
		const line = document.lineAt(cursor);

		return new RecordProp(
			document.fileName,
			line.lineNumber,
			line.text,
			document.getText(line.range),
			true,
			false
		)
	}

	serialize() {
		return this;
	}

	static deserialize(json: any) {
		return new RecordProp(
			json.file,
			json.lineno,
			json.content,
			json.commit,
			json.head,
			json.deleted
		)
	}

	// Breakpoint related ops
	matchBreakpoint(bp: vscode.Breakpoint): boolean {
		// Match some breakpoint?
		return (
			(bp instanceof vscode.SourceBreakpoint) &&
			(bp.location.uri.path === this.file) &&
			(bp.location.range.start.line === this.lineno)
		);
	}

	addBreakpoint(): void {
		const bp = new vscode.SourceBreakpoint(
			new vscode.Location(
				vscode.Uri.file(this.file),
				new vscode.Position(this.lineno, 0)
			)
		);
		vscode.debug.addBreakpoints([bp]);
	}

	removeBreakpoint(): void {
		const bp = vscode.debug.breakpoints.find(
			(b) => this.matchBreakpoint(b)
		);
		vscode.debug.removeBreakpoints([bp]);
	}

	// Ops require interacting with vscode
	async reveal(ms: number) {
		const doc = await vscode.workspace.openTextDocument(this.file);
		const editor = await vscode.window.showTextDocument(doc);
		const range = editor.document.lineAt(this.lineno).range;
		// Select and Reveal
		editor.selection = new vscode.Selection(range.start, range.start);
		editor.revealRange(range);
		// Highlight
		gotoLocation = [range];
		editor.setDecorations(gotoDecoration, gotoLocation);
		// Wait ms
		await new Promise((resolve) => setTimeout(resolve, ms));
		// Stop highlight if current line is still highlighted
		if (gotoLocation[0] == range) {
			editor.setDecorations(gotoDecoration, []);
			gotoLocation = []
		}
	}

	// Edit Ops
	applyEdit(ev: vscode.TextDocumentChangeEvent): boolean{
		const document = ev.document;
		const lineRange = new vscode.Range(
			new vscode.Position(this.lineno, 0),
			new vscode.Position(this.lineno, this.content.length)
		)
		let delta = 0;
		let modified = false;
		for (const change of ev.contentChanges) {
			// Iterate all changes
			if (change.range.contains(lineRange)) {
				// Current line is completely removed
				// Set deleted flag
				// The actual lineno needs to be searched.
				this.deleted = true;
				break;
			} else {
				if (change.range.start.line < this.lineno) {
					// Current line is shifted
					delta -= change.range.end.line - change.range.start.line;
					delta += change.text.split("\n").length - 1;
				}
				if (change.range.end.line <= this.lineno) {
					// Current line is changed
					modified = true;
				}
			}
		}
		if (!this.deleted) {
			this.lineno += delta;
			if (modified) {
				const newLineRange = document.lineAt(this.lineno).range;
				this.content = document.getText(newLineRange);
			}
		}
		return this.deleted || delta != 0 || modified;
	}
}

export class RecordItem extends vscode.TreeItem {
	public parent: RecordItem | null = null;

	constructor(
		public label: string,
		public props: Array<RecordProp> | null = null,
		public children: Array<RecordItem> = []
	) {
		super(label, props ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded);
		this.command = {
			command: "bugmark.view.item.goto",
			title: "Goto file",
			arguments: [this]
		}
		for (const child of children) child.parent = this;
		this.updateCheckBox();
	}

	//Export and Import
	serialize() {
		if (this.props) {
			return this.props.map((x) => x.serialize());
		} else {
			return Object.fromEntries(
				this.children.map((x) => [x.label, x.serialize()])
			)
		}
	}

	static deserialize(name: string, json: any) {
		if (json instanceof Array) {
			const props = json.map(
				(x) => RecordProp.deserialize(x)
			);
			return new RecordItem(name, props);
		}
		if (json instanceof Object) {
			const children = Object.entries(json).map(
				([k, v]) => RecordItem.deserialize(k, v)
			);
			return new RecordItem(name, null, children);
		}
		throw "Unknown Type"
	}

	//Simple Getter
	getChildIDByName(name: string) {
		return this.children.findIndex((x) => x.label === name);
	}

	getHead() {
		// Find the most relevant location history.
		return this.props.find((x) => x.head);
	}

	getFullPath() {
		// Get the path from root node to this.
		if (this.parent.parent == null) {
			return this.label.toString();
		} else {
			return this.parent.getFullPath() + "/" + this.label.toString();
		}
	}

	getCheckboxState() {
		// Is this ticked?
		if (this.checkboxState instanceof Object) {
			return this.checkboxState.state === vscode.TreeItemCheckboxState.Checked;
		} else {
			return this.checkboxState === vscode.TreeItemCheckboxState.Checked;
		}
	}

	// Node Op
	addChildren(item: RecordItem) {
		this.children.push(item);
		this.children = this.children.sort((a, b) => a.label.localeCompare(b.label))
	}

	findDown(path: Array<string>): [number, RecordItem] {
		let id = this.getChildIDByName(path[0]);
		if (id == -1) {
			// Can't find path[0], stop at this node
			// Depth, Node
			return [0, this];
		} else {
			// Found path[0]
			// Go down a level
			let ans = this.children[id].findDown(path.slice(1));
			ans[0] += 1;
			return ans;
		}
	}

	addDown(path: Array<string>, item: RecordItem): void {
		const rec = (i: number) => {
			if (i < path.length) {
				return new RecordItem(path[i], null, [rec(i + 1)]);
			} else {
				return item;
			}
		}
		this.addChildren(rec(0));
	}

	removeFromParent(): void {
		// Find id of this from parent
		const id = this.parent.getChildIDByName(this.label.toString());
		// Remove
		this.parent.children.splice(id, 1);
	}

	// Updater
	updateCheckBox() {
		const oldState = this.getCheckboxState();
		let newState = false;
		if (this.props) {
			// Current node is a leaf node representing some source location
			// Tick if the line is already a breakpoint
			newState = vscode.debug.breakpoints.some(
				(bp) => this.getHead().matchBreakpoint(bp)
			);
		} if (this.children.length > 0) {
			// Current node is a tree node
			// Tick if all children nodes are ticked.
			newState = this.children.every((c) => c.getCheckboxState());
		}
		this.checkboxState = newState
			? vscode.TreeItemCheckboxState.Checked
			: vscode.TreeItemCheckboxState.Unchecked;
		// Return if the state has changed.
		return oldState != newState;
	}

	forEach(f: (x: RecordItem) => boolean): RecordItem | null {
		// Perform forEach for all children nodes
		// And return the LCA of all changed nodes.
		const res = this.children.map((x) => x.forEach(f)).filter(x => x);
		// If current node or multiple children node needs updating
		if (f(this) || res.length > 1) return this;
		// Only one child node needs updating
		else return res[0];
	}
}
