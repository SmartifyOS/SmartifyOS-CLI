import { CliError } from '../../utils/errors.ts';

/**
 * Edits single entries in the top level sections of a `pubspec.yaml`, line by line.
 *
 * Why not parse and write it back: a YAML library would throw away every comment and every
 * blank line in the owner's file, and the owner's file is theirs. Only the lines of the
 * entry being changed are touched, everything else stays exactly as it was, down to the line
 * endings.
 *
 * An entry is a key line at the section's indentation plus every more indented line below
 * it. The comment lines right above an entry belong to it: they are kept when the entry is
 * replaced and removed with it.
 */

/** Where one top level section is, as line numbers. */
interface Section {
	/** The `dependencies:` line. */
	header: number;
	/** One past the last line of the section, trailing blanks and comments left out. */
	end: number;
	/** How far its entries are indented. */
	indent: number;
}

/** Where one entry is, as line numbers. */
interface Entry {
	/** The first comment line above it, or its key line when there is none. */
	commentStart: number;
	start: number;
	end: number;
}

const keyPattern = /^( *)([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(?=\s|$)/;

function isBlank(line: string): boolean {
	return line.trim() === '';
}

function isComment(line: string): boolean {
	return line.trimStart().startsWith('#');
}

function indentOf(line: string): number {
	return line.length - line.trimStart().length;
}

/** Internal: the text as lines, and the line ending to put back between them. */
function split(text: string): { lines: string[]; eol: string } {
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	return { lines: text.split(/\r?\n/), eol };
}

function findSection(lines: string[], key: string): Section | undefined {
	const header = lines.findIndex((line) => keyPattern.exec(line)?.[2] === key && !/^\s/.test(line));
	if (header === -1) return undefined;

	let last = header;
	let indent: number | undefined;
	for (let i = header + 1; i < lines.length; i++) {
		const line = lines[i] ?? '';
		if (isBlank(line)) continue;
		// A comment at the left edge is about whatever top level key comes next.
		if (indentOf(line) === 0) break;
		if (!isComment(line)) indent ??= indentOf(line);
		last = i;
	}

	return { header, end: last + 1, indent: indent ?? 2 };
}

function findEntry(lines: string[], section: Section, name: string): Entry | undefined {
	for (let i = section.header + 1; i < section.end; i++) {
		const line = lines[i] ?? '';
		if (isComment(line) || indentOf(line) !== section.indent) continue;
		if (keyPattern.exec(line)?.[2] !== name) continue;

		let last = i;
		for (let j = i + 1; j < section.end; j++) {
			const next = lines[j] ?? '';
			if (isBlank(next)) continue;
			if (indentOf(next) <= section.indent) break;
			// A deeper comment only belongs to the entry when more of the entry follows it.
			if (!isComment(next)) last = j;
		}

		let commentStart = i;
		while (commentStart - 1 > section.header) {
			const above = lines[commentStart - 1] ?? '';
			if (!isComment(above) || indentOf(above) !== section.indent) break;
			commentStart--;
		}

		return { commentStart, start: i, end: last + 1 };
	}
	return undefined;
}

/**
 * Internal: turns `key: {}`, which is how an empty section is sometimes written, into
 * `key:`, so entries can go under it. Anything else written on the key line itself is a
 * shape this editor does not take apart.
 */
function openSection(lines: string[], section: Section, key: string): void {
	const header = lines[section.header] ?? '';
	const rest = header
		.slice(header.indexOf(':') + 1)
		.replace(/#.*$/, '')
		.trim();
	if (rest === '') return;
	if (rest === '{}' || rest === 'null' || rest === '~') {
		lines[section.header] = `${key}:`;
		return;
	}
	throw new CliError(`The ${key} section of pubspec.yaml is written on one line.`, {
		hint: `Write it as a normal list, one package per line under ${key}:, and try again.`,
	});
}

/**
 * The names of every entry in a section, in the order they are written.
 */
export function entryNames(text: string, key: string): string[] {
	const { lines } = split(text);
	const section = findSection(lines, key);
	if (!section) return [];

	const names: string[] = [];
	for (let i = section.header + 1; i < section.end; i++) {
		const line = lines[i] ?? '';
		if (isComment(line) || indentOf(line) !== section.indent) continue;
		const name = keyPattern.exec(line)?.[2];
		if (name) names.push(name);
	}
	return names;
}

/**
 * One entry's own lines, moved to the left edge, with its comments left out.
 *
 * This is how an override is copied from one pubspec into another without having to
 * understand what is in it.
 */
export function entryLines(text: string, key: string, name: string): string[] | undefined {
	const { lines } = split(text);
	const section = findSection(lines, key);
	if (!section) return undefined;
	const entry = findEntry(lines, section, name);
	if (!entry) return undefined;

	return lines
		.slice(entry.start, entry.end)
		.filter((line) => !isBlank(line) && !isComment(line))
		.map((line) => line.slice(Math.min(section.indent, indentOf(line))));
}

/** The key line of one entry as written, trailing comment and all. */
export function entryKeyLine(text: string, key: string, name: string): string | undefined {
	return entryLines(text, key, name)?.[0];
}

/**
 * Puts an entry into a section, replacing the one of the same name if there is one.
 *
 * `body` is the entry as it would be written at the left edge, for example
 * `['smartify_os_core: any']`. A new entry goes at the end of the section. A missing
 * section is added after the first of `after` that exists, or at the end of the file.
 */
export function setEntry(
	text: string,
	key: string,
	name: string,
	body: string[],
	after: string[] = [],
): string {
	const { lines, eol } = split(text);
	let section = findSection(lines, key);

	if (!section) {
		const anchor = after.map((k) => findSection(lines, k)).find((s) => s !== undefined);
		const at = anchor ? anchor.end : trimmedLength(lines);
		lines.splice(at, 0, '', `${key}:`);
		section = { header: at + 1, end: at + 2, indent: 2 };
	} else {
		openSection(lines, section, key);
	}

	const pad = ' '.repeat(section.indent);
	const indented = body.map((line) => (line === '' ? '' : `${pad}${line}`));
	const entry = findEntry(lines, section, name);

	if (entry) lines.splice(entry.start, entry.end - entry.start, ...indented);
	else lines.splice(section.end, 0, ...indented);

	return lines.join(eol);
}

/**
 * Takes an entry out of a section, with the comments written above it.
 *
 * A section left with nothing in it is taken out too, since pub reads an empty section as
 * a mistake rather than as nothing. Returns the text unchanged when there is no such entry.
 */
export function removeEntry(text: string, key: string, name: string): string {
	const { lines, eol } = split(text);
	const section = findSection(lines, key);
	if (!section) return text;
	const entry = findEntry(lines, section, name);
	if (!entry) return text;

	lines.splice(entry.commentStart, entry.end - entry.commentStart);

	const after = findSection(lines, key);
	if (after && entryNames(lines.join(eol), key).length === 0) {
		let from = after.header;
		// Its blank line goes with it, so no double gap is left where it was.
		if (from > 0 && isBlank(lines[from - 1] ?? '')) from--;
		lines.splice(from, after.end - from);
	}

	return lines.join(eol);
}

/** Internal: the number of lines once the blank ones at the very end are left out. */
function trimmedLength(lines: string[]): number {
	let length = lines.length;
	while (length > 0 && isBlank(lines[length - 1] ?? '')) length--;
	return length;
}

/**
 * A value written the way YAML reads it back as the same string.
 *
 * Quoted only when it has to be, so the result looks like something a person wrote.
 */
export function yamlScalar(value: string): string {
	const needsQuotes =
		value === '' ||
		/^[\s>=<!&*?|{}[\],#%@`"'-]/.test(value) ||
		/:\s|\s#|\s$/.test(value) ||
		/^(true|false|null|yes|no|on|off|~)$/i.test(value);
	return needsQuotes ? JSON.stringify(value) : value;
}
