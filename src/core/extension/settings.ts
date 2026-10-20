import { join } from 'node:path';
import { CliError } from '../../utils/errors.ts';
import { dartStringValue } from '../project/appearance.ts';
import {
	argumentAt,
	type ConfigValue,
	callIn,
	collectionIn,
	dartItem,
	dartValue,
	type Field,
	lineOf,
	parseValue,
	parseWritten,
	readIds,
	type SchemaField,
	type Text,
	textOf,
	withImports,
	written,
} from '../project/config.ts';
import { dartString } from '../project/create.ts';
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
 * enum's values, a list of names or numbers) can be changed. A setting that is another class of
 * the extension's (`aiServer: VoiceAiServer(...)`) is an object with settings of its own, made
 * with one of its constructors (freezed factories included) or one of the constants of its type
 * the package has (`SpeechModels.parakeet`), read and changed by a dotted key: `aiServer.url`.
 * Its classes are only read when it is asked about, see {@link describeSetting}. Anything else,
 * like a list of the car's own commands, is only ever written by hand, and reported as code.
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
	/** What is written as code, and every object that is written, by name, with its line. */
	code: Record<string, { code: string; line: number }>;
}

/** Internal: a setting with what it takes to write it. */
type Setting = SchemaField;

/** One way of making an object: one of its class's constructors, and what it takes. */
export interface Making {
	/** The constructor's name after the dot, empty for the class's own. */
	name: string;
	/** Whether it can be `const`. */
	isConst: boolean;
	fields: Setting[];
}

/** A class of the extension's a setting can be, and the ways it can be made. */
export interface ClassInfo {
	className: string;
	/**
	 * Its constructors with named arguments only, the private ones and the ones that need
	 * something only code can give left out.
	 */
	makings: Making[];
	/** The constants of its type the package has, as written: `SpeechModels.parakeet`. */
	constants: { name: string; isConst: boolean }[];
}

/** An extension's package, read once, to look its classes up in. */
export interface ExtensionPackage {
	sources: string[];
	/** The library the app imports it by. */
	library: string;
	enums: Map<string, string[]>;
	/** Every class it declares. */
	classes: Set<string>;
}

/** Reads every Dart file of an extension's package. */
export async function readExtensionPackage(
	root: string,
	entry: ExtensionEntry,
): Promise<ExtensionPackage> {
	const lib = join(root, 'lib');
	const sources: string[] = [];
	for await (const file of new Bun.Glob('**/*.dart').scan({ cwd: lib })) {
		sources.push(await Bun.file(join(lib, file)).text());
	}
	return packageOf(sources, `package:${entry.packageName}/${entry.library}`);
}

/** Internal: a package from its sources. */
export function packageOf(sources: string[], library: string): ExtensionPackage {
	const classes = new Set<string>();
	for (const source of sources) {
		for (const match of codeOnly(source).matchAll(/\bclass\s+([A-Za-z_]\w*)/g)) {
			classes.add(match[1] ?? '');
		}
	}
	return { sources, library, enums: enumsOf(sources), classes };
}

/** The settings an extension's class takes: the arguments of its own constructor. */
export function extensionFields(pack: ExtensionPackage, className: string): Setting[] {
	return classInfo(pack, className)?.makings.find((making) => making.name === '')?.fields ?? [];
}

/** Internal: where a class is declared, and its body. */
function classAt(
	pack: ExtensionPackage,
	className: string,
): { source: string; shape: string; code: string; open: number; close: number } | undefined {
	for (const source of pack.sources) {
		const shape = codeOnly(source);
		const declaration = new RegExp(`\\bclass\\s+${className}\\b[^{;]*\\{`).exec(shape);
		if (!declaration) continue;
		const open = declaration.index + declaration[0].length - 1;
		return {
			source,
			shape,
			code: codeOnly(source, { keepStrings: true }),
			open,
			close: closingBracket(shape, open),
		};
	}
	return undefined;
}

/**
 * What a class of the extension's is: its constructors that take named arguments only (a
 * freezed class's factories too), each with what it takes, and the constants of its type.
 */
