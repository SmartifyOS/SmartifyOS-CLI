import { join } from 'node:path';
import { CliError } from '../../utils/errors.ts';
import {
	argumentAt,
	type ConfigValue,
	callIn,
	collectionIn,
	dartValue,
	type Field,
	lineOf,
	parseWritten,
	readIds,
	type SchemaField,
	type Text,
	textOf,
	withImports,
	written,
} from '../project/config.ts';
import { writeDart } from '../project/dart-file.ts';
import {
	appendElement,
	closingBracket,
	codeOnly,
	type ExtensionEntry,
	elements,
	onlyMatch,
	removeArgumentAt,
	removeElement,
	setArgumentAt,
} from '../project/main-dart.ts';

/**
 * The settings of an extension: the named arguments of its constructor, read from the
 * extension's own source, and their values in the car's `lib/main.dart`, where the app hands it
 * to `SmartifyOs().init(extensions: [...])`.
 *
 * What each setting is comes from the field it sets: its type, its default and its doc comment.
 * A setting of a type the CLI can write (on or off, a number, text, a time, a colour, one of an
 * enum's values, a list of names) can be changed. Anything else, like a list of the car's own
 * commands, is only ever written by hand, and reported as code when it is.
 */

/** An extension's settings, and what the car's app gives each of them. */
export interface ExtensionSettings {
	/** Every argument of its constructor, by name, in the order it declares them. */
	fields: Field[];
	/** Whether the app hands it to `SmartifyOs().init`, which is where its settings are written. */
	switchedOn: boolean;
	/** Where it is in `lib/main.dart`, from 1, when it is switched on. */
	line: number | null;
	/** What is written and can be read, by name. Anything else is its default. */
	values: Record<string, ConfigValue>;
	/** What is written as code, by name, with the line it is on. */
	code: Record<string, { code: string; line: number }>;
}

/** Internal: a setting with what it takes to write it. */
type Setting = SchemaField;

/**
 * Reads what an extension's settings are from its package: the named arguments of the
 * constructor of its `SmartifyOsExtension`, and the doc comments of the fields they set.
 */
export async function readExtensionFields(root: string, entry: ExtensionEntry): Promise<Setting[]> {
	const lib = join(root, 'lib');
	const files = new Map<string, string>();
	for await (const file of new Bun.Glob('**/*.dart').scan({ cwd: lib })) {
		files.set(file, await Bun.file(join(lib, file)).text());
	}
	const source = [...files.values()].find((text) =>
		new RegExp(`\\bclass\\s+${entry.className}\\b`).test(codeOnly(text)),
	);
	if (!source) return [];
	return extensionFields(
		source,
		[...files.values()],
		`package:${entry.packageName}/${entry.library}`,
	);
}

/**
 * Internal: the settings of the extension class in `source`, with the enums and constants of
 * the rest of its package (`others`) to know their values by.
 */
