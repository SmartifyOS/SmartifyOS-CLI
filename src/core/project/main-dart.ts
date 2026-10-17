/**
 * Switching an extension on and off in the car's `lib/main.dart`.
 *
 * An extension only runs once the app hands it to `SmartifyOs().init(extensions: [...])`,
 * and that line is Dart the owner wrote, so it is edited with care: only when the one place
 * it goes can be found without doubt, touching nothing but the element and its import. When
 * that place cannot be found, the caller prints the line instead, and nothing is lost.
 */

/** What it takes to switch one extension on. */
export interface ExtensionEntry {
	/** `smartify_os_dashcam`. */
	packageName: string;
	/** The library to import, relative to the package's `lib`: `dashcam.dart`. */
	library: string;
	/** `DashcamExtension`. */
	className: string;
	/** Whether its constructor can be called as `const DashcamExtension()`. */
	isConst: boolean;
}

/** The import line for an extension. */
export function importLine(entry: ExtensionEntry): string {
	return `import 'package:${entry.packageName}/${entry.library}';`;
}

/** The element that goes in the `extensions` list. */
export function constructorCall(entry: ExtensionEntry): string {
	return `${entry.isConst ? 'const ' : ''}${entry.className}()`;
}

/**
 * Internal: a copy of the source in which comments and strings are blanked out with spaces,
 * or only the comments with `keepStrings`.
 *
 * Positions stay the same, so anything found in the copy can be cut out of the original.
 * It is what stops `extensions: [` inside a comment from being taken for the real one.
 */
export function codeOnly(source: string, { keepStrings = false } = {}): string {
	const out = source.split('');
	let i = 0;

	const blank = (from: number, to: number) => {
		for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
	};

	while (i < source.length) {
		const rest = source.slice(i, i + 3);

		if (rest.startsWith('//')) {
			const end = source.indexOf('\n', i);
			const stop = end === -1 ? source.length : end;
			blank(i, stop);
			i = stop;
			continue;
		}

		if (rest.startsWith('/*')) {
			const end = source.indexOf('*/', i + 2);
			const stop = end === -1 ? source.length : end + 2;
			blank(i, stop);
			i = stop;
			continue;
		}

		const raw = source[i] === 'r' && (source[i + 1] === "'" || source[i + 1] === '"');
		const quoteAt = raw ? i + 1 : i;
		const quote = source[quoteAt];
		if (quote === "'" || quote === '"') {
			const triple = source.slice(quoteAt, quoteAt + 3) === quote.repeat(3);
			const closing = triple ? quote.repeat(3) : quote;
			let k = quoteAt + closing.length;
			while (k < source.length) {
				if (!raw && source[k] === '\\') {
					k += 2;
					continue;
				}
				if (source.startsWith(closing, k)) break;
				if (!triple && source[k] === '\n') break;
				k++;
			}
			const stop = Math.min(source.length, k + closing.length);
			// The quotes are kept so the shape of the code is still readable.
			if (!keepStrings) blank(quoteAt + closing.length, k);
			i = stop;
			continue;
		}

		i++;
	}

	return out.join('');
}

/** The index of the bracket that closes the one at `open`, in code only text. */
export function closingBracket(code: string, open: number): number {
	const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
	const stack: string[] = [];
	for (let i = open; i < code.length; i++) {
		const char = code[i] ?? '';
		if (pairs[char]) stack.push(pairs[char]);
		else if (char === stack[stack.length - 1]) {
			stack.pop();
			if (stack.length === 0) return i;
		}
	}
	return -1;
}

/** Internal: where each element of a bracketed list starts and ends, commas left out. */
function elements(code: string, open: number, close: number): { start: number; end: number }[] {
	const found: { start: number; end: number }[] = [];
	let depth = 0;
	let start = open + 1;

	const push = (end: number) => {
		const text = code.slice(start, end);
		const lead = text.length - text.trimStart().length;
		const trimmed = text.trim();
		if (trimmed) found.push({ start: start + lead, end: start + lead + trimmed.length });
	};

	for (let i = open + 1; i < close; i++) {
		const char = code[i];
		if (char === '(' || char === '[' || char === '{') depth++;
		else if (char === ')' || char === ']' || char === '}') depth--;
		else if (char === ',' && depth === 0) {
			push(i);
			start = i + 1;
		}
	}
	push(close);
	return found;
}

/** Exactly one match of `pattern` in the code, or nothing when there are none or several. */
export function onlyMatch(code: string, pattern: RegExp): RegExpExecArray | undefined {
	const all = [...code.matchAll(new RegExp(pattern.source, 'g'))];
	return all.length === 1 ? all[0] : undefined;
}

function lineStart(text: string, index: number): number {
	return text.lastIndexOf('\n', index - 1) + 1;
}

