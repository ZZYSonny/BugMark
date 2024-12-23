import * as vscode from 'vscode';
import { distance } from 'fastest-levenshtein';
import type { GitExtension, Change as GitChange, Repository as GitRepository } from './git.d.ts';

const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');

const gotoDecoration = vscode.window.createTextEditorDecorationType({
	borderWidth: '1px',
	borderStyle: 'solid'
})
let gotoLocation = [];

interface IRecordProp {
	file: string,
	lineno: number,
	content: string,
	githash: string | undefined | null
}
interface IRecordPropTree {
	[key: string]: IRecordProp | IRecordPropTree
}

async function hasCommit(repo: GitRepository, hash: string) {
	try {
		const commit = await repo.getCommit(hash);
		return commit;
	} catch {
		return undefined;
	}
}

function encodePath(pathstr: string): string {
	const relative = vscode.workspace.getConfiguration("bugmark").get("relative") as boolean;
	if (relative) {
		return vscode.workspace.asRelativePath(pathstr, true);
	} else {
		return pathstr;
	}
}

function decodePath(pathstr: string): vscode.Uri {
	const relative = vscode.workspace.getConfiguration("bugmark").get("relative") as boolean;
	if (relative) {
		const folder = vscode.workspace.workspaceFolders.find(
			f => pathstr.startsWith(f.name)
		);
		if (!folder) {
			return vscode.Uri.file(pathstr);
		}
		return vscode.Uri.joinPath(folder.uri, pathstr.substring(folder.name.length));
	} else {
		return vscode.Uri.file(pathstr);
	}
}

export class RecordProp implements IRecordProp {
	constructor(
		public file: string,
		public lineno: number,
		public content: string,
		public githash: string | undefined | null
	) { }

	static async fromCursor() {
		const editor = vscode.window.activeTextEditor;
		const document = editor.document;
		const cursor = editor.selection.active;
		const line = document.lineAt(cursor);

		let hash = undefined;
		const gitActivated = await gitExtension.activate();
		const gitAPI = gitActivated.getAPI(1);
		const repo = gitAPI.getRepository(document.uri)
		if (repo) {
			hash = repo.state.HEAD.commit;
		}

		return new RecordProp(
			encodePath(document.fileName),
			line.lineNumber,
			line.text,
			hash
		)
	}

	serialize() {
		return this;
	}

	clone() {
		return new RecordProp(this.file, this.lineno, this.content, this.githash);
	}

	static isProp(json: IRecordProp | IRecordPropTree) {
		const requiredKeys = ["file", "lineno", "content"];
		const keys = Object.keys(json);
		return requiredKeys.every(k => keys.includes(k))
	}

	static deserialize(json: IRecordProp) {
		return new RecordProp(
			json.file,
			json.lineno,
			json.content,
			json.githash
		)
	}

	// Breakpoint related ops
	matchBreakpointFile(bp: vscode.Breakpoint): boolean {
		// Match some breakpoint?
		return (
			(bp instanceof vscode.SourceBreakpoint) &&
			(bp.location.uri.path === decodePath(this.file).path)
		);
	}

	// Breakpoint related ops
	matchBreakpointLine(bp: vscode.Breakpoint): boolean {
		// Match some breakpoint?
		return (
			(bp instanceof vscode.SourceBreakpoint) &&
			(bp.location.range.start.line === this.lineno)
		);
	}

	addBreakpoint(): void {
		const bp = new vscode.SourceBreakpoint(
			new vscode.Location(
				decodePath(this.file),
				new vscode.Position(this.lineno, 0)
			)
		);
		vscode.debug.addBreakpoints([bp]);
	}

	removeBreakpoint(): void {
		const bp = vscode.debug.breakpoints.find(
			(b) => this.matchBreakpointFile(b) && this.matchBreakpointLine(b)
		);
		vscode.debug.removeBreakpoints([bp]);
	}