export function classInfo(pack: ExtensionPackage, className: string): ClassInfo | undefined {
	const found = classAt(pack, className);
	if (!found) return undefined;
	const { source, shape, code, open, close } = found;

	// Its fields: the type and doc comment of each, for arguments that set one.
	const fields = new Map<string, { type: string; doc: string }>();
	const fieldPattern =
		/(?<=[;{}])\s*(?:late\s+)?final\s+([A-Za-z_][\w<>?, ]*?)\s+([A-Za-z_]\w*)\s*;/g;
	fieldPattern.lastIndex = open;
	for (
		let match = fieldPattern.exec(shape);
		match && match.index < close;
		match = fieldPattern.exec(shape)
	) {
		const at = match.index + match[0].indexOf('final');
		fields.set(match[2] ?? '', { type: (match[1] ?? '').trim(), doc: docAbove(source, at) });
	}

	const makings: Making[] = [];
	const header = new RegExp(
		`(?<=[;{}])\\s*(const\\s+)?(factory\\s+)?${className}(?:\\.([A-Za-z_]\\w*))?\\s*\\(`,
		'g',
	);
	header.lastIndex = open;
	for (let match = header.exec(shape); match && match.index < close; match = header.exec(shape)) {
		const name = match[3] ?? '';
		if (name.startsWith('_')) continue;
		const paren = match.index + match[0].length - 1;
		const parenClose = closingBracket(shape, paren);
		const inside = shape.slice(paren + 1, parenClose).trim();
		// Positional arguments are left to code.
		if (inside && !inside.startsWith('{')) continue;
		const making: Making = { name, isConst: Boolean(match[1]), fields: [] };
		if (inside) {
			const brace = shape.indexOf('{', paren);
			const initializers = initializerDefaults(code, parenClose);
			for (const item of elements(shape, brace, closingBracket(shape, brace))) {
				const setting = argumentSetting(pack, code.slice(item.start, item.end), {
					fields,
					doc: docAbove(source, item.start),
					initializers,
				});
				if (setting) making.fields.push(setting);
			}
		}
		// One that has to be given something only code can give is no use here.
		if (making.fields.some((field) => field.required && field.type === 'code')) continue;
		makings.push(making);
	}

	return { className, makings, constants: constantsOf(pack, className) };
}

