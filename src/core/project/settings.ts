import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError } from '../../utils/errors.ts';
import { dartStringValue } from './appearance.ts';
import { dartString } from './create.ts';
import { formatDart, writeDart } from './dart-file.ts';
import {
	addImportLine,
	appendElement,
	argumentValue,
	closingBracket,
	codeOnly,
	elements,
	onlyMatch,
	removeArgument,
	removeElement,
	setArgument,
} from './main-dart.ts';
import {
	type PartNames,
	packageName,
	partNames,
	type RegisterSpec,
	registerIn,
	unregisterIn,
} from './parts.ts';

/**
 * The car's own settings pages, each a file in `lib/settings/` that the CLI writes and the
 * owner can change too: a `SettingsPage` handed to SmartifyOS in `lib/main.dart`, with its rows
 * in its `entries` list.
 *
 * The CLI changes a page one row at a time, by the shape it writes rows in, so everything else
 * in the file (and in a row) is left as it is. A row it cannot read is still listed, as code.
 * A switch or a choice can remember its value between drives, with a `SavedValue` declared in
 * the same file that the rest of the app can read, and can run a function of the owner's, which
 * starts as a stub further down the file.
 */

/** Where pages are handed to SmartifyOS: `SettingsConfig(pages: [...])`. */
export const settingsRegister: RegisterSpec = {
	argument: 'settings',
	config: 'SettingsConfig',
	list: 'pages',
	import: "import 'package:smartify_os_core/settings.dart';",
	comment: 'Settings pages of your own.',
};

/** The folder pages go in, inside the app. */
export const settingsFolder = 'lib/settings';

/**
 * The pages SmartifyOS ships that a page of the car's own can go in, a copy of `SettingsPages`
 * in core. The running app knows every page, the ones extensions add too.
 */
export const builtInPages: { id: string; constant: string; title: string }[] = [
	{ id: 'root', constant: 'root', title: 'Settings itself' },
	{ id: 'connectivity', constant: 'connectivity', title: 'Connectivity' },
	{ id: 'bluetooth', constant: 'bluetooth', title: 'Bluetooth' },
	{ id: 'wifi', constant: 'wifi', title: 'Wi-Fi' },
	{ id: 'mobile_data', constant: 'mobileData', title: 'Mobile data' },
	{ id: 'sound', constant: 'sound', title: 'Sound' },
	{ id: 'display', constant: 'display', title: 'Display' },
	{ id: 'appearance', constant: 'appearance', title: 'Appearance' },
	{ id: 'vehicle', constant: 'vehicle', title: 'Vehicle' },
	{ id: 'vehicle.can_devices', constant: 'canDevices', title: 'CAN bus devices' },
	{ id: 'date_time', constant: 'dateTime', title: 'Date & time' },
	{ id: 'language', constant: 'language', title: 'Language' },
	{ id: 'system', constant: 'system', title: 'System' },
	{ id: 'developer', constant: 'developer', title: 'Developer options' },
	{ id: 'about', constant: 'about', title: 'About' },
];

/** The kinds of rows the CLI writes. */
export type RowKind = 'toggle' | 'choice' | 'action' | 'info';

export const rowKinds: RowKind[] = ['toggle', 'choice', 'action', 'info'];

/** A row's value kept between drives. */
export interface RowSaved {
	/** Its name in Dart, which the rest of the app reads it by: `seatHeatingDriverSeat`. */
	name: string;
	/** Its key, `seat_heating.driver_seat`. */
	key: string | null;
	/** What it is until the driver changes it, null when it is not a plain value. */
	default: boolean | number | string | null;
}

/** The function a row runs, written by the owner. */
export interface RowCode {
	/** `_driverSeatChanged`. */
	name: string;
	/** Where its body starts, counted from 1. */
	line: number;
	/** Whether the owner wrote something in it, rather than the stub it started as. */
	written: boolean;
}