function indentAt(text: string, index: number): string {
	const start = lineStart(text, index);
	return /^[ \t]*/.exec(text.slice(start))?.[0] ?? '';
}

/**
 * Puts a new element at the end of a bracketed list, in the list's own style.
 *
 * A list over several lines gets a line of its own at the indentation of the others, a list
 * on one line gets `, element` at the end, and an empty one gets just the element. An
 * argument list works the same way.
 */
export function appendElement(source: string, code: string, open: number, element: string): string {
	const close = closingBracket(code, open);
	const items = elements(code, open, close);
	const last = items[items.length - 1];

	if (!last) return `${source.slice(0, open + 1)}${element}${source.slice(close)}`;

	const afterLast = code.slice(last.end, close);
	const hasTrailingComma = afterLast.trimStart().startsWith(',');
	const multiline = code.slice(open, close).includes('\n');

	if (multiline && code.slice(lineStart(code, close), close).trim() === '') {
		const indent = indentAt(source, last.start);
		const at = lineStart(source, close);
		const comma = hasTrailingComma ? '' : ',';
		const withComma = `${source.slice(0, last.end)}${comma}${source.slice(last.end, at)}`;
		return `${withComma}${indent}${element},\n${source.slice(at)}`;
	}

	if (hasTrailingComma) {
		const commaAt = last.end + afterLast.indexOf(',');
		return `${source.slice(0, commaAt + 1)} ${element},${source.slice(commaAt + 1)}`;
	}
	return `${source.slice(0, last.end)}, ${element}${source.slice(last.end)}`;
}

/**
 * Sets one named argument of a call: replaces its value when it is there, adds it when it
 * is not.
 *
 * `call` matches the call up to and including its `(`, and has to match exactly once
 * outside comments and strings. A new argument goes on lines of its own in front of the
 * `before` argument, under `comment` and above that argument's own comment, or at the end
 * when there is no such argument.
 *
 * Gives back undefined when the call cannot be found without doubt.
 */
export function setArgument(
	source: string,
	call: RegExp,
	name: string,
	value: string,
	options: { before?: string; comment?: string[] } = {},
): string | undefined {
	const code = codeOnly(source);
	const match = onlyMatch(code, call);
	if (!match) return undefined;
	const open = match.index + match[0].length - 1;
	const close = closingBracket(code, open);
	if (close === -1) return undefined;

	const items = elements(code, open, close);
	const named = (argument: string) =>
		items.find((item) => new RegExp(`^${argument}\\s*:`).test(code.slice(item.start, item.end)));

	const existing = named(name);
	if (existing) {
		return `${source.slice(0, existing.start)}${name}: ${value}${source.slice(existing.end)}`;
	}

	const uncommented = uncomment(source, code, open, close, name, value);
	if (uncommented !== undefined) return uncommented;

	const anchor = options.before ? named(options.before) : undefined;
	if (anchor && code.slice(lineStart(code, anchor.start), anchor.start).trim() === '') {
		// Above the comment that belongs to the argument it goes in front of.
		let at = lineStart(source, anchor.start);
		while (at > 0) {
			const above = lineStart(source, at - 1);
			if (!source.slice(above, at).trim().startsWith('//')) break;
			at = above;
		}
		const indent = indentAt(source, anchor.start);
		const lines = [...(options.comment ?? []).map((line) => `// ${line}`), `${name}: ${value},`];
		return `${source.slice(0, at)}${lines.map((line) => `${indent}${line}\n`).join('')}\n${source.slice(at)}`;
	}

	return appendElement(source, code, open, `${name}: ${value}`);
}

/**
 * Internal: an example of the argument the owner left commented out inside the call, like
 * `// look: CarLook.drawing2D,`, replaced by the real one. Only when there is exactly one such
 * line and everything above it ends with a comma, so the result is the call as the owner
 * would have written it by taking the slashes away.
 */
function uncomment(
	source: string,
	code: string,
	open: number,
	close: number,
	name: string,
	value: string,
): string | undefined {
	const pattern = new RegExp(`^([ \\t]*)//[ \\t]*${name}[ \\t]*:.*$`, 'gm');
	const inside = source.slice(open + 1, close);
	const found = [...inside.matchAll(pattern)];
	const line = found[0];
	if (found.length !== 1 || !line || line.index === undefined) return undefined;
	const start = open + 1 + line.index;
	const before = code.slice(open + 1, start).trimEnd();
	if (before && !before.endsWith(',')) return undefined;
	const end = start + line[0].length;
	return `${source.slice(0, start)}${line[1]}${name}: ${value},${source.slice(end)}`;
}

/**
 * Internal: the named arguments of the one call `call` matches, or undefined when the call
 * cannot be found without doubt.
 */