	// Ops require interacting with vscode
	async openTextDocument() {
		return await vscode.workspace.openTextDocument(decodePath(this.file));
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

	async shouldUpdate() {
		const gitActivated = await gitExtension.activate();
		const gitAPI = gitActivated.getAPI(1);
		const uri = decodePath(this.file);
		const repo = gitAPI.getRepository(uri);
		if (!repo) {
			// Always update bugmark entries if no repo is found.
			return true;
		}
		const changes = repo.state.workingTreeChanges;
		for (const change of changes)
			if (change.originalUri.fsPath == uri.fsPath) {
				// Do not update if the file has been modified.
				return false;
			}
		return true;
	}

	async fixFileLocation(changeCache: Map<string, Promise<any>> | undefined = undefined) {
		const oldURI = decodePath(this.file);
		const gitActivated = await gitExtension.activate();
		const gitAPI = gitActivated.getAPI(1);
		const repo = gitAPI.getRepository(oldURI);
		if (repo && await hasCommit(repo, this.githash)) {
			let changes: GitChange[] = undefined;
			if (changeCache) {
				// Cache exists
				const key = this.githash;
				const cached = changeCache.get(key);
				if (cached) {
					// An earlier item has initiated query, wait on the cached promise
					changes = await cached;
				} else {
					// Initialize query and wait
					const query = repo.diffIndexWith(this.githash);
					changeCache.set(key, query);
					changes = await query;
				}
			} else {
				// Cache does not exist.
				changes = await repo.diffIndexWith(this.githash);
			}
			for (const change of changes) {
				if (change.status == 3 && change.originalUri.fsPath == oldURI.fsPath) {
					this.file = encodePath(change.renameUri.fsPath);
					return true;
				}
			}
		}
		return false;
	}

	async fixLineNumber(diffCache: Map<string, Promise<any>> | undefined = undefined) {
		const document = await this.openTextDocument();
		const radius = vscode.workspace.getConfiguration("bugmark").get("searchRadius") as number;
		let lineno = this.lineno;

		const gitActivated = await gitExtension.activate();
		const gitAPI = gitActivated.getAPI(1);
		const repo = gitAPI.getRepository(document.uri);
		if (repo && await hasCommit(repo, this.githash)) {
			let diff: string = undefined;
			if (diffCache) {
				// Cache exists
				const key = this.githash + this.file;
				const cached = diffCache.get(key);
				if (cached) {
					// An earlier item has initiated query, wait on the cached promise
					diff = await cached;
				} else {
					// Initialize query and wait
					const query = repo.diffWith(this.githash, document.uri.fsPath);
					diffCache.set(key, query);
					diff = await query;
				}
			} else {
				// Cache does not exist.
				diff = await repo.diffWith(this.githash, document.uri.fsPath);
			}
			const difflines = diff.split("\n");
			for (let i = 0; i < difflines.length; i++) {
				const hunkHeaderMatch = /^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/.exec(difflines[i]);
				if (hunkHeaderMatch) {
					const startA = parseInt(hunkHeaderMatch[1]);
					const countA = parseInt(hunkHeaderMatch[2] || '1');
					const startB = parseInt(hunkHeaderMatch[3]);
					const countB = parseInt(hunkHeaderMatch[4] || '1');

					if (lineno < startA) {
						// Original line is before this hunk, no more adjustments needed
						break;
					}
					else if (lineno >= startA && lineno < startA + countA) {
						// The original line was changed in this hunk, trace the changes
						// We should find at least `cnt` lines in the original file
						// +1 for hunk being 1-indexed and vscode being 0-indexed
						// +1 so that lineno == startA gives cnt=1
						let cnt = (lineno + 1) - startA + 1;
						// Line number in the current file.
						// -1 for hunk being 1-indexed and vscode being 0-indexed
						// -1 for not incrementing lineno on the last line
						lineno = startB - 2;
						for (let j = i + 1; cnt != 0; j++) {
							if (difflines[j].startsWith("+")) {
								// New Line Added
								lineno++;
							} else if (difflines[j].startsWith("-")) {
								cnt--;
							} else {
								lineno++;
								cnt--;
							}
						}
						break;
					} else {
						// Adjust line for lines added/removed before this line
						lineno += (countB - countA);
					}
				}
			}
		}
		let bestLine = lineno;
		let bestScore = this.content.length;
		for (let i = 0; i < radius; i++) {
			for (const pid of [lineno + i, lineno - i]) {
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
			if (repo) {
				this.githash = repo.state.HEAD.commit;
			}
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

	async getAdaptedProp(): Promise<RecordProp> {
		let prop = this.prop;
		if (!await this.prop.shouldUpdate()) {
			prop = prop.clone();
		}
		await prop.fixFileLocation();
		await prop.fixLineNumber();
		return prop;
	}

	getTreePath() {
		// Get the path from root node to this.
		if (this.parent.parent == null) {
			return this.label.toString();
		} else {
			return this.parent.getTreePath() + "/" + this.label.toString();
		}
	}

	getCheckboxState() {
		// Is this ticked?
		if (this.checkboxState === undefined) {
			return false;
		} else if (this.checkboxState instanceof Object) {
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
	async updateCheckBox(changeCache: Map<string, Promise<any>> | undefined = undefined,
		diffCache: Map<string, Promise<any>> | undefined = undefined) {
		if (this.prop) {
			let matches = false;
			// Current node is a leaf node representing some source location
			// Tick if the line is already a breakpoint
			const filtered0 = vscode.debug.breakpoints;
			if (filtered0.length) {
				const prop = this.prop.clone();
				await prop.fixFileLocation(changeCache);
				const filtered1 = filtered0.filter((bp) => prop.matchBreakpointFile(bp));
				if (filtered1.length) {
					await prop.fixLineNumber(diffCache);
					const filtered2 = filtered1.filter((bp) => prop.matchBreakpointLine(bp));
					matches = filtered2.length > 0;
				}
			}
			this.checkboxState = matches
				? vscode.TreeItemCheckboxState.Checked
				: vscode.TreeItemCheckboxState.Unchecked;
		}
	}

	async forEach(f: (x: RecordItem) => Promise<void>): Promise<void> {
		// Perform forEach for all children nodes
		// And return the LCA of all changed nodes.
		for (const child of this.children) {
			await child.forEach(f);
		}
		await f(this);
	}
}