export function extensionFields(source: string, others: string[], library: string): Setting[] {
	const code = codeOnly(source, { keepStrings: true });
	const shape = codeOnly(source);
	const declaration = /\bclass\s+\w+\s+extends\s+SmartifyOsExtension\b[^{]*\{/.exec(shape);
	if (!declaration) return [];
	const open = declaration.index + declaration[0].length - 1;
	const close = closingBracket(shape, open);
	const className = /\bclass\s+(\w+)/.exec(declaration[0])?.[1] ?? '';

	// Its fields at the top of the class: the type and doc comment of each.
	const fieldTypes = new Map<string, { type: string; doc: string }>();
	const fieldPattern =
		/(?<=^|[;{}])\s*(?:late\s+)?final\s+([A-Za-z_][\w<>?, ]*?)\s+([A-Za-z_]\w*)\s*;/g;
	fieldPattern.lastIndex = open;
	for (
		let match = fieldPattern.exec(shape);
		match && match.index < close;
		match = fieldPattern.exec(shape)
	) {
		const at = match.index + match[0].indexOf('final');
		fieldTypes.set(match[2] ?? '', { type: (match[1] ?? '').trim(), doc: docAbove(source, at) });
	}

	// Its constructor, and its named arguments.
	const declared = new RegExp(`(?<=[;{}])\\s*(?:const\\s+)?${className}\\s*\\(\\s*\\{`, 'g');
	declared.lastIndex = open;
	const found = declared.exec(shape);
	if (!found || found.index > close) return [];
	const brace = found.index + found[0].length - 1;
	const braceClose = closingBracket(shape, brace);
	const enums = enumsOf([source, ...others]);

	const settings: Setting[] = [];
	for (const item of elements(shape, brace, braceClose)) {
		const text = code.slice(item.start, item.end).replace(/\s+/g, ' ').trim();
		const own = /^(required\s+)?this\.(\w+)(?:\s*=\s*(.+))?$/.exec(text);
		const typed = own
			? undefined
			: /^(required\s+)?([\w<>?, ]+?)\s+(\w+)(?:\s*=\s*(.+))?$/.exec(text);
		const name = own?.[2] ?? typed?.[3];
		if (!name) continue;
		const declared = fieldTypes.get(name);
		const type = typed?.[2]?.trim() ?? declared?.type ?? 'dynamic';
		settings.push(
			settingOf(name, type, {
				required: Boolean(own?.[1] ?? typed?.[1]),
				defaultText: own?.[3] ?? typed?.[4],
				doc: declared?.doc ?? docAbove(source, item.start),
				enums,
				others: [source, ...others],
				library,
			}),
		);
	}
	return settings;
}

/** Internal: the doc comment right above `at`, as plain text with its paragraphs kept. */
function docAbove(source: string, at: number): string {
	const lines = source.slice(0, at).split('\n');
	lines.pop();
	const doc: string[] = [];
	for (let line = lines.pop(); line !== undefined; line = lines.pop()) {
		const trimmed = line.trim();
		if (trimmed.startsWith('@')) continue;
		if (!trimmed.startsWith('///')) break;
		doc.unshift(trimmed.replace(/^\/\/\/ ?/, ''));
	}
	return doc
		.join('\n')
		.replace(/\[(\w+(?:\.\w+)?)\]/g, '$1')
		.replace(/([^\n])\n(?!\n)/g, '$1 ')
		.trim();
}

/** Internal: every enum in the package, by its name, with its values. */
function enumsOf(sources: string[]): Map<string, string[]> {
	const enums = new Map<string, string[]>();
	for (const source of sources) {
		const code = codeOnly(source);
		for (const match of code.matchAll(
			/\benum\s+(\w+)\s*(?:with\s+[\w, ]+\s*)?(?:implements\s+[\w, ]+\s*)?\{/g,
		)) {
			const open = (match.index ?? 0) + match[0].length - 1;
			const body = code.slice(open + 1, closingBracket(code, open)).split(';')[0] ?? '';
			const values = [...body.matchAll(/(?:^|,)\s*([A-Za-z_]\w*)/g)].map((value) => value[1] ?? '');
			enums.set(match[1] ?? '', values.filter(Boolean));
		}
	}
	return enums;
}

/** Internal: the value of a constant like `VoiceAssistantSounds.listening`, from the package. */
function constantValue(sources: string[], text: string): string | undefined {
	const match = /^(\w+)\.(\w+)$/.exec(text);
	if (!match) return undefined;
	for (const source of sources) {
		const code = codeOnly(source, { keepStrings: true });
		const owner = new RegExp(`\\bclass\\s+${match[1]}\\b[^{]*\\{`).exec(codeOnly(source));
		if (!owner) continue;
		const value = new RegExp(
			`static\\s+const\\s+(?:[\\w<>?]+\\s+)?${match[2]}\\s*=\\s*([^;]+);`,
		).exec(code.slice(owner.index));
		if (value?.[1]) return value[1].trim();
	}
	return undefined;
}

/** Internal: a setting from its Dart type, as the CLI reads and writes it. */
function settingOf(
	name: string,
	type: string,
	more: {
		required: boolean;
		defaultText: string | undefined;
		doc: string;
		enums: Map<string, string[]>;
		others: string[];
		library: string;
	},
): Setting {
	const nullable = type.endsWith('?');
	const base = type.replace(/\?$/, '').replace(/\s+/g, '');
	const setting: Setting = {
		key: name,
		type: 'code',
		describe: more.doc,
		default: null,
		...(more.required ? { required: true } : {}),
		...(nullable ? { nullable: true } : {}),
	};
	if (base === 'bool') setting.type = 'bool';
	else if (base === 'int') setting.type = 'integer';
	else if (base === 'double' || base === 'num') setting.type = 'number';
	else if (base === 'String') setting.type = 'string';
	else if (base === 'Duration') setting.type = 'duration';
	else if (base === 'Color') {
		setting.type = 'color';
		setting.imports = [
			'package:flutter/material.dart',
			'package:flutter/widgets.dart',
			'package:flutter/painting.dart',
		];
	} else if (base === 'List<String>' || base === 'Set<String>') {
		setting.type = 'ids';
		setting.set = base.startsWith('Set');
		setting.default = [];
	} else if (more.enums.has(base)) {
		setting.type = 'enum';
		setting.prefix = base;
		setting.values = more.enums.get(base);
		setting.imports = [more.library];
	}

	const defaultText = more.defaultText?.trim();
	if (defaultText && setting.type !== 'code') {
		const value =
			parseWritten(setting, defaultText) ??
			parseWritten(setting, constantValue(more.others, defaultText) ?? '');
		const empty = /^(?:const\s+)?(?:<[^>]*>\s*)?(?:\[\s*\]|\{\s*\})$/.test(defaultText);
		if (value !== undefined) setting.default = value;
		else if (!(setting.type === 'ids' && empty)) setting.defaultCode = defaultText;
	} else if (defaultText) setting.defaultCode = defaultText;
	return setting;
}

/** Internal: where the extension is in `extensions: [...]`, as a call of its class. */
function elementOf(
	text: Text,
	className: string,
): { open: number; constant: boolean; start: number } | undefined {
	const list = onlyMatch(text.code, /\bextensions\s*:\s*(?:const\s+)?(?:<[^[\]]*>\s*)?\[/);
	if (!list) return undefined;
	const open = list.index + list[0].length - 1;
	const listConstant = /const/.test(list[0]);
	for (const item of elements(text.code, open, closingBracket(text.code, open))) {
		const call = callIn(text.code, item.start, item.end, className);
		if (call)
			return { open: call.open, constant: call.constant || listConstant, start: item.start };
	}
	return undefined;
}

/** Reads what the car's app gives each of an extension's settings. */
export function readExtensionSettings(
	source: string,
	entry: ExtensionEntry,
	fields: Setting[],
): ExtensionSettings {
	const text = textOf(source);
	const element = elementOf(text, entry.className);
	const settings: ExtensionSettings = {
		fields: fields.map(({ imports: _imports, comment: _comment, ...field }) => field),
		switchedOn: element !== undefined,
		line: element ? lineOf(source, element.start) : null,
		values: {},
		code: {},
	};
	if (!element) return settings;
	for (const field of fields) {
		const argument = argumentAt(text.code, element.open, field.key);
		if (!argument) continue;
		const value = written(text, argument.start, argument.end);
		const parsed =
			field.type === 'code'
				? undefined
				: field.type === 'ids'
					? readIds(text, field, argument.start, argument.end)
					: parseWritten(field, value);
		if (parsed === undefined) {
			settings.code[field.key] = { code: value, line: lineOf(source, argument.start) };
		} else settings.values[field.key] = parsed;
	}
	return settings;
}

/** One change of an extension's settings. */
export type ExtensionSettingChange =
	| { op: 'set'; key: string; value: ConfigValue }
	| { op: 'unset'; key: string }
	| { op: 'add'; key: string; id: string }
	| { op: 'remove'; key: string; id: string };

/**
 * Writes changes into the extension's element of `extensions: [...]`, one after the other.
 *
 * @returns the new source, and every change that has no clear place, as the line to add by hand.
 */
export function setExtensionSettings(
	source: string,
	entry: ExtensionEntry,
	fields: Setting[],
	changes: ExtensionSettingChange[],
): { source: string; manual: string[] } {
	let result = source;
	const manual: string[] = [];
	for (const change of changes) {
		const field = fields.find((known) => known.key === change.key);
		if (!field) {
			throw new CliError(`${entry.className} has no setting called ${change.key}.`, {
				hint: `It has ${fields.map((known) => known.key).join(', ') || 'none'}.`,
			});
		}
		if (field.type === 'code' && change.op !== 'unset') {
			throw new CliError(`${change.key} can only be written as code.`, {
				hint: "Write it into lib/main.dart, in your car's app.",
			});
		}
		const text = textOf(result);
		const element = elementOf(text, entry.className);
		if (!element) {
			throw new CliError(`${entry.className} is not switched on in lib/main.dart.`, {
				hint: `Its settings go into ${entry.className}(...) in extensions: [...] of SmartifyOs().init.`,
			});
		}
		const argument = argumentAt(text.code, element.open, change.key);
		const imports: string[][] = [];

		if (change.op === 'set' || (change.op === 'add' && !argument)) {
			const value = change.op === 'set' ? change.value : [change.id];
			const dart = dartValue(field, value, element.constant, imports);
			const edited = argument
				? `${result.slice(0, argument.start)}${dart}${result.slice(argument.end)}`
				: setArgumentAt(result, element.open, change.key, dart);
			if (edited === undefined) manual.push(`${change.key}: ${dart} in ${entry.className}(...)`);
			else result = withImports(edited, imports);
			continue;
		}
		if (change.op === 'unset') {
			result = removeArgumentAt(result, element.open, change.key) ?? result;
			continue;
		}

		// Adding to or taking from a list of names.
		if (!argument) continue;
		const literal =
			collectionIn(text.code, argument.start, argument.end, '[') ??
			collectionIn(text.code, argument.start, argument.end, '{');
		const ids = readIds(text, field, argument.start, argument.end);
		if (!literal || !ids) {
			manual.push(`${change.op === 'add' ? 'add' : 'take'} ${change.id} in ${change.key}`);
			continue;
		}
		if (change.op === 'add') {
			if (!ids.includes(change.id)) {
				result = appendElement(
					result,
					text.code,
					literal.open,
					dartValue({ ...field, type: 'string' }, change.id, true, imports),
				);
			}
			continue;
		}
		const index = ids.indexOf(change.id);
		if (index === -1) continue;
		if (ids.length === 1) {
			result = removeArgumentAt(result, element.open, change.key) ?? result;
			continue;
		}
		let at = 0;
		result = removeElement(result, text.code, literal.open, () => at++ === index);
	}
	return { source: result, manual };
}

/** Changes an extension's settings in the car's `lib/main.dart`, formatted afterwards. */
export async function changeExtensionSettings(
	mainPath: string,
	entry: ExtensionEntry,
	fields: Setting[],
	changes: ExtensionSettingChange[],
): Promise<ExtensionSettings & { changed: boolean; manual: string[] }> {
	const before = await Bun.file(mainPath).text();
	const { source, manual } = setExtensionSettings(before, entry, fields, changes);
	await writeDart(mainPath, before, source);
	const after = await Bun.file(mainPath).text();
	return { changed: after !== before, manual, ...readExtensionSettings(after, entry, fields) };
}