/** One row of a page, as the CLI reads it. */
export interface SettingsRow {
	/** Its id, unique on its page: `driver_seat`. Null for a row without one. */
	id: string | null;
	/** Null for a row the CLI does not write, which is changed in the code. */
	kind: RowKind | null;
	title: string | null;
	subtitle: string | null;
	section: string | null;
	/** Its name in Flutter's `Icons`, null when it has none or something else. */
	icon: string | null;
	/** A switch or choice: the value it remembers between drives. */
	saved: RowSaved | null;
	/** What it runs: on a switch or choice when it changes, on a button when tapped. */
	code: RowCode | null;
	/** A choice: what can be picked. */
	options: { value: string; label: string }[];
	/** Information: what it shows. */
	value: string | null;
	/** Where it is written, counted from 1. */
	line: number;
}

/** One page of the car's own, as the CLI reads it. */
export interface SettingsPageInfo {
	id: string | null;
	title: string | null;
	subtitle: string | null;
	icon: string | null;
	/** The page it goes in, by id. Null when it is written as code. */
	parent: string | null;
	/** Relative to the app: `lib/settings/seat_heating_page.dart`. */
	file: string;
	/** What `lib/main.dart` hands to SmartifyOS: `seatHeatingPage`. */
	symbol: string | null;
	registered: boolean;
	rows: SettingsRow[];
	/** Where its rows are, counted from 1. */
	line: number;
}