function callArguments(
	source: string,
	call: RegExp,
):
	| { code: string; open: number; close: number; named: (name: string) => Span | undefined }
	| undefined {
	const code = codeOnly(source);
	const match = onlyMatch(code, call);
	if (!match) return undefined;
	const open = match.index + match[0].length - 1;
	const close = closingBracket(code, open);
	if (close === -1) return undefined;
	const items = elements(code, open, close);
	const named = (name: string) =>
		items.find((item) => new RegExp(`^${name}\\s*:`).test(code.slice(item.start, item.end)));
	return { code, open, close, named };
}

/** Internal: where something starts and ends in the source. */
interface Span {
	start: number;
	end: number;
}

/**
 * The value of one named argument of a call, as it is written (`Layouts.split`, `'Miata'`),
 * comments left out.
 *
 * Gives back null when the call is there without it, and undefined when the call cannot be
 * found without doubt.
 */
export function argumentValue(
	source: string,
	call: RegExp,
	name: string,
): string | null | undefined {
	const found = callArguments(source, call);
	if (!found) return undefined;
	const item = found.named(name);
	if (!item) return null;
	const text = codeOnly(source.slice(item.start, item.end), { keepStrings: true });
	return text
		.slice(text.indexOf(':') + 1)
		.replace(/[ \t]+$/gm, '')
		.trim();
}

/**
 * Takes one named argument out of a call, with its comma, and when it stood on lines of its
 * own those lines and the comment right above them, which is about it.
 *
 * Gives back the source unchanged when the call is there without it, and undefined when the
 * call cannot be found without doubt.
 */
export function removeArgument(source: string, call: RegExp, name: string): string | undefined {
	const found = callArguments(source, call);
	if (!found) return undefined;
	const { code, close } = found;
	const item = found.named(name);
	if (!item) return source;

	let from = item.start;
	let to = item.end;
	const comma = /^\s*,/.exec(code.slice(to, close));
	if (comma) to += comma[0].length;

	const ownLines =
		code.slice(lineStart(code, from), from).trim() === '' && /^[ \t]*(\n|$)/.test(code.slice(to));
	if (ownLines) {
		from = lineStart(source, from);
		while (from > 0) {
			const above = lineStart(source, from - 1);
			if (!source.slice(above, from).trim().startsWith('//')) break;
			from = above;
		}
		// A blank line that set it apart from the one before goes too.
		const newline = source.indexOf('\n', to);
		to = newline === -1 ? source.length : newline + 1;
		if (from > 0) {
			const above = lineStart(source, from - 1);
			if (
				source.slice(above, from).trim() === '' &&
				source.slice(to, source.indexOf('\n', to) + 1).trim() === ''
			) {
				from = above;
			}
		}
		return `${source.slice(0, from)}${source.slice(to)}`;
	}

	if (!comma) {
		// The last one on a line: the comma to take is the one in front of it.
		const before = code.slice(0, from).trimEnd();
		if (before.endsWith(',')) from = before.length - 1;
	} else {
		to += (/^[ \t]*/.exec(code.slice(to))?.[0] ?? '').length;
	}
	return `${source.slice(0, from)}${source.slice(to)}`;
}

/** Adds the import, in order among the other package imports, unless it is already there. */
function addImport(source: string, entry: ExtensionEntry): string {
	return addImportLine(source, importLine(entry));
}

/** Adds an import line, in order among the other package imports, unless it is already there. */
export function addImportLine(source: string, line: string): string {
	if (source.includes(line)) return source;

	const lines = source.split('\n');
	const imports = lines
		.map((text, index) => ({ text: text.trim(), index }))
		.filter(({ text }) => text.startsWith('import '));

	const after = imports.find(({ text }) => text.startsWith("import 'package:") && text > line);
	if (after) lines.splice(after.index, 0, line);
	else if (imports.length > 0) lines.splice((imports[imports.length - 1]?.index ?? 0) + 1, 0, line);
	else lines.unshift(line, '');

	return lines.join('\n');
}

/** Internal: whether a list element is a call to this extension's constructor. */
function isEntryElement(text: string, entry: ExtensionEntry): boolean {
	return new RegExp(`^(const\\s+)?${entry.className}\\s*[(.<]`).test(text.trim());
}

/**
 * Whether the app hands this extension to `SmartifyOs().init` already.
 */
export function isSwitchedOn(source: string, entry: ExtensionEntry): boolean {
	const code = codeOnly(source);
	return new RegExp(`\\b${entry.className}\\s*[(.<]`).test(code);
}

/**
 * Switches an extension on: its element in `extensions: [...]`, and its import.
 *
 * Gives back undefined when there is no one clear place for it: no `SmartifyOs().init(`,
 * or more than one `extensions:` list. Gives back the source unchanged when it is on already.
 */