/** Internal: `recognizer = recognizer ?? SpeechModels.parakeet` after a constructor, by name. */
function initializerDefaults(code: string, parenClose: number): Map<string, string> {
	const defaults = new Map<string, string>();
	const rest = /^\s*:([^{;]*)/.exec(code.slice(parenClose + 1))?.[1];
	if (!rest) return defaults;
	for (const match of rest.matchAll(/(\w+)\s*=\s*\1\s*\?\?\s*([^,]+)/g)) {
		defaults.set(match[1] ?? '', (match[2] ?? '').trim());
	}
	return defaults;
}

/** Internal: one named argument of a constructor, as written, as a setting. */
function argumentSetting(
	pack: ExtensionPackage,
	written: string,
	more: {
		fields: Map<string, { type: string; doc: string }>;
		doc: string;
		initializers: Map<string, string>;
	},
): Setting | undefined {
	let text = written.replace(/\s+/g, ' ').trim();
	// Annotations, `@Default(...)` of a freezed class giving the default.
	let defaultText: string | undefined;
	for (let at = text.indexOf('@'); at === 0; at = text.indexOf('@')) {
		const name = /^@(\w+)/.exec(text)?.[1] ?? '';
		let end = 1 + name.length;
		if (text[end] === '(') {
			const close = closingBracket(text, end);
			if (name === 'Default') defaultText = text.slice(end + 1, close).trim();
			end = close + 1;
		}
		text = text.slice(end).trim();
	}
	const own = /^(required\s+)?this\.(\w+)(?:\s*=\s*(.+))?$/.exec(text);
	const typed = own
		? undefined
		: /^(required\s+)?([\w<>?, ]+?)\s+(\w+)(?:\s*=\s*(.+))?$/.exec(text);
	const name = own?.[2] ?? typed?.[3];
	if (!name) return undefined;
	const field = more.fields.get(name);
	return settingOf(pack, name, typed?.[2]?.trim() ?? field?.type ?? 'dynamic', {
		required: Boolean(own?.[1] ?? typed?.[1]),
		defaultText: own?.[3] ?? typed?.[4] ?? defaultText ?? more.initializers.get(name),
		doc: more.doc || field?.doc || '',
	});
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

/**
 * Internal: the public static constants of a class's type in the package: declared as it, made
 * with it, or made by a static function of the same class that gives one.
 */
function constantsOf(
	pack: ExtensionPackage,
	className: string,
): { name: string; isConst: boolean }[] {
	const found: { name: string; isConst: boolean }[] = [];
	for (const source of pack.sources) {
		const shape = codeOnly(source);
		for (const owner of shape.matchAll(/\bclass\s+([A-Za-z_]\w*)[^{;]*\{/g)) {
			const open = (owner.index ?? 0) + owner[0].length - 1;
			const body = shape.slice(open, closingBracket(shape, open));
			const makers = new Set(
				[...body.matchAll(new RegExp(`static\\s+${className}\\s+(\\w+)\\s*\\(`, 'g'))].map(
					(maker) => maker[1] ?? '',
				),
			);
			for (const member of body.matchAll(
				/static\s+(const|final)\s+(?:([\w<>?]+)\s+)?([A-Za-z]\w*)\s*=\s*(?:const\s+)?([\w.]+)\s*[(;]/g,
			)) {
				const [, kind, type, name, made] = member;
				const callee = made?.split('.')[0] ?? '';
				const ofClass =
					type === className || (!type && (callee === className || makers.has(made ?? '')));
				if (ofClass && name) found.push({ name: `${owner[1]}.${name}`, isConst: kind === 'const' });
			}
		}
	}
	return found;
}

/** Internal: a setting from its Dart type, as the CLI reads and writes it. */
function settingOf(
	pack: ExtensionPackage,
	name: string,
	type: string,
	more: { required: boolean; defaultText: string | undefined; doc: string },
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
	} else if (/^(List|Set)<(String|int)>$/.test(base)) {
		setting.type = 'ids';
		setting.set = base.startsWith('Set');
		if (base.endsWith('<int>')) setting.itemType = 'integer';
		setting.default = [];
	} else if (pack.enums.has(base)) {
		setting.type = 'enum';
		setting.prefix = base;
		setting.values = pack.enums.get(base);
		setting.imports = [pack.library];
	} else if (pack.classes.has(base) && makeable(pack, base)) {
		setting.type = 'object';
		setting.className = base;
		setting.imports = [pack.library];
	} else {
		// A list, set or map of something that can be written itself, one item at a time.
		const list = /^(List|Set)<(.+)>$/.exec(base);
		const map = /^Map<String,(.+)>$/.exec(base);
		const itemType = list?.[2] ?? map?.[1];
		const item = itemType
			? settingOf(pack, 'item', itemType, { required: false, defaultText: undefined, doc: '' })
			: undefined;
		if (item && !['code', 'ids', 'array', 'map'].includes(item.type) && !item.nullable) {
			setting.type = map ? 'map' : 'array';
			if (list?.[1] === 'Set') setting.set = true;
			setting.item = plain(item);
			if (item.imports) setting.imports = item.imports;
		}
	}

	const defaultText = more.defaultText?.trim();
	if (setting.type === 'array' || setting.type === 'map') {
		const empty = /^(?:const\s+)?(?:<[^>]*>\s*)?(?:\[\s*\]|\{\s*\})$/.test(defaultText ?? '');
		if (defaultText && !empty) setting.defaultCode = defaultText.replace(/^const\s+/, '');
	} else if (defaultText && setting.type !== 'code' && setting.type !== 'object') {
		const value =
			parseWritten(setting, defaultText) ??
			parseWritten(setting, constantValue(pack.sources, defaultText) ?? '');
		const empty = /^(?:const\s+)?(?:<[^>]*>\s*)?(?:\[\s*\]|\{\s*\})$/.test(defaultText);
		if (value !== undefined) setting.default = value;
		else if (!(setting.type === 'ids' && empty)) setting.defaultCode = defaultText;
	} else if (defaultText) setting.defaultCode = defaultText.replace(/^const\s+/, '');
	return setting;
}

/** Internal: which classes of a package can be made, known so far. */
const makeables = new WeakMap<ExtensionPackage, Map<string, boolean>>();

/**
 * Internal: whether a class can be made here at all, by a constructor or a constant. A class
 * with a setting of its own type is not read again while it is being read.
 */
function makeable(pack: ExtensionPackage, className: string): boolean {
	let known = makeables.get(pack);
	if (!known) {
		known = new Map();
		makeables.set(pack, known);
	}
	const seen = known.get(className);
	if (seen !== undefined) return seen;
	known.set(className, true);
	const info = classInfo(pack, className);
	const result = Boolean(info && (info.makings.length > 0 || info.constants.length > 0));
	known.set(className, result);
	return result;
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

/** Internal: which of a class's constructors a call is, `Class.name(` or `Class(`. */
function makingOf(text: Text, start: number, end: number, info: ClassInfo): Making | undefined {
	const call = callIn(text.code, start, end);
	if (!call) return undefined;
	const callee = /^(?:const\s+)?([\w.]+)/.exec(text.code.slice(start, call.open))?.[1] ?? '';
	const [owner, name = ''] = callee.split('.');
	if (owner !== info.className) return undefined;
	return info.makings.find((making) => making.name === name);
}

/** Internal: one step of a key: a setting's name, and which item of it for a list or map. */
interface Step {
	name: string;
	/** `de` of `voices[de]`, `2` of `cameras[2]`. */
	item?: string;
}

/** Internal: a key as its steps: `aiServer.url`, `voices[de]`, `cameras[2].name`. */
function stepsOf(key: string): Step[] {
	const steps: Step[] = [];
	const pattern = /([A-Za-z_]\w*)(?:\[([^\]]*)\])?(?:\.|$)/y;
	let at = 0;
	while (at < key.length) {
		pattern.lastIndex = at;
		const match = pattern.exec(key);
		if (!match) {
			throw new CliError(`${key} is not the name of a setting.`, {
				hint: 'Name one like aiServer.url, or an item like voices[de].',
			});
		}
		steps.push({ name: match[1] ?? '', ...(match[2] !== undefined ? { item: match[2] } : {}) });
		at = pattern.lastIndex;
	}
	return steps;
}

/** Internal: the items of a list, set or map as written, each by its place or its key. */
interface Items {
	open: number;
	constant: boolean;
	entries: { key: string; start: number; end: number; value: { start: number; end: number } }[];
}

/** Internal: the items of the collection written between `start` and `end`, undefined for code. */
function itemsIn(text: Text, field: Setting, start: number, end: number): Items | undefined {
	const bracket = field.type === 'map' || field.set ? '{' : '[';
	const literal = collectionIn(text.code, start, end, bracket);
	if (!literal) return undefined;
	const close = closingBracket(text.code, literal.open);
	const entries: Items['entries'] = [];
	for (const [index, item] of elements(text.code, literal.open, close).entries()) {
		if (field.type !== 'map') {
			entries.push({ key: String(index), start: item.start, end: item.end, value: item });
			continue;
		}
		// `'de': SpeechModels.piperThorsten`, its key a string.
		const colon = colonAt(text.code, item.start, item.end);
		const key = colon === -1 ? undefined : dartStringValue(written(text, item.start, colon));
		if (key === undefined) return undefined;
		const after = text.code.slice(colon + 1, item.end);
		const value = { start: colon + 1 + after.length - after.trimStart().length, end: item.end };
		entries.push({ key, start: item.start, end: item.end, value });
	}
	return { open: literal.open, constant: literal.constant, entries };
}

/** Internal: the colon between a map entry's key and its value, outside of brackets. */
function colonAt(code: string, start: number, end: number): number {
	let depth = 0;
	for (let i = start; i < end; i++) {
		const char = code[i];
		if (char === '(' || char === '[' || char === '{') depth++;
		else if (char === ')' || char === ']' || char === '}') depth--;
		else if (char === ':' && depth === 0) return i;
	}
	return -1;
}

/** Internal: the call the last step of a key is an argument of, and the settings it takes. */
interface Parent {
	open: number;
	constant: boolean;
	fields: Setting[];
	/** What it is, for messages. */
	at: string;
}

/**
 * Internal: follows the steps of a key from the extension's element to the call they end in:
 * the object each step is made with, through an item of a list or map where a step names one.
 */
function walk(
	text: Text,
	pack: ExtensionPackage,
	entry: ExtensionEntry,
	path: Step[],
): Parent | { problem: string } {
	const element = elementOf(text, entry.className);
	if (!element) {
		return { problem: `${entry.className} is not switched on in lib/main.dart.` };
	}
	let parent: Parent = {
		open: element.open,
		constant: element.constant,
		fields: extensionFields(pack, entry.className),
		at: entry.className,
	};
	for (const step of path) {
		const named = step.item === undefined ? step.name : `${step.name}[${step.item}]`;
		const field = parent.fields.find((known) => known.key === step.name);
		const argument = argumentAt(text.code, parent.open, step.name);
		let target = field;
		let span = argument;
		let constant = parent.constant;
		if (step.item !== undefined) {
			const items =
				field?.item && argument ? itemsIn(text, field, argument.start, argument.end) : undefined;
			const found = items?.entries.find((known) => known.key === step.item);
			target = field?.item as Setting | undefined;
			span = found?.value;
			constant ||= items?.constant ?? false;
		}
		if (!target?.className) return { problem: `${parent.at} has no object called ${named}.` };
		const info = classInfo(pack, target.className);
		if (!info || !span) return { problem: `${named} is not set up yet.` };
		const making = makingOf(text, span.start, span.end, info);
		const call = callIn(text.code, span.start, span.end);
		if (!making || !call) return { problem: `${named} is written as code.` };
		parent = {
			open: call.open,
			constant: constant || call.constant,
			fields: making.fields,
			at: info.className,
		};
	}
	return parent;
}

/** Internal: where the value of a key goes: an argument of its parent, or an item of a list or map. */
interface Place {
	parent: Parent;
	step: Step;
	/** The setting itself; for an item, what each item of its list or map is. */
	field: Setting;
	/** The list or map, for an item. */
	collection?: Setting;
	/** The argument written for the setting, or for the list or map of an item. */
	argument?: { start: number; end: number };
	/** The items of the list or map, when it is written plainly. */
	items?: Items;
	/** Where its value is written, when it is. */
	value?: { start: number; end: number };
	/** Whether what is written there is inside something const already. */
	constant: boolean;
}

function placeOf(text: Text, pack: ExtensionPackage, entry: ExtensionEntry, key: string): Place {
	const steps = stepsOf(key);
	const step = steps.pop() as Step;
	const parent = walk(text, pack, entry, steps);
	if ('problem' in parent) {
		throw new CliError(parent.problem, {
			hint: `Its settings go into ${entry.className}(...) in extensions: [...] of SmartifyOs().init.`,
		});
	}
	const field = parent.fields.find((known) => known.key === step.name);
	if (!field) {
		throw new CliError(`${parent.at} has no setting called ${step.name}.`, {
			hint: `It has ${parent.fields.map((known) => known.key).join(', ') || 'none'}.`,
		});
	}
	const argument = argumentAt(text.code, parent.open, step.name);
	if (step.item === undefined) {
		return { parent, step, field, argument, value: argument, constant: parent.constant };
	}
	if (!field.item) throw new CliError(`${step.name} is not a list or a map.`);
	const items = argument ? itemsIn(text, field, argument.start, argument.end) : undefined;
	const found = items?.entries.find((known) => known.key === step.item);
	return {
		parent,
		step,
		field: { ...field.item, key: step.item, ...(field.imports ? { imports: field.imports } : {}) },
		collection: field,
		argument,
		items,
		value: found?.value,
		constant: parent.constant || (items?.constant ?? false),
	};
}

/** Internal: what is written for one value: read by what it is, or as code. */
function readValue(
	text: Text,
	source: string,
	field: Setting,
	span: { start: number; end: number },
): { value: ConfigValue } | { code: { code: string; line: number } } {
	const value = written(text, span.start, span.end);
	const parsed = ['code', 'object', 'array', 'map'].includes(field.type)
		? undefined
		: field.type === 'ids'
			? readIds(text, field, span.start, span.end)
			: parseWritten(field, value);
	return parsed === undefined
		? { code: { code: value, line: lineOf(source, span.start) } }
		: { value: parsed };
}

/** Internal: what is written for each of a call's settings. */
function readArguments(
	text: Text,
	source: string,
	open: number,
	fields: Setting[],
): Pick<ExtensionSettings, 'values' | 'code'> {
	const read: Pick<ExtensionSettings, 'values' | 'code'> = { values: {}, code: {} };
	for (const field of fields) {
		const argument = argumentAt(text.code, open, field.key);
		if (!argument) continue;
		const found = readValue(text, source, field, argument);
		if ('code' in found) read.code[field.key] = found.code;
		else read.values[field.key] = found.value;
	}
	return read;
}

/** Internal: a setting as it is reported, without what it takes to write it. */
function plain({ imports: _imports, comment: _comment, ...field }: Setting): Field {
	return field;
}

/** Reads what the car's app gives each of an extension's settings. */
export function readExtensionSettings(
	source: string,
	entry: ExtensionEntry,
	pack: ExtensionPackage,
): ExtensionSettings {
	const fields = extensionFields(pack, entry.className);
	const text = textOf(source);
	const element = elementOf(text, entry.className);
	const settings: ExtensionSettings = {
		fields: fields.map(plain),
		switchedOn: element !== undefined,
		line: element ? lineOf(source, element.start) : null,
		values: {},
		code: {},
	};
	if (!element) return settings;
	return { ...settings, ...readArguments(text, source, element.open, fields) };
}

/** What an object setting is, and what is written for it, as {@link describeSetting} says. */
export interface SettingDetail {
	kind: 'object';
	key: string;
	className: string;
	/** Each constructor it can be made with, with what it takes, by its name (empty for the class's own). */
	makings: { name: string; fields: Field[] }[];
	/** The constants of its type it can be instead, as written: `SpeechModels.parakeet`. */
	constants: string[];
	/** What is written: made with a constructor, a constant, other code, or nothing yet. */
	written:
		| {
				kind: 'made';
				making: string;
				values: Record<string, ConfigValue>;
				code: Record<string, { code: string; line: number }>;
		  }
		| { kind: 'constant'; name: string }
		| { kind: 'code'; code: string; line: number }
		| null;
}

/** What a list or map setting has, as {@link describeSetting} says. */
export interface CollectionDetail {
	kind: 'collection';
	key: string;
	/** A list (or set) of items, or a map of them by a string. */
	collection: 'array' | 'map';
	/** What each item is. */
	item: Field;
	/**
	 * Each item, by its place or its key: what it is when it can be read, the code it is written
	 * as otherwise, which for an object is what it is made as, `SpeechModels.piperThorsten`.
	 */
	entries: {
		key: string;
		line: number;
		value?: ConfigValue;
		code?: string;
	}[];
	/** The whole list or map, when it is written as code rather than item by item. */
	code?: { code: string; line: number };
}

/**
 * Says what a setting with settings of its own is (`aiServer`, `voices[de]`, or one inside
 * another), or what a list or map setting has (`voices`), by its key: the ways it can be made,
 * and what the app gives it. Only this one class is read, the classes of the objects inside it
 * when they are asked about in turn.
 */
export function describeSetting(
	source: string,
	entry: ExtensionEntry,
	pack: ExtensionPackage,
	key: string,
): SettingDetail | CollectionDetail {
	const text = textOf(source);
	const at = placeOf(text, pack, entry, key);
	const field = at.field;

	if ((field.type === 'array' || field.type === 'map') && field.item) {
		const items = at.argument
			? itemsIn(text, field, at.argument.start, at.argument.end)
			: undefined;
		const item = field.item as Setting;
		return {
			kind: 'collection',
			key,
			collection: field.type,
			item: plain(item),
			entries: (items?.entries ?? []).map((found) => {
				const read = readValue(text, source, item, found.value);
				return {
					key: found.key,
					line: lineOf(source, found.start),
					...('value' in read ? { value: read.value } : { code: read.code.code }),
				};
			}),
			...(at.argument && !items
				? {
						code: {
							code: written(text, at.argument.start, at.argument.end),
							line: lineOf(source, at.argument.start),
						},
					}
				: {}),
		};
	}

	if (field.type !== 'object' || !field.className) {
		throw new CliError(`${key} is not a setting with settings of its own.`);
	}
	const info = classInfo(pack, field.className) as ClassInfo;
	const detail: SettingDetail = {
		kind: 'object',
		key,
		className: info.className,
		makings: info.makings.map((making) => ({
			name: making.name,
			fields: making.fields.map(plain),
		})),
		constants: info.constants.map((constant) => constant.name),
		written: null,
	};
	if (!at.value) return detail;
	const value = written(text, at.value.start, at.value.end);
	const making = makingOf(text, at.value.start, at.value.end, info);
	const call = callIn(text.code, at.value.start, at.value.end);
	if (making && call) {
		detail.written = {
			kind: 'made',
			making: making.name,
			...readArguments(text, source, call.open, making.fields),
		};
	} else if (info.constants.some((constant) => constant.name === value)) {
		detail.written = { kind: 'constant', name: value };
	} else detail.written = { kind: 'code', code: value, line: lineOf(source, at.value.start) };
	return detail;
}

/** One change of an extension's settings, by its key. */
export type ExtensionSettingChange =
	| { op: 'set'; key: string; value: unknown }
	| { op: 'unset'; key: string }
	| { op: 'add'; key: string; id: string }
	| { op: 'remove'; key: string; id: string };

/**
 * Internal: an object as Dart: a constant (`"SpeechModels.parakeet"`), or a constructor and what
 * it is given (`{"$making": "existing", "passphrase": "..."}`), each of those checked.
 */
function dartObject(
	pack: ExtensionPackage,
	field: Setting,
	key: string,
	value: unknown,
	inConst: boolean,
	imports: string[][],
): string {
	const info = classInfo(pack, field.className as string) as ClassInfo;
	if (field.imports) imports.push(field.imports);
	if (typeof value === 'string') {
		const constant = info.constants.find((known) => known.name === value);
		if (!constant) {
			throw new CliError(`${value} is not one of the ${info.className}s there are.`, {
				hint: `Use one of ${info.constants.map((known) => known.name).join(', ') || 'none'}, or give its settings as JSON.`,
			});
		}
		if (inConst && !constant.isConst) {
			throw new CliError(`${value} cannot go inside something const.`, {
				hint: 'Take the const off in lib/main.dart.',
			});
		}
		return value;
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new CliError(`Give ${key} as one of its constants, or its settings as JSON.`);
	}
	const given = value as Record<string, unknown>;
	const makingName = typeof given.$making === 'string' ? given.$making : '';
	const making = info.makings.find((known) => known.name === makingName);
	if (!making) {
		throw new CliError(`${info.className} has no constructor called ${makingName || 'that'}.`, {
			hint: `It has ${info.makings.map((known) => known.name || info.className).join(', ')}.`,
		});
	}
	const missing = making.fields.filter((inner) => inner.required && given[inner.key] == null);
	if (missing.length > 0) {
		throw new CliError(`${key} needs ${missing.map((inner) => inner.key).join(' and ')}.`);
	}
	const inside = inConst || making.isConst;
	const args = Object.entries(given)
		.filter(([name]) => name !== '$making')
		.map(([name, inner]) => {
			const setting = making.fields.find((known) => known.key === name);
			if (!setting || ['code', 'array', 'map'].includes(setting.type)) {
				throw new CliError(`${info.className} has no setting called ${name} this can write.`);
			}
			return `${name}: ${dartAny(pack, setting, `${key}.${name}`, inner, inside, imports)}`;
		});
	const call = `${info.className}${making.name ? `.${making.name}` : ''}(${args.join(', ')})`;
	return making.isConst && !inConst ? `const ${call}` : call;
}

/** Internal: any value a setting can be given, as Dart. */
function dartAny(
	pack: ExtensionPackage,
	field: Setting,
	key: string,
	value: unknown,
	inConst: boolean,
	imports: string[][],
): string {
	return field.type === 'object'
		? dartObject(pack, field, key, value, inConst, imports)
		: dartValue(field, parseValue(field, key, value) as ConfigValue, inConst, imports);
}

/**
 * Writes changes into the extension's element of `extensions: [...]`, one after the other.
 *
 * @returns the new source, and every change that has no clear place, as the line to add by hand.
 */
export function setExtensionSettings(
	source: string,
	entry: ExtensionEntry,
	pack: ExtensionPackage,
	changes: ExtensionSettingChange[],
): { source: string; manual: string[] } {
	let result = source;
	const manual: string[] = [];
	for (const change of changes) {
		const text = textOf(result);
		const at = placeOf(text, pack, entry, change.key);
		const { field, parent, step } = at;
		if (field.type === 'code' && change.op !== 'unset') {
			throw new CliError(`${change.key} can only be written as code.`, {
				hint: "Write it into lib/main.dart, in your car's app.",
			});
		}
		if ((field.type === 'array' || field.type === 'map') && change.op !== 'unset') {
			throw new CliError(`Change ${change.key} one item at a time.`, {
				hint: `Name one like ${change.key}[${field.type === 'map' ? 'name' : '0'}].`,
			});
		}
		const imports: string[][] = [];

		// An item of a list or map.
		if (at.collection) {
			const collection = at.collection;
			const entries = at.items?.entries ?? [];
			const index = entries.findIndex((known) => known.key === step.item);
			if (change.op === 'unset') {
				if (index === -1 || !at.items) continue;
				result =
					entries.length === 1
						? (removeArgumentAt(result, parent.open, step.name) ?? result)
						: (() => {
								let count = 0;
								return removeElement(result, text.code, at.items.open, () => count++ === index);
							})();
				continue;
			}
			if (change.op !== 'set') throw new CliError(`${change.key} is not a list of names.`);
			const dart = dartAny(pack, field, change.key, change.value, at.constant, imports);
			const item = collection.type === 'map' ? `${dartString(step.item as string)}: ${dart}` : dart;
			let edited: string | undefined;
			if (at.value)
				edited = `${result.slice(0, at.value.start)}${dart}${result.slice(at.value.end)}`;
			else if (!at.argument) {
				const literal = collection.type === 'map' || collection.set ? `{${item}}` : `[${item}]`;
				edited = setArgumentAt(result, parent.open, step.name, literal);
			} else if (at.items) {
				if (collection.type !== 'map' && Number(step.item) !== entries.length) {
					throw new CliError(`${change.key} is not there.`, {
						hint: `Add one at the end, as ${step.name}[${entries.length}].`,
					});
				}
				edited = appendElement(result, text.code, at.items.open, item);
			}
			if (edited === undefined) manual.push(`${item} in ${step.name} of ${parent.at}(...)`);
			else result = withImports(edited, imports);
			continue;
		}

		const argument = at.argument;
		if (change.op === 'set' || (change.op === 'add' && !argument)) {
			const dart =
				change.op === 'add'
					? dartValue(field, [change.id], parent.constant, imports)
					: dartAny(pack, field, change.key, change.value, parent.constant, imports);
			const edited = argument
				? `${result.slice(0, argument.start)}${dart}${result.slice(argument.end)}`
				: setArgumentAt(result, parent.open, step.name, dart);
			if (edited === undefined) manual.push(`${step.name}: ${dart} in ${parent.at}(...)`);
			else result = withImports(edited, imports);
			continue;
		}
		if (change.op === 'unset') {
			result = removeArgumentAt(result, parent.open, step.name) ?? result;
			continue;
		}

		// Adding to or taking from a list of names or numbers.
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
			const [item] = parseValue(field, change.key, change.id) as string[];
			if (item && !ids.includes(item)) {
				result = appendElement(result, text.code, literal.open, dartItem(field, item));
			}
			continue;
		}
		const index = ids.indexOf(change.id);
		if (index === -1) continue;
		if (ids.length === 1) {
			result = removeArgumentAt(result, parent.open, step.name) ?? result;
			continue;
		}
		let count = 0;
		result = removeElement(result, text.code, literal.open, () => count++ === index);
	}
	return { source: result, manual };
}

/** Changes an extension's settings in the car's `lib/main.dart`, formatted afterwards. */
export async function changeExtensionSettings(
	mainPath: string,
	entry: ExtensionEntry,
	pack: ExtensionPackage,
	changes: ExtensionSettingChange[],
): Promise<ExtensionSettings & { changed: boolean; manual: string[] }> {
	const before = await Bun.file(mainPath).text();
	const { source, manual } = setExtensionSettings(before, entry, pack, changes);
	await writeDart(mainPath, before, source);
	const after = await Bun.file(mainPath).text();
	return { changed: after !== before, manual, ...readExtensionSettings(after, entry, pack) };
}
