import * as vscode from 'vscode';
import { distance } from 'fastest-levenshtein';

const gotoDecoration = vscode.window.createTextEditorDecorationType({
	borderWidth: '1px',
	borderStyle: 'solid'
})
let gotoLocation = [];

interface IRecordProp {
	file: string,
	lineno: number,
	content: string,
	deleted: boolean
}
interface IRecordPropTree {
	[key:string]: IRecordProp | IRecordPropTree
}

export class RecordProp implements IRecordProp {
	constructor(
		public file: string,
		public lineno: number,
		public content: string,
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
			false
		)
	}

	serialize() {
		return this;
	}

	static isProp(json: IRecordProp | IRecordPropTree) {
		const requiredKeys = ["file", "lineno", "content", "deleted"];
		const keys = Object.keys(json);
		return keys.length === requiredKeys.length && requiredKeys.every(k => keys.includes(k));
	}

	static deserialize(json: IRecordProp) {
		return new RecordProp(
			json.file,
			json.lineno,
			json.content,
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
	async openTextDocument() {
		return await vscode.workspace.openTextDocument(this.file);
	}

	async reveal(doc: vscode.TextDocument, ms: number) {
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
	applyEdit(ev: vscode.TextDocumentChangeEvent): boolean {
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
				const editBeforeLine = change.range.start.line < this.lineno;
				const prependEnter = change.range.start.line === this.lineno && change.range.end.line === this.lineno && change.range.end.character === 0
				console.log(this.content, editBeforeLine, prependEnter);
				if ( editBeforeLine || prependEnter) {
					// Current line is shifted
					delta -= change.range.end.line - change.range.start.line;
					delta += change.text.split("\n").length - 1;
				}
				const modifiedLineStart = change.range.end.line <= this.lineno;
				const modifiedLineOrLineEnd = change.range.start.line >= this.lineno;
				if (modifiedLineStart || modifiedLineOrLineEnd) {
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

	applyRename(ev: vscode.FileRenameEvent): boolean {
		for(const pair of ev.files){
			if(this.file === pair.oldUri.path) {
				this.file = pair.newUri.path;
				return true;
			}
		}
		return false;
	}

	checkValidity(document: vscode.TextDocument) {
		if (!this.deleted) {
			let newContent = "";
			try {
				newContent = document.lineAt(this.lineno).text;
			} catch {
				this.deleted = true;
				return;
			}
			this.deleted = this.content != newContent;
		}
	}

	fixLineNumber(document: vscode.TextDocument) {
		let radius = vscode.workspace.getConfiguration().get("bugmark.searchRadius") as number;
		let bestLine = this.lineno;
		let bestScore = this.content.length;
		for (let i = 0; i < radius; i++) {
			for (const pid of [this.lineno + i, this.lineno - i]) {
				if (pid >= 0 && pid < document.lineCount) {
					const line = document.lineAt(pid).text;
					const score = distance(this.content, line);
					if (score < bestScore) {
						bestLine = pid;
						bestScore = score;
					}
				}
			}
		}
		if (bestScore < this.content.length) {
			this.lineno = bestLine;
			this.content = document.lineAt(this.lineno).text;
			this.deleted = false;
			return true;
		}
		return false;
	}
}

export class RecordItem extends vscode.TreeItem {
	public parent: RecordItem | null = null;

	constructor(
		public label: string,
		public prop: RecordProp | null = null,
		public children: Array<RecordItem> = []
	) {
		super(label, prop ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded);
		this.command = {
			command: "bugmark.view.item.goto",
			title: "Goto file",
			arguments: [this]
		}
		for (const child of children) child.parent = this;
		this.updateCheckBox();
	}

	//Export and Import
	serialize(): IRecordProp | IRecordPropTree {
		if (this.prop) {
			return this.prop.serialize();
		} else {
			return Object.fromEntries(
				this.children.map((x) => [x.label, x.serialize()])
			)
		}
	}

	static deserialize(name: string, json: RecordProp | IRecordPropTree) {
		if (RecordProp.isProp(json)) {
			const props = RecordProp.deserialize(json as RecordProp);
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

	getHeadWithCorrection(document: vscode.TextDocument): [boolean, RecordProp] {
		const head = this.prop;
		head.checkValidity(document);
		if (head.deleted) {
			const changed = head.fixLineNumber(document);
			return [changed, head];
		}
		return [false, head];
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
		item.parent = this;
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
		if (this.prop) {
			// Current node is a leaf node representing some source location
			// Tick if the line is already a breakpoint
			newState = vscode.debug.breakpoints.some(
				(bp) => this.prop.matchBreakpoint(bp)
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
		else if(res.length == 1) return res[0];
		else return null;
	}
}