export function switchOn(source: string, entry: ExtensionEntry): string | undefined {
	if (isSwitchedOn(source, entry)) return source;

	const code = codeOnly(source);
	const element = constructorCall(entry);
	const list = onlyMatch(code, /\bextensions\s*:\s*\[/);

	let edited: string;
	if (list) {
		edited = appendElement(source, code, list.index + list[0].length - 1, element);
	} else {
		if (/\bextensions\s*:/.test(code)) return undefined;
		const init = onlyMatch(code, /\bSmartifyOs\s*\(\s*\)\s*\.\s*init\s*\(/);
		if (!init) return undefined;
		edited = appendElement(
			source,
			code,
			init.index + init[0].length - 1,
			`extensions: [${element}]`,
		);
	}

	return addImport(edited, entry);
}

/**
 * Takes the first element `matches` accepts out of the bracketed list that opens at `open`,
 * with its comma, and the whole line when it stood on one of its own. Gives back the source
 * unchanged when no element matches.
 */
export function removeElement(
	source: string,
	code: string,
	open: number,
	matches: (text: string) => boolean,
): string {
	const close = closingBracket(code, open);
	const items = elements(code, open, close);
	const index = items.findIndex((item) => matches(code.slice(item.start, item.end)));
	const item = items[index];
	if (!item) return source;

	let from = item.start;
	let to = item.end;
	const after = code.slice(to, close);
	const comma = /^\s*,/.exec(after);
	if (comma) to += comma[0].length;

	const ownLine =
		code.slice(lineStart(code, from), from).trim() === '' && /^[ \t]*(\n|$)/.test(code.slice(to));
	if (ownLine) {
		from = lineStart(source, from);
		const newline = source.indexOf('\n', to);
		to = newline === -1 ? source.length : newline + 1;
	} else if (!comma && index > 0) {
		// The last one on a single line: the comma to take is the one in front of it.
		const previous = items[index - 1];
		if (previous) from = previous.end;
	} else if (comma) {
		to += (/^[ \t]*/.exec(code.slice(to))?.[0] ?? '').length;
	}

	return `${source.slice(0, from)}${source.slice(to)}`;
}

/**
 * Switches an extension off: takes its element out of `extensions: [...]`, and every import
 * of its package.
 *
 * Gives back undefined when its element is somewhere this cannot take it out of cleanly,
 * and the source unchanged when it was never there.
 */
export function switchOff(source: string, entry: ExtensionEntry): string | undefined {
	let result = source;
	const code = codeOnly(source);
	const list = onlyMatch(code, /\bextensions\s*:\s*\[/);

	if (list) {
		const open = list.index + list[0].length - 1;
		result = removeElement(source, code, open, (text) => isEntryElement(text, entry));
	}

	const importPattern = new RegExp(
		`^[ \\t]*import\\s+['"]package:${entry.packageName}/[^'"]*['"][^;]*;[ \\t]*\\r?\\n`,
		'gm',
	);
	result = result.replace(importPattern, '');

	return isSwitchedOn(result, entry) ? undefined : result;
}

/**
 * What happened to `lib/main.dart`: switched, it was that way already, it has to be done by
 * hand, or the extension's class could not be found to begin with.
 */
export type SwitchResult =
	| { kind: 'done' | 'already' | 'manual'; entry: ExtensionEntry }
	| { kind: 'unknown' };

/** Switches an extension on in the app's `lib/main.dart`, when it can be done safely. */
export async function switchOnInFile(
	path: string,
	entry: ExtensionEntry | undefined,
): Promise<SwitchResult> {
	if (!entry) return { kind: 'unknown' };
	const file = Bun.file(path);
	if (!(await file.exists())) return { kind: 'manual', entry };

	const source = await file.text();
	if (isSwitchedOn(source, entry)) return { kind: 'already', entry };
	const edited = switchOn(source, entry);
	if (edited === undefined) return { kind: 'manual', entry };

	await Bun.write(path, edited);
	return { kind: 'done', entry };
}

/** Switches an extension off in the app's `lib/main.dart`, when it can be done safely. */
export async function switchOffInFile(
	path: string,
	entry: ExtensionEntry | undefined,
): Promise<SwitchResult> {
	if (!entry) return { kind: 'unknown' };
	const file = Bun.file(path);
	if (!(await file.exists())) return { kind: 'already', entry };

	const source = await file.text();
	const importsIt = source.includes(`package:${entry.packageName}/`);
	if (!isSwitchedOn(source, entry) && !importsIt) return { kind: 'already', entry };
	const edited = switchOff(source, entry);
	if (edited === undefined) return { kind: 'manual', entry };

	await Bun.write(path, edited);
	return { kind: 'done', entry };
}