const pageCall = /\bSettingsPage\s*\(/;

/** Internal: the line `index` is on, counted from 1. */
function lineAt(source: string, index: number): number {
	return source.slice(0, index).split('\n').length;
}

/** Internal: a literal as JSON, or undefined when it is not one. */
function literal(code: string | null | undefined): boolean | number | string | undefined {
	if (!code) return undefined;
	const text = code.trim();
	if (text === 'true' || text === 'false') return text === 'true';
	if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
	return dartStringValue(text);
}

/** Internal: a value as a Dart literal. Numbers are kept as written, `1.0` stays a double. */
function dartLiteral(value: boolean | number | string): string {
	if (typeof value === 'string') return dartString(value);
	return String(value);
}

/** Internal: `Icon(Icons.x)` as `x`. */
function iconName(code: string | null | undefined): string | null {
	return /^(?:const\s+)?Icon\(\s*Icons\.([a-z0-9_]+)\s*\)$/.exec(code?.trim() ?? '')?.[1] ?? null;
}

/** Internal: every `SavedValue` declared at the top level, by name. */
function savedDeclarations(source: string): Map<string, RowSaved> {
	const code = codeOnly(source);
	const found = new Map<string, RowSaved>();
	for (const match of code.matchAll(
		/\bconst\s+([A-Za-z_]\w*)\s*=\s*SavedValue\s*(?:<[^>()]*>)?\s*\(/g,
	)) {
		const name = match[1] ?? '';
		const open = (match.index ?? 0) + match[0].length - 1;
		const close = closingBracket(code, open);
		const [first] = elements(code, open, close);
		const key = first ? (dartStringValue(source.slice(first.start, first.end)) ?? null) : null;
		const call = new RegExp(`\\bconst\\s+${name}\\s*=\\s*SavedValue\\s*(?:<[^>()]*>)?\\s*\\(`);
		const value = literal(argumentValue(source, call, 'defaultValue'));
		found.set(name, { name, key, default: value ?? null });
	}
	return found;
}

/** Internal: every private top level function, with where its body is. */
function functions(source: string): Map<string, RowCode & { start: number; end: number }> {
	const code = codeOnly(source);
	const found = new Map<string, RowCode & { start: number; end: number }>();
	for (const match of code.matchAll(/^void\s+(_\w+)\s*\(/gm)) {
		const name = match[1] ?? '';
		const params = (match.index ?? 0) + match[0].length - 1;
		const bodyOpen = code.indexOf('{', closingBracket(code, params));
		const bodyClose = closingBracket(code, bodyOpen);
		if (bodyOpen === -1 || bodyClose === -1) continue;
		const body = code.slice(bodyOpen, bodyClose + 1);
		// The stub prints that it ran, and nothing else.
		const written = !/^\{\s*debugPrint\([^;]*\);\s*\}$/.test(body);
		// The whole function, with the comment above it.
		let start = code.lastIndexOf('\n', match.index ?? 0) + 1;
		while (start > 0) {
			const above = code.lastIndexOf('\n', start - 2) + 1;
			if (!source.slice(above, start).trim().startsWith('///')) break;
			start = above;
		}
		found.set(name, {
			name,
			line: lineAt(source, bodyOpen) + 1,
			written,
			start,
			end: bodyClose + 1,
		});
	}
	return found;
}

/** Internal: the call a row's arguments are in. */
function rowCall(kind: RowKind): RegExp {
	return new RegExp(`\\bSettingsEntry\\s*\\.\\s*${kind}\\s*(?:<[^>()]*>)?\\s*\\(`);
}

/** Internal: the argument a row's code goes in. */
const codeArgument: Record<RowKind, string | null> = {
	toggle: 'onChanged',
	choice: 'onSelected',
	action: 'onTap',
	info: null,
};

/** Reads one row, from its text in the page. */
function readRow(source: string, start: number, end: number): SettingsRow {
	const text = source.slice(start, end);
	const kindName = /^(?:const\s+)?SettingsEntry\s*\.\s*(toggle|choice|action|info)\b/.exec(
		codeOnly(text).trim(),
	)?.[1] as RowKind | undefined;
	const row: SettingsRow = {
		id: null,
		kind: kindName ?? null,
		title: null,
		subtitle: null,
		section: null,
		icon: null,
		saved: null,
		code: null,
		options: [],
		value: null,
		line: lineAt(source, start),
	};
	if (!kindName) return row;

	const get = (name: string) => argumentValue(text, rowCall(kindName), name);
	const text_ = (name: string) => dartStringValue(get(name) ?? '') ?? null;
	row.id = text_('id');
	row.title = text_('title');
	row.subtitle = text_('subtitle');
	row.section = text_('section');
	row.icon = iconName(get('icon'));
	row.value = kindName === 'info' ? text_('value') : null;

	const savedName = get('saved');
	if (savedName && /^[A-Za-z_]\w*$/.test(savedName)) {
		row.saved = savedDeclarations(source).get(savedName) ?? {
			name: savedName,
			key: null,
			default: null,
		};
	}
	const argument = codeArgument[kindName];
	const codeName = argument ? get(argument) : null;
	if (codeName && /^_\w+$/.test(codeName)) {
		const found = functions(source).get(codeName);
		row.code = found ? { name: found.name, line: found.line, written: found.written } : null;
	}
	if (kindName === 'choice') {
		for (const match of (get('options') ?? '').matchAll(
			/SettingsChoice\s*(?:<[^>()]*>)?\s*\(\s*(r?'(?:\\.|[^'])*'|r?"(?:\\.|[^"])*")\s*,\s*(r?'(?:\\.|[^'])*'|r?"(?:\\.|[^"])*")/g,
		)) {
			const value = dartStringValue(match[1] ?? '');
			const label = dartStringValue(match[2] ?? '');
			if (value !== undefined && label !== undefined) row.options.push({ value, label });
		}
	}
	return row;
}

/** Internal: the `entries` list of the page, and its rows. */
function entriesOf(
	source: string,
): { open: number; rows: { start: number; end: number }[] } | undefined {
	const code = codeOnly(source);
	const call = onlyMatch(code, pageCall);
	if (!call) return undefined;
	const open = call.index + call[0].length - 1;
	const close = closingBracket(code, open);
	const list = /\bentries\s*:\s*(?:const\s+)?\[/.exec(code.slice(open, close));
	if (!list) return undefined;
	const listOpen = open + list.index + list[0].length - 1;
	return { open: listOpen, rows: elements(code, listOpen, closingBracket(code, listOpen)) };
}

/** Reads a page back from its file. */
export function readPage(file: string, source: string, main: string): SettingsPageInfo {
	const code = codeOnly(source);
	const symbol =
		/\b(?:final|const)\s+([A-Za-z_]\w*)\s*=\s*SettingsPage\s*\(/.exec(code)?.[1] ?? null;
	const text = (name: string) =>
		dartStringValue(argumentValue(source, pageCall, name) ?? '') ?? null;
	const parentCode = argumentValue(source, pageCall, 'parent');
	const builtIn = /^SettingsPages\.(\w+)$/.exec(parentCode ?? '')?.[1];
	const parent =
		parentCode === null
			? 'root'
			: builtIn
				? (builtInPages.find((page) => page.constant === builtIn)?.id ?? null)
				: (dartStringValue(parentCode ?? '') ?? null);
	const entries = entriesOf(source);
	return {
		id: text('id'),
		title: text('title'),
		subtitle: text('subtitle'),
		icon: iconName(argumentValue(source, pageCall, 'icon')),
		parent,
		file,
		symbol,
		registered: symbol !== null && new RegExp(`\\b${symbol}\\b`).test(codeOnly(main)),
		rows: entries ? entries.rows.map((row) => readRow(source, row.start, row.end)) : [],
		line: entries ? lineAt(source, entries.open) : 1,
	};
}

/** Every page of the car's own, in order of file name. */
export async function listPages(appDir: string): Promise<SettingsPageInfo[]> {
	const folder = join(appDir, settingsFolder);
	if (!existsSync(folder)) return [];
	const main = await mainSource(appDir);
	const pages: SettingsPageInfo[] = [];
	for (const name of readdirSync(folder)
		.filter((file) => file.endsWith('.dart'))
		.sort()) {
		const file = `${settingsFolder}/${name}`;
		const page = readPage(file, await Bun.file(join(appDir, file)).text(), main);
		if (page.symbol) pages.push(page);
	}
	return pages;
}

/** The page with this id, title or file name. */
export function findPage(pages: SettingsPageInfo[], query: string): SettingsPageInfo | undefined {
	const wanted = query.trim().toLowerCase();
	return pages.find(
		(page) =>
			page.id === wanted ||
			page.title?.toLowerCase() === wanted ||
			page.file.toLowerCase().endsWith(`/${wanted}`) ||
			page.file.toLowerCase().endsWith(`/${wanted}.dart`),
	);
}

/** The row with this id or title, or at this position counted from 1. */
export function findRow(page: SettingsPageInfo, query: string): SettingsRow | undefined {
	const wanted = query.trim().toLowerCase();
	const position = /^\d+$/.test(wanted) ? Number(wanted) : undefined;
	if (position !== undefined && page.rows[position - 1]) return page.rows[position - 1];
	return page.rows.find((row) => row.id === wanted || row.title?.toLowerCase() === wanted);
}

async function mainSource(appDir: string): Promise<string> {
	const file = Bun.file(join(appDir, 'lib', 'main.dart'));
	return (await file.exists()) ? await file.text() : '';
}

/** Internal: how a page's parent is written. */
function parentCode(parent: string): string {
	const builtIn = builtInPages.find((page) => page.id === parent);
	return builtIn ? `SettingsPages.${builtIn.constant}` : dartString(parent);
}

/** A new page's file, with no rows yet. */
export function pageSource(names: PartNames, parent: string, icon: string): string {
	return `import 'package:flutter/material.dart';
import 'package:smartify_os_core/settings.dart';

/// A settings page of your own, which opens from its row in Settings.
///
/// The SmartifyOS editor adds, changes and removes its rows for you, and you
/// can change them here too. A row that runs code of yours calls a function
/// further down, and one that remembers its value keeps it in a SavedValue,
/// which the rest of your app can read.
final ${names.camel}Page = SettingsPage(
  id: '${names.snake}',
  parent: ${parentCode(parent)},
  title: ${dartString(names.name)},
  icon: const Icon(Icons.${icon}),
  entries: [],
);
`;
}

/** What makes up a row, for adding or changing one. Anything left out stays as it is. */
export interface RowChange {
	title?: string;
	/** Empty takes it off. */
	subtitle?: string;
	/** Empty takes it off. */
	section?: string;
	/** A switch or choice: whether it remembers its value between drives. */
	remember?: boolean;
	/** Whether it runs code of the owner's. A button always does. */
	code?: boolean;
	/** A switch or choice that remembers: what it is until the driver changes it. */
	default?: boolean | string;
	/** A choice: what can be picked, by label. */
	options?: string[];
	/** Information: what it shows. */
	value?: string;
}

/** Internal: the names a row's value and function get. */
function rowNames(pageId: string, rowId: string, kind: RowKind) {
	const page = partNames(pageId);
	const row = partNames(rowId);
	const verb = kind === 'toggle' ? 'Changed' : kind === 'choice' ? 'Picked' : 'Tapped';
	return {
		saved: `${page.camel}${row.pascal}`,
		key: `${page.snake}.${row.snake}`,
		code: `_${row.camel}${verb}`,
	};
}

/** Internal: a choice's options, values kept for the labels it had. */
function choiceOptions(labels: string[], before: { value: string; label: string }[]) {
	const used = new Set<string>();
	return labels
		.map((label) => label.trim())
		.filter(Boolean)
		.map((label) => {
			let value = before.find((option) => option.label === label)?.value ?? partNames(label).snake;
			for (let n = 2; used.has(value); n++) value = `${partNames(label).snake}_${n}`;
			used.add(value);
			return { value, label };
		});
}

function optionsCode(options: { value: string; label: string }[]): string {
	return `const [${options.map((option) => `SettingsChoice(${dartString(option.value)}, ${dartString(option.label)})`).join(', ')}]`;
}

/** Internal: a doc comment, wrapped at 80 columns like the rest of a Dart file. */
function doc(text: string): string {
	const lines: string[] = [];
	let line = '///';
	for (const word of text.split(/\s+/)) {
		if (line.length + 1 + word.length > 80 && line !== '///') {
			lines.push(line);
			line = '///';
		}
		line += ` ${word}`;
	}
	lines.push(line);
	return lines.join('\n');
}

function savedSource(name: string, key: string, rowId: string, value: boolean | string): string {
	return `${doc(`What the \`${rowId}\` row is set to, kept between drives. Read and change it anywhere in your app with \`${name}.value\`.`)}
const ${name} = SavedValue(${dartString(key)}, defaultValue: ${dartLiteral(value)});
`;
}

function codeSource(kind: RowKind, name: string, rowId: string): string {
	switch (kind) {
		case 'toggle':
			return `${doc(`Runs every time the \`${rowId}\` switch is switched, with whether it is on now.`)}
void ${name}(bool on) {
  debugPrint('${rowId} is \${on ? 'on' : 'off'}');
}
`;
		case 'choice':
			return `${doc(`Runs every time something is picked in the \`${rowId}\` row, with what it is.`)}
void ${name}(String value) {
  debugPrint('${rowId} is now $value');
}
`;
		default:
			return `${doc(`Runs every time the \`${rowId}\` row is tapped.`)}
void ${name}() {
  debugPrint('${rowId} was tapped');
}
`;
	}
}

/** Internal: the source with something added at the end. */
function appended(source: string, text: string): string {
	return `${source.trimEnd()}\n\n${text}`;
}

/** Internal: the source without the declaration of `name`, and its comment. */
function withoutDeclaration(source: string, name: string): string {
	const code = codeOnly(source);
	const match = new RegExp(`^const\\s+${name}\\s*=\\s*SavedValue\\b`, 'm').exec(code);
	if (!match) return source;
	let start = match.index;
	while (start > 0) {
		const above = code.lastIndexOf('\n', start - 2) + 1;
		if (!source.slice(above, start).trim().startsWith('///')) break;
		start = above;
	}
	const semicolon = code.indexOf(';', match.index);
	const end = semicolon === -1 ? source.length : semicolon + 1;
	return `${source.slice(0, start).trimEnd()}\n${source.slice(end).replace(/^\s*\n/, '\n')}`;
}

/** Internal: the source without the function `name`, and its comment. */
function withoutFunction(source: string, name: string): string {
	const found = functions(source).get(name);
	if (!found) return source;
	return `${source.slice(0, found.start).trimEnd()}\n${source.slice(found.end).replace(/^\s*\n/, '\n')}`;
}

/** What a change to a page left for the owner to know. */
export interface PageChanged {
	page: SettingsPageInfo;
	/** Code of the owner's that was left in the file, though nothing calls it any more. */
	kept: string[];
}

/**
 * Internal: changes one row, in its text, and adds or takes out its value and function.
 *
 * @param usedElsewhere tells whether a saved value is read anywhere else in the app.
 */
export function changeRow(
	source: string,
	page: SettingsPageInfo,
	index: number,
	change: RowChange,
	usedElsewhere: (name: string) => boolean = () => false,
): { source: string; kept: string[] } {
	const span = entriesOf(source)?.rows[index];
	const row = page.rows[index];
	if (!span || !row?.kind || !row.id || !page.id) {
		throw new CliError('That row is not one the CLI can change.', {
			hint: `Change it by hand in ${page.file}.`,
		});
	}
	const kind = row.kind;
	const rowId = row.id;
	const names = rowNames(page.id, rowId, kind);
	const call = rowCall(kind);
	let text = source.slice(span.start, span.end);
	/** What happens to the rest of the file, once the row's own text is back in place. */
	const after: ((source: string) => string)[] = [];
	const kept: string[] = [];

	const set = (name: string, value: string) => {
		text = setArgument(text, call, name, value) ?? text;
	};
	const unset = (name: string) => {
		text = removeArgument(text, call, name) ?? text;
	};
	const declaration = (name: string) =>
		new RegExp(`\\bconst\\s+${name}\\s*=\\s*SavedValue\\s*(?:<[^>()]*>)?\\s*\\(`);

	if (change.title !== undefined) set('title', dartString(change.title));
	for (const name of ['subtitle', 'section'] as const) {
		const value = change[name];
		if (value === undefined) continue;
		if (value.trim()) set(name, dartString(value.trim()));
		else unset(name);
	}
	if (kind === 'info' && change.value !== undefined) set('value', dartString(change.value));

	let options = row.options;
	if (kind === 'choice' && change.options !== undefined) {
		options = choiceOptions(change.options, row.options);
		if (options.length === 0) {
			throw new CliError('A choice needs something to pick.', {
				hint: 'Give it at least one option.',
			});
		}
		set('options', optionsCode(options));
	}

	const savedName = row.saved?.name ?? names.saved;
	if ((kind === 'toggle' || kind === 'choice') && change.remember !== undefined) {
		if (change.remember && !row.saved) {
			const value = change.default ?? (kind === 'toggle' ? false : (options[0]?.value ?? ''));
			set('saved', names.saved);
			after.push((rest) =>
				savedDeclarations(rest).has(names.saved)
					? rest
					: appended(rest, savedSource(names.saved, names.key, rowId, value)),
			);
		} else if (!change.remember && row.saved) {
			const name = row.saved.name;
			unset('saved');
			if (usedElsewhere(name)) kept.push(name);
			else after.push((rest) => withoutDeclaration(rest, name));
		}
	}
	const remembered = change.remember ?? row.saved !== null;
	if (change.default !== undefined && remembered && row.saved) {
		const value = change.default;
		after.push(
			(rest) =>
				setArgument(rest, declaration(savedName), 'defaultValue', dartLiteral(value)) ?? rest,
		);
	}
	// A pick that can no longer be made goes back to the first there is.
	if (kind === 'choice' && change.options !== undefined && remembered && row.saved) {
		after.push((rest) => {
			const current = savedDeclarations(rest).get(savedName)?.default;
			const first = options[0];
			if (!first || options.some((option) => option.value === current)) return rest;
			return (
				setArgument(rest, declaration(savedName), 'defaultValue', dartString(first.value)) ?? rest
			);
		});
	}

	const argument = codeArgument[kind];
	// A button always runs its code, so it is only ever switched on.
	const code = kind === 'action' && change.code === false ? undefined : change.code;
	if (argument && code !== undefined) {
		if (code && !row.code) {
			set(argument, names.code);
			after.push((rest) =>
				functions(rest).has(names.code)
					? rest
					: appended(rest, codeSource(kind, names.code, rowId)),
			);
		} else if (!code && row.code) {
			const { name, written } = row.code;
			unset(argument);
			if (written) kept.push(name);
			else after.push((rest) => withoutFunction(rest, name));
		}
	}

	let result = `${source.slice(0, span.start)}${text}${source.slice(span.end)}`;
	for (const step of after) result = step(result);
	return { source: result, kept };
}

/** Internal: a new row's text, before its value and function are added by {@link changeRow}. */
function rowSource(kind: RowKind, id: string, title: string, change: RowChange): string {
	const lines = [`id: ${dartString(id)}`, `title: ${dartString(title)}`];
	if (kind === 'choice') {
		lines.push(
			`options: ${optionsCode(choiceOptions(change.options ?? ['Option 1', 'Option 2'], []))}`,
		);
	}
	if (kind === 'info') lines.push(`value: ${dartString(change.value ?? '')}`);
	return `SettingsEntry.${kind}(\n${lines.map((line) => `  ${line},`).join('\n')}\n)`;
}

/** Internal: a row id for `title` that no row on the page has. */
function newRowId(page: SettingsPageInfo, title: string): string {
	const base = partNames(title).snake;
	let id = base;
	for (let n = 2; page.rows.some((row) => row.id === id); n++) id = `${base}_${n}`;
	return id;
}

/**
 * Adds a row at the end of a page. A switch and a choice remember their value unless told
 * otherwise, and a button always runs code.
 */
export function addRow(
	source: string,
	page: SettingsPageInfo,
	kind: RowKind,
	title: string,
	change: RowChange = {},
): { source: string; row: SettingsRow } {
	const entries = entriesOf(source);
	if (!entries) {
		throw new CliError(
			`The rows of ${page.title ?? page.file} are not where the CLI can add one.`,
			{
				hint: `Add it by hand in ${page.file}.`,
			},
		);
	}
	const id = newRowId(page, title);
	const added = appendElement(
		source,
		codeOnly(source),
		entries.open,
		rowSource(kind, id, title, change),
	);
	const withRow = readPage(page.file, added, '');
	const index = withRow.rows.length - 1;
	const { source: result } = changeRow(added, withRow, index, {
		...(change.default !== undefined ? { default: change.default } : {}),
		...(change.subtitle !== undefined ? { subtitle: change.subtitle } : {}),
		...(change.section !== undefined ? { section: change.section } : {}),
		remember: kind === 'toggle' || kind === 'choice' ? (change.remember ?? true) : false,
		code: kind === 'action' ? true : (change.code ?? false),
	});
	const row = readPage(page.file, result, '').rows[index];
	if (!row) throw new CliError('The row could not be added.');
	return { source: result, row };
}

/** Takes a row off its page, with its value and its function when nothing else needs them. */
export function removeRow(
	source: string,
	page: SettingsPageInfo,
	index: number,
	usedElsewhere: (name: string) => boolean = () => false,
): { source: string; kept: string[] } {
	const entries = entriesOf(source);
	const row = page.rows[index];
	if (!entries || !row) throw new CliError('There is no such row.');
	let counted = -1;
	let result = removeElement(source, codeOnly(source), entries.open, () => ++counted === index);
	const kept: string[] = [];
	if (row.saved) {
		if (usedElsewhere(row.saved.name)) kept.push(row.saved.name);
		else result = withoutDeclaration(result, row.saved.name);
	}
	if (row.code) {
		if (row.code.written) kept.push(row.code.name);
		else result = withoutFunction(result, row.code.name);
	}
	return { source: result, kept };
}

/** Moves a row one place up or down. */
export function moveRow(source: string, index: number, direction: 'up' | 'down'): string {
	const entries = entriesOf(source);
	const other = direction === 'up' ? index - 1 : index + 1;
	const a = entries?.rows[Math.min(index, other)];
	const b = entries?.rows[Math.max(index, other)];
	if (!a || !b) return source;
	return `${source.slice(0, a.start)}${source.slice(b.start, b.end)}${source.slice(a.end, b.start)}${source.slice(a.start, a.end)}${source.slice(b.end)}`;
}

/** Changes a page itself. Anything left out stays as it is. */
export function changePage(
	source: string,
	page: SettingsPageInfo,
	change: { title?: string; subtitle?: string; icon?: string; parent?: string },
): string {
	let result = source;
	const fail = (what: string) =>
		new CliError(`The ${what} of ${page.title ?? page.file} is not where it can be changed.`, {
			hint: `Change it by hand in ${page.file}.`,
		});
	const set = (name: string, value: string) => {
		const edited = setArgument(result, pageCall, name, value);
		if (edited === undefined) throw fail(name);
		result = edited;
	};
	if (change.title !== undefined) set('title', dartString(partNames(change.title).name));
	if (change.subtitle !== undefined) {
		if (change.subtitle.trim()) set('subtitle', dartString(change.subtitle.trim()));
		else result = removeArgument(result, pageCall, 'subtitle') ?? result;
	}
	if (change.icon !== undefined) set('icon', `const Icon(Icons.${change.icon})`);
	if (change.parent !== undefined) {
		if (change.parent === page.id) {
			throw new CliError('A page cannot go in itself.', { hint: 'Pick another page for it.' });
		}
		set('parent', parentCode(change.parent));
	}
	return result;
}

/** Internal: whether any other Dart file of the app reads `name`. */
async function readElsewhere(appDir: string, file: string, name: string): Promise<boolean> {
	const glob = new Bun.Glob('lib/**/*.dart');
	const pattern = new RegExp(`\\b${name}\\b`);
	for await (const path of glob.scan({ cwd: appDir })) {
		if (path === file) continue;
		if (pattern.test(codeOnly(await Bun.file(join(appDir, path)).text()))) return true;
	}
	return false;
}

/**
 * Makes a page: its file, with no rows yet, handed to SmartifyOS in `lib/main.dart`.
 *
 * @throws {CliError} when there is a page with its name already.
 */
export async function createPage(
	appDir: string,
	names: PartNames,
	parent: string,
	icon: string,
): Promise<{ page: SettingsPageInfo; manual: string | null }> {
	if (builtInPages.some((page) => page.id === names.snake)) {
		throw new CliError(`SmartifyOS has a settings page called ${names.name} already.`, {
			hint: 'Give yours another name.',
		});
	}
	const file = `${settingsFolder}/${names.snake}_page.dart`;
	const existing = findPage(await listPages(appDir), names.snake);
	if (existsSync(join(appDir, file)) || existing) {
		throw new CliError(`Your car's app has a settings page called ${names.name} already.`, {
			hint: `It is in ${existing?.file ?? file}. Give the new one another name.`,
		});
	}
	await Bun.write(join(appDir, file), pageSource(names, parent, icon));
	await formatDart([join(appDir, file)]);

	const mainPath = join(appDir, 'lib', 'main.dart');
	const before = await mainSource(appDir);
	const symbol = `${names.camel}Page`;
	const importLine = `import 'package:${await packageName(appDir)}/${file.slice('lib/'.length)}';`;
	const registered = registerIn(before, settingsRegister, symbol);
	let manual: string | null = null;
	if (registered === undefined) {
		manual = `${symbol} in pages: of SettingsConfig(...), and ${importLine}`;
	} else {
		await writeDart(
			mainPath,
			before,
			addImportLine(addImportLine(registered, settingsRegister.import), importLine),
		);
	}
	const source = await Bun.file(join(appDir, file)).text();
	return { page: readPage(file, source, await mainSource(appDir)), manual };
}

/** Changes a page, a row of it, or its rows, in its file, and reads it back. */
export async function editPageFile(
	appDir: string,
	page: SettingsPageInfo,
	edit: (
		source: string,
		elsewhere: (name: string) => boolean,
	) => { source: string; kept?: string[] },
): Promise<PageChanged> {
	const path = join(appDir, page.file);
	const before = await Bun.file(path).text();
	// Which names other files read, asked up front since the edit itself is not async.
	const names = [...page.rows.flatMap((row) => (row.saved ? [row.saved.name] : []))];
	const elsewhere = new Set<string>();
	for (const name of names) if (await readElsewhere(appDir, page.file, name)) elsewhere.add(name);
	const { source, kept = [] } = edit(before, (name) => elsewhere.has(name));
	await writeDart(path, before, source);
	return { page: readPage(page.file, await Bun.file(path).text(), await mainSource(appDir)), kept };
}

/** Takes a page out of the app: out of `lib/main.dart`, and its file. */
export async function removePage(appDir: string, page: SettingsPageInfo): Promise<void> {
	const mainPath = join(appDir, 'lib', 'main.dart');
	const before = await mainSource(appDir);
	let source = page.symbol ? unregisterIn(before, settingsRegister, page.symbol) : before;
	const importLine = new RegExp(
		`^[ \\t]*import\\s+['"]package:[^/'"]+/${page.file.slice('lib/'.length).replace(/[.]/g, '\\.')}['"];[ \\t]*\\r?\\n`,
		'm',
	);
	source = source.replace(importLine, '');
	await writeDart(mainPath, before, source);
	await rm(join(appDir, page.file), { force: true });
}
