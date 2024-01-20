import * as vscode from 'vscode';

type RecursiveMapArray<S, T> = Array<T> | Map<S, RecursiveMapArray<S, T>>
export type RecordJSON = RecursiveMapArray<string, RecordProp>

export interface RecordProp {
	file: string
	lineno: number
	content: string
	commit: string
	head: boolean
}

export function getCurProp(): RecordProp {
	const editor = vscode.window.activeTextEditor;
	const document = editor.document;
	const cursor = editor.selection.active;
	const line = document.lineAt(cursor);

	return {
		file: document.fileName,
		lineno: line.lineNumber,
		content: line.text,
		commit: "",
		head: true
	}
}

export class RecordItem extends vscode.TreeItem {
	parent: RecordItem | null
	props: Array<RecordProp> | null = null
	children: Array<RecordItem> = []

	constructor(parent: RecordItem | null, name: string, json: RecordJSON) {
		if (json instanceof Array) {
            // Leaf node
			super(name, vscode.TreeItemCollapsibleState.None);
			this.props = json;
		} else {
            // Tree Node
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

    //Exporter
    serialize() {
		if (this.props) return this.props;
		else return Object.fromEntries(
			this.children.map((x) => [x.label, x.serialize()])
		)
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

	checked() {
        // Is this ticked?
		if (this.checkboxState instanceof Object) {
			return this.checkboxState.state === vscode.TreeItemCheckboxState.Checked;
		} else {
			return this.checkboxState === vscode.TreeItemCheckboxState.Checked;
		}
	}

	matchBreakpoint(bp: vscode.Breakpoint): boolean {
        // Match some breakpoint?
		const head = this.getHead();
		return (
			(bp instanceof vscode.SourceBreakpoint) &&
			(bp.location.uri.path === head.file) &&
			(bp.location.range.start.line === head.lineno)
		);
	}

    // Node Op
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
		if (path.length) {
            // Need to go down and path[0] is not a children
            // Add a tree node representing the "folder"
			const next = new RecordItem(this, path[0], new Map());
			next.addDown(path.slice(1), item);
		} else {
            // Add item to the current node
			item.parent = this;
			this.children.push(item);
		}
	}

	removeFromParent(): void {
        // Find id of this from parent
		const id = this.parent.getChildIDByName(this.label.toString());
        // Remove
		this.parent.children.splice(id, 1);
	}

    // Updater
	updateCheckBox() {
		const oldState = this.checked();
		let newState = false;
		if (this.props) {
            // Current node is a leaf node representing some source location
            // Tick if the line is already a breakpoint
			newState = vscode.debug.breakpoints.some(
				(bp) => this.matchBreakpoint(bp)
			);
		} if (this.children.length > 0) {
            // Current node is a tree node
            // Tick if all children nodes are ticked.
			newState = this.children.every((c) => c.checked());
		}
		this.checkboxState = newState
			? vscode.TreeItemCheckboxState.Checked
			: vscode.TreeItemCheckboxState.Unchecked;
        // Return if the state has changed.
		return oldState != newState;
	}

	forEachAndRefresh(f: (x: RecordItem) => boolean): RecordItem | null {
        // Perform forEach for all children nodes
        // And find nodes that need updating
		const res = this.children.map((x) => x.forEachAndRefresh(f)).filter(x=>x);
        // If current node or multiple children node needs updating
		if (f(this) || res.length > 1) return this;
        // Only one child node needs updating
		else return res[0];
	}

    static gotoLocation = [];
	static gotoDecoration = vscode.window.createTextEditorDecorationType({
		borderWidth: '1px',
		borderStyle: 'solid'
	})
    async revealAndHighlight(ms: number) {
        const head = this.getHead();
        const doc = await vscode.workspace.openTextDocument(head.file);
        const editor = await vscode.window.showTextDocument(doc);
        const range = editor.document.lineAt(head.lineno).range;
        // Select and Reveal
        editor.selection = new vscode.Selection(range.start, range.start);
        editor.revealRange(range);
        // Highlight
        RecordItem.gotoLocation = [range];
        editor.setDecorations(RecordItem.gotoDecoration, RecordItem.gotoLocation);
        // Wait ms
        await new Promise((resolve) => setTimeout(resolve, ms));
        // Stop highlight if current line is still highlighted
        if (RecordItem.gotoLocation[0] == range) {
            editor.setDecorations(RecordItem.gotoDecoration, []);
            RecordItem.gotoLocation = []
        }
    }
}
