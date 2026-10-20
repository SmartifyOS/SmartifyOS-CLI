import { join } from 'node:path';
import { CliError } from '../../utils/errors.ts';
import { closest } from '../../utils/suggest.ts';
import { dartStringValue } from './appearance.ts';
import {
	byKey,
	type ConfigElement,
	type ConfigValue,
	type Field,
	type SchemaField,
} from './config-schema.ts';
import { dartString } from './create.ts';
import { writeDart } from './dart-file.ts';
import {
	addImportLine,
	appendElement,
	closingBracket,
	codeOnly,
	elements,
	onlyMatch,
	removeArgumentAt,
	removeElement,
	setArgumentAt,
} from './main-dart.ts';

/**
 * Every setting of `SmartifyOs().init` that is plain data, read from and written into a car's
 * `lib/main.dart` by its key: `car.model3D.scale`, `bluetooth.autoConnect`,
 * `infoDisplay.views[1].small`.
 *
 * The key is the path of named arguments from `SmartifyOs().init` down to the setting, so the
 * one place a setting goes is always known. Like everything the CLI writes into Dart, a value is
 * only read where it is written the way the CLI would write it: a config handed over as a
 * variable (`can: miataCan`) or a value worked out in code is reported as code, never guessed
 * at, and a change that would have to go inside it is handed back as the line to add by hand.
 *
 * What the car looks like on the whole (layout, theme, driver's side, what is in the bar, the
 * files of the car) and its About page are `appearance.ts`, since they come with files to copy
 * and change live in the running app.
 */

export type {
	ConfigElement,
	ConfigValue,
	Field,
	FieldType,
	SchemaField,
} from './config-schema.ts';

/** How a car's app is set up, as its `lib/main.dart` says. */
export interface ConfigReport {
	/** Everything that is written and can be read, by key. Anything else is its default. */
	values: Record<string, ConfigValue>;
	/** Everything written as code the CLI cannot read, by key, with the line it is on. */
	code: Record<string, { code: string; line: number }>;
	/** Where each config that is written starts in `lib/main.dart`, from 1, by key. */
	lines: Record<string, number>;
}

/** Every setting the command knows, as it reports them. */
export function configFields(): Field[] {
	// A section's fields are listed under their own keys, a list's are what each element has.
	const plain = (field: SchemaField): Field => {
		const { imports: _imports, comment: _comment, fields, ...rest } = field;
		return field.type === 'list' && fields ? { ...rest, fields: fields.map(plain) } : rest;
	};
	return [...byKey.values()].map(plain);
}

/** Internal: one step of a key, `rollingWheels[2]`. */
interface Segment {
	name: string;
	index?: number;
}

/** Internal: a key as its steps. */
function segments(key: string): Segment[] {
	return key.split('.').map((part) => {
		const match = /^([A-Za-z_]\w*)(?:\[(\d+)\])?$/.exec(part);
		if (!match) throw unknownKey(key);
		return { name: match[1] ?? '', ...(match[2] !== undefined ? { index: Number(match[2]) } : {}) };
	});
}

/**
 * The field a key names, and the field of a list's element it goes on into, if it does:
 * `infoDisplay.views[1].small` is the field `small` of the list `infoDisplay.views`.
 */
export function fieldFor(key: string): { field: SchemaField; list?: SchemaField } {
	const steps = segments(key);
	const listAt = steps.findIndex((step) => step.index !== undefined);
	if (listAt === -1) {
		const field = byKey.get(key);
		if (!field) throw unknownKey(key);
		return { field };
	}
	const listKey = steps
		.slice(0, listAt + 1)
		.map((step) => step.name)
		.join('.');
	const list = byKey.get(listKey);
	if (list?.type !== 'list') throw unknownKey(key);
	if (listAt === steps.length - 1) return { field: list, list };
	const rest = steps.slice(listAt + 1);
	const field =
		rest.length === 1 ? list.fields?.find((known) => known.key === rest[0]?.name) : undefined;
	if (!field) throw unknownKey(key);
	return { field, list };
}

function unknownKey(key: string): CliError {
	const plain = key.replace(/\[\d+\]/g, '');
	const guess = closest(plain, [...byKey.keys()]);
	return new CliError(`There is no setting called ${key}.`, {
		hint: guess
			? `Did you mean ${guess}? Every setting is listed by config --list.`
			: 'Every setting is listed by config --list.',
	});
}

const initCall = /\bSmartifyOs\s*\(\s*\)\s*\.\s*init\s*\(/;

/** Internal: the source, and the same with comments and strings blanked, for finding things. */
export interface Text {
	source: string;
	/** Comments and strings blanked, for the shape of the code. */
	code: string;
	/** Comments blanked and strings kept, for reading values. */
	values: string;
}

export function textOf(source: string): Text {
	return { source, code: codeOnly(source), values: codeOnly(source, { keepStrings: true }) };
}

export function lineOf(source: string, index: number): number {
	return source.slice(0, index).split('\n').length;
}

/** Internal: the call an expression is, the whole of it: `const Name(...)`, `Name.named<T>(...)`. */
export function callIn(
	code: string,
	start: number,
	end: number,
	className?: string,
): { open: number; constant: boolean } | undefined {
	const match = /^(const\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*(?:<[^()]*>\s*)?\(/.exec(
		code.slice(start, end),
	);
	if (!match || (className && match[2] !== className)) return undefined;
	const open = start + match[0].length - 1;
	if (closingBracket(code, open) !== end - 1) return undefined;
	return { open, constant: Boolean(match[1]) };
}

/** Internal: the list or set literal an expression is, the whole of it. */
export function collectionIn(
	code: string,
	start: number,
	end: number,
	bracket: '[' | '{',
): { open: number; constant: boolean } | undefined {
	const pattern =
		bracket === '[' ? /^(const\s+)?(?:<[^[\]]*>\s*)?\[/ : /^(const\s+)?(?:<[^{}]*>\s*)?\{/;
	const match = pattern.exec(code.slice(start, end));
	if (!match) return undefined;
	const open = start + match[0].length - 1;
	if (closingBracket(code, open) !== end - 1) return undefined;
	return { open, constant: Boolean(match[1]) };
}

/** Internal: where the value of a named argument of the call at `open` is. */
export function argumentAt(
	code: string,
	open: number,
	name: string,
): { start: number; end: number } | undefined {
	const close = closingBracket(code, open);
	if (close === -1) return undefined;
	const item = elements(code, open, close).find((found) =>
		new RegExp(`^${name}\\s*:`).test(code.slice(found.start, found.end)),
	);
	if (!item) return undefined;
	const colon = code.indexOf(':', item.start);
	const value = code.slice(colon + 1, item.end);
	const lead = value.length - value.trimStart().length;
	return { start: colon + 1 + lead, end: item.end };
}

/** Internal: where a key leads in `lib/main.dart`. */
type Place =
	/** It is written: where its value is, and the call it is an argument of. */
	| { kind: 'found'; start: number; end: number; container: number; constant: boolean }
	/**
	 * It is not written: the deepest call on the way that is, and how many steps of the key are
	 * in it already.
	 */
	| { kind: 'missing'; open: number; constant: boolean; depth: number }
	/** Something on the way is written as code: the step it is, and where. */
	| { kind: 'code'; depth: number; start: number; end: number }
	/** There is no `SmartifyOs().init` to be found, or no such element in a list. */
	| { kind: 'none' };

/** Internal: follows a key from `SmartifyOs().init` to its value. */
function locate(text: Text, steps: Segment[]): Place {
	const { code } = text;
	const init = onlyMatch(code, initCall);
	if (!init) return { kind: 'none' };
	let open = init.index + init[0].length - 1;
	let constant = false;
	let key = '';

	for (let depth = 0; depth < steps.length; depth++) {
		const step = steps[depth] as Segment;
		key = key ? `${key}.${step.name}` : step.name;
		const argument = argumentAt(code, open, step.name);
		if (!argument) return { kind: 'missing', open, constant, depth };
		let { start, end } = argument;
		let inside: boolean = constant;

		if (step.index !== undefined) {
			const list = collectionIn(code, start, end, '[');
			if (!list) return { kind: 'code', depth, start, end };
			inside ||= list.constant;
			const item = elements(code, list.open, closingBracket(code, list.open))[step.index];
			if (!item) return { kind: 'none' };
			start = item.start;
			end = item.end;
		}

		if (depth === steps.length - 1) return { kind: 'found', start, end, container: open, constant };

		// A list's field names the class of its elements.
		const call = callIn(code, start, end, byKey.get(key)?.className);
		if (!call) return { kind: 'code', depth, start, end };
		open = call.open;
		constant = inside || call.constant;
	}
	return { kind: 'none' };
}

/** Internal: a value as written, comments left out and its lines joined. */
export function written(text: Text, start: number, end: number): string {
	return text.values
		.slice(start, end)
		.replace(/[ \t]+$/gm, '')
		.trim();
}

// Reading values.

const numberPattern = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** Internal: a constant of `prefix` as the id it stands for, or a string literal's text. */
function idOf(field: SchemaField, value: string): string | undefined {
	if (field.prefix && field.constants) {
		const name = new RegExp(`^${field.prefix}\\.([A-Za-z_]\\w*)$`).exec(value)?.[1];
		if (name !== undefined) return field.constants[name];
	}
	return dartStringValue(value);
}

/** Internal: the numbers inside `Name(1, 2.5, -3)`, when there are `count` of them and nothing else. */
function numbersOf(value: string, name: string, count: number): number[] | undefined {
	const match = new RegExp(`^(?:const\\s+)?${name}\\s*\\(([^()]*)\\)$`).exec(value);
	if (!match) return undefined;
	const parts = (match[1] ?? '')
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean);
	if (parts.length !== count || !parts.every((part) => numberPattern.test(part))) return undefined;
	return parts.map(Number);
}

const durationUnits: Record<string, number> = {
	days: 86_400_000,
	hours: 3_600_000,
	minutes: 60_000,
	seconds: 1000,
	milliseconds: 1,
	microseconds: 0.001,
};

/** Internal: a value as written, read by what it is, or undefined when it cannot be. */
export function parseWritten(field: SchemaField, value: string): ConfigValue | undefined {
	if (value === 'null' && (field.nullable || field.default === null)) return null;
	switch (field.type) {
		case 'bool':
			return value === 'true' ? true : value === 'false' ? false : undefined;
		case 'number':
		case 'integer': {
			if (!numberPattern.test(value)) return undefined;
			return Number(value);
		}
		case 'string':
			return idOf(field, value);
		case 'enum': {
			const name = new RegExp(`^${field.prefix}\\.([A-Za-z_]\\w*)$`).exec(value)?.[1];
			return name !== undefined && field.values?.includes(name) ? name : undefined;
		}
		case 'duration': {
			if (/^(?:const\s+)?Duration\.zero$/.test(value)) return 0;
			const match = /^(?:const\s+)?Duration\s*\(([^()]*)\)$/.exec(value);
			if (!match) return undefined;
			let total = 0;
			for (const part of (match[1] ?? '').split(',').map((piece) => piece.trim())) {
				if (!part) continue;
				const unit = /^(\w+)\s*:\s*(\S+)$/.exec(part);
				const factor = unit ? durationUnits[unit[1] ?? ''] : undefined;
				if (!unit || factor === undefined || !numberPattern.test(unit[2] ?? '')) return undefined;
				total += Number(unit[2]) * factor;
			}
			return Math.round(total);
		}
		case 'color': {
			const hex = /^(?:const\s+)?Color\s*\(\s*0x([0-9a-fA-F]{8})\s*\)$/.exec(value)?.[1];
			return hex ? `#${hex.toUpperCase()}` : undefined;
		}
		case 'offset3d': {
			const numbers = numbersOf(value, 'Offset3D', 3);
			return numbers ? { x: numbers[0] ?? 0, y: numbers[1] ?? 0, z: numbers[2] ?? 0 } : undefined;
		}
		case 'size': {
			const numbers = numbersOf(value, 'Size', 2);
			return numbers ? { width: numbers[0] ?? 0, height: numbers[1] ?? 0 } : undefined;
		}
		default:
			return undefined;
	}
}

/** Internal: a list or set of ids as written, or undefined for anything fancier. */
/** An integer literal, decimal or hex. */
const integerPattern = /^(?:-?\d+|0[xX][0-9a-fA-F]+)$/;

/** Internal: one element of a list of ids as written, a number kept as it is written. */
function itemOf(field: SchemaField, value: string): string | undefined {
	if (field.itemType === 'integer') return integerPattern.test(value) ? value : undefined;
	return idOf(field, value);
}

/** One element of a list of ids as Dart: a number as it is, a name as its constant or a string. */
export function dartItem(field: SchemaField, item: string): string {
	return field.itemType === 'integer' ? item : dartId(field, item);
}

export function readIds(
	text: Text,
	field: SchemaField,
	start: number,
	end: number,
): string[] | undefined {
	const literal =
		collectionIn(text.code, start, end, field.set ? '{' : '[') ??
		(field.set ? undefined : collectionIn(text.code, start, end, '{'));
	if (!literal) return undefined;
	const close = closingBracket(text.code, literal.open);
	const found: string[] = [];
	for (const item of elements(text.code, literal.open, close)) {
		const id = itemOf(field, written(text, item.start, item.end));
		if (id === undefined) return undefined;
		found.push(id);
	}
	return found;
}

/** Internal: one element of a list of configs. */
function readElement(text: Text, list: SchemaField, start: number, end: number): ConfigElement {
	const element: ConfigElement = { line: lineOf(text.source, start), values: {}, code: {} };
	const call = callIn(text.code, start, end, list.className);
	if (!call) {
		element.asCode = written(text, start, end);
		return element;
	}
	for (const field of list.fields ?? []) {
		const argument = argumentAt(text.code, call.open, field.key);
		if (!argument) continue;
		const value = written(text, argument.start, argument.end);
		const parsed = field.type === 'code' ? undefined : parseWritten(field, value);
		if (parsed === undefined) element.code[field.key] = value;
		else element.values[field.key] = parsed;
	}
	return element;
}

/** Reads every setting this knows from a car's `lib/main.dart`. */
export function readConfig(source: string): ConfigReport {
	const text = textOf(source);
	const report: ConfigReport = { values: {}, code: {}, lines: {} };

	for (const [key, field] of byKey) {
		const steps = segments(key);
		const place = locate(text, steps);
		if (place.kind === 'none' || place.kind === 'missing') continue;
		if (place.kind === 'code') {
			// Reported once, under the key of what is written as code.
			const at = steps
				.slice(0, place.depth + 1)
				.map((step) => step.name)
				.join('.');
			report.code[at] ??= {
				code: written(text, place.start, place.end),
				line: lineOf(source, place.start),
			};
			continue;
		}

		const value = written(text, place.start, place.end);
		const line = lineOf(source, place.start);
		if (field.type === 'section') {
			if (callIn(text.code, place.start, place.end, field.className)) {
				report.values[key] = true;
				report.lines[key] = line;
			} else if (value === 'null') report.values[key] = false;
			else report.code[key] = { code: value, line };
			continue;
		}
		if (field.type === 'list') {
			const list = collectionIn(text.code, place.start, place.end, '[');
			if (!list) {
				report.code[key] = { code: value, line };
				continue;
			}
			const close = closingBracket(text.code, list.open);
			report.values[key] = elements(text.code, list.open, close).map((item) =>
				readElement(text, field, item.start, item.end),
			);
			report.lines[key] = line;
			continue;
		}
		const parsed =
			field.type === 'code'
				? undefined
				: field.type === 'ids'
					? readIds(text, field, place.start, place.end)
					: parseWritten(field, value);
		if (parsed === undefined) report.code[key] = { code: value, line };
		else report.values[key] = parsed;
	}
	return report;
}

// Taking values from the command line.

const truthy = new Set(['true', 'on', 'yes']);
const falsy = new Set(['false', 'off', 'no']);

function badValue(key: string, value: string, hint: string): CliError {
	return new CliError(`"${value}" cannot be ${key}.`, { hint });
}

/**
 * A value as typed on the command line, checked: `0.7`, `on`, `3s`, `#F5C542`, `0,180,0`,
 * `1024x600`, `a,b,c`, `none` for nothing where nothing means something, or JSON.
 */
export function parseValue(field: SchemaField, key: string, value: unknown): ConfigValue {
	if (typeof value !== 'string') return checkValue(field, key, value);
	const typed = value.trim();
	if (
		typed === 'none' &&
		(field.nullable || (field.default === null && field.type !== 'section'))
	) {
		if (field.type === 'section' || field.type === 'list' || field.type === 'ids') {
			throw badValue(key, typed, `Take it out with --unset ${key} instead.`);
		}
		return null;
	}

	switch (field.type) {
		case 'bool':
			if (truthy.has(typed)) return true;
			if (falsy.has(typed)) return false;
			throw badValue(key, typed, 'Use on or off.');
		case 'number':
		case 'integer': {
			const parsed = Number(typed);
			if (typed === '' || !Number.isFinite(parsed)) throw badValue(key, typed, 'Use a number.');
			if (field.type === 'integer' && !Number.isInteger(parsed)) {
				throw badValue(key, typed, 'Use a whole number.');
			}
			return parsed;
		}
		case 'string':
			return typed;
		case 'enum':
			if (field.values?.includes(typed)) return typed;
			throw badValue(key, typed, `Use one of ${field.values?.join(', ')}.`);
		case 'duration': {
			const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|min|h)?$/.exec(typed);
			if (!match) throw badValue(key, typed, 'Use a time like 3s, 500ms or 2m.');
			const factor =
				{ ms: 1, s: 1000, m: 60_000, min: 60_000, h: 3_600_000 }[match[2] ?? 's'] ?? 1000;
			return Math.round(Number(match[1]) * factor);
		}
		case 'color': {
			const hex = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(typed)?.[1];
			if (!hex) throw badValue(key, typed, 'Use a colour like #F5C542.');
			return `#${(hex.length === 6 ? `FF${hex}` : hex).toUpperCase()}`;
		}
		case 'offset3d': {
			if (typed.startsWith('{')) return checkValue(field, key, json(key, typed));
			const parts = typed.split(/[\s,]+/).map(Number);
			if (parts.length !== 3 || !parts.every(Number.isFinite)) {
				throw badValue(key, typed, 'Use three numbers, x,y,z, like 0,180,0.');
			}
			return { x: parts[0] ?? 0, y: parts[1] ?? 0, z: parts[2] ?? 0 };
		}
		case 'size': {
			if (typed.startsWith('{')) return checkValue(field, key, json(key, typed));
			const match = /^(\d+(?:\.\d+)?)\s*[x,\s]\s*(\d+(?:\.\d+)?)$/.exec(typed);
			if (!match) throw badValue(key, typed, 'Use a width and height, like 1024x600.');
			return { width: Number(match[1]), height: Number(match[2]) };
		}
		case 'ids':
			if (typed.startsWith('[')) return checkValue(field, key, json(key, typed));
			return checkItems(
				field,
				key,
				typed
					.split(',')
					.map((id) => id.trim())
					.filter(Boolean),
			);
		case 'section':
			if (truthy.has(typed)) return true;
			if (typed.startsWith('{')) return checkValue(field, key, json(key, typed));
			throw badValue(
				key,
				typed,
				`Use on, or the settings in it as JSON. --unset ${key} takes it out.`,
			);
		case 'list':
			return checkValue(field, key, json(key, typed));
		case 'object':
		case 'array':
		case 'map':
		case 'code':
			throw new CliError(`${key} can only be written as code.`, {
				hint: "Write it into lib/main.dart, in your car's app.",
			});
	}
}

/** Internal: the elements of a list of ids, checked: names, or whole numbers when it holds them. */
function checkItems(field: SchemaField, key: string, items: unknown[]): string[] {
	for (const item of items) {
		if (typeof item !== 'string' || !item) throw badValue(key, String(item), 'Give names.');
		if (field.itemType === 'integer' && !integerPattern.test(item)) {
			throw badValue(key, item, 'Give whole numbers, like 6353 or 0x18d1.');
		}
	}
	return items as string[];
}

function json(key: string, value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		throw badValue(key, value, 'It looks like JSON, but it is not.');
	}
}

/** Internal: a value that came as JSON, checked against what the field is. */
function checkValue(field: SchemaField, key: string, value: unknown): ConfigValue {
	const fail = () => badValue(key, JSON.stringify(value), `It has to be ${describeType(field)}.`);
	if (value === null) {
		if (field.nullable || (field.default === null && field.type !== 'section')) return null;
		throw fail();
	}
	switch (field.type) {
		case 'bool':
			if (typeof value !== 'boolean') throw fail();
			return value;
		case 'number':
		case 'integer':
			if (typeof value !== 'number' || !Number.isFinite(value)) throw fail();
			if (field.type === 'integer' && !Number.isInteger(value)) throw fail();
			return value;
		case 'duration':
			if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw fail();
			return Math.round(value);
		case 'offset3d': {
			const point = value as Record<string, unknown>;
			if (![point.x, point.y, point.z].every((n) => typeof n === 'number' && Number.isFinite(n))) {
				throw fail();
			}
			return { x: point.x as number, y: point.y as number, z: point.z as number };
		}
		case 'size': {
			const size = value as Record<string, unknown>;
			if (![size.width, size.height].every((n) => typeof n === 'number' && n > 0)) throw fail();
			return { width: size.width as number, height: size.height as number };
		}
		case 'ids':
			if (!Array.isArray(value)) throw fail();
			return checkItems(
				field,
				key,
				value.map((id) => (typeof id === 'number' ? String(id) : id)),
			);
		case 'section':
		case 'list':
			if (value === true && field.type === 'section') return true;
			if (field.type === 'list') {
				if (!Array.isArray(value)) throw fail();
				for (const element of value) checkObject(field, key, element);
				return value as ConfigElement[];
			}
			checkObject(field, key, value);
			return value as unknown as ConfigValue;
		default:
			if (typeof value === 'string') return parseValue(field, key, value);
			throw fail();
	}
}

/** Internal: the settings of a config or element given as an object, each checked in place. */
function checkObject(field: SchemaField, key: string, value: unknown): Record<string, ConfigValue> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw badValue(key, JSON.stringify(value), 'Give its settings as a JSON object.');
	}
	const object = value as Record<string, unknown>;
	for (const [name, inner] of Object.entries(object)) {
		const known = field.fields?.find((candidate) => candidate.key === name);
		if (!known || known.type === 'section' || known.type === 'list') {
			throw new CliError(
				`${field.className} has no setting called ${name} the command can write.`,
				{
					hint: `It can write ${field.fields
						?.filter((candidate) => !['section', 'list', 'code'].includes(candidate.type))
						.map((candidate) => candidate.key)
						.join(', ')}.`,
				},
			);
		}
		object[name] = parseValue(known, `${key}.${name}`, inner);
	}
	return object as Record<string, ConfigValue>;
}

function describeType(field: SchemaField): string {
	switch (field.type) {
		case 'bool':
			return 'true or false';
		case 'number':
			return 'a number';
		case 'integer':
			return 'a whole number';
		case 'duration':
			return 'milliseconds';
		case 'offset3d':
			return '{"x", "y", "z"}';
		case 'size':
			return '{"width", "height"}';
		case 'ids':
			return 'a list of names';
		case 'list':
			return 'a list of objects';
		case 'section':
			return 'an object';
		default:
			return 'a string';
	}
}

// Writing values as Dart.

/** Internal: a number as Dart writes it. */
function dartNumber(value: number): string {
	return String(Number(value.toPrecision(12)));
}

/** Internal: an id as its constant when there is one, otherwise as a string. */
function dartId(field: SchemaField, id: string): string {
	const name = Object.entries(field.constants ?? {}).find(([, known]) => known === id)?.[0];
	return name !== undefined && field.prefix ? `${field.prefix}.${name}` : dartString(id);
}

/** Internal: a call or collection, `const` in front unless it is in a const one already. */
const asConst = (written: string, inConst: boolean) => (inConst ? written : `const ${written}`);

/**
 * Internal: a value as Dart, and the libraries it needs. `inConst` says whether it goes inside
 * something const already, which decides whether it says `const` itself.
 */
export function dartValue(
	field: SchemaField,
	value: ConfigValue,
	inConst: boolean,
	imports: string[][],
): string {
	const need = (libraries: string[] | undefined) => {
		if (libraries) imports.push(libraries);
	};
	if (value === null) return 'null';
	switch (field.type) {
		case 'bool':
		case 'number':
		case 'integer':
			return typeof value === 'number' ? dartNumber(value) : String(value);
		case 'string': {
			const id = value as string;
			if (field.constants && Object.values(field.constants).includes(id)) need(field.imports);
			return dartId(field, id);
		}
		case 'enum':
			need(field.imports);
			return `${field.prefix}.${value}`;
		case 'duration': {
			const ms = value as number;
			if (ms === 0) return 'Duration.zero';
			if (ms % 60_000 === 0) return asConst(`Duration(minutes: ${ms / 60_000})`, inConst);
			if (ms % 1000 === 0) return asConst(`Duration(seconds: ${ms / 1000})`, inConst);
			return asConst(`Duration(milliseconds: ${ms})`, inConst);
		}
		case 'color':
			need(field.imports);
			return asConst(`Color(0x${(value as string).slice(1)})`, inConst);
		case 'offset3d': {
			need(field.imports);
			const { x, y, z } = value as { x: number; y: number; z: number };
			return asConst(`Offset3D(${[x, y, z].map(dartNumber).join(', ')})`, inConst);
		}
		case 'size': {
			need(field.imports);
			const { width, height } = value as { width: number; height: number };
			return asConst(`Size(${dartNumber(width)}, ${dartNumber(height)})`, inConst);
		}
		case 'ids': {
			const list = value as string[];
			if (list.some((id) => Object.values(field.constants ?? {}).includes(id))) need(field.imports);
			const items = list.map((id) => dartItem(field, id)).join(', ');
			return asConst(field.set ? `{${items}}` : `[${items}]`, inConst);
		}
		case 'list': {
			need(field.imports);
			const items = (value as unknown as Record<string, ConfigValue>[]).map((element) =>
				dartCall(field, element, true, imports),
			);
			return asConst(`[${items.join(', ')}]`, inConst);
		}
		case 'section':
			need(field.imports);
			return dartCall(
				field,
				value === true ? {} : (value as unknown as Record<string, ConfigValue>),
				inConst,
				imports,
			);
		default:
			throw new CliError(`${field.key} can only be written as code.`);
	}
}

/** Internal: a config or element made with the given settings, checking what it has to have. */
function dartCall(
	field: SchemaField,
	settings: Record<string, ConfigValue>,
	inConst: boolean,
	imports: string[][],
): string {
	const missing = (field.fields ?? []).filter(
		(inner) => inner.required && settings[inner.key] == null,
	);
	if (missing.length > 0) {
		throw new CliError(
			`A new ${field.className} needs ${missing.map((inner) => inner.key).join(' and ')}.`,
			{
				hint:
					field.className === 'CarImageConfig'
						? 'Give the car a picture first, with appearance --picture.'
						: `Give ${missing.length === 1 ? 'it' : 'them'} too, as JSON: {"${missing[0]?.key}": "..."}.`,
			},
		);
	}
	const args = Object.entries(settings).map(([name, inner]) => {
		const known = field.fields?.find((candidate) => candidate.key === name) as SchemaField;
		return `${name}: ${dartValue(known, inner, true, imports)}`;
	});
	return asConst(`${field.className}(${args.join(', ')})`, inConst);
}

// Changing `lib/main.dart`.

/** One change, as the command takes them. */
export type ConfigChange =
	| { op: 'set'; key: string; value: ConfigValue }
	| { op: 'unset'; key: string }
	/** Puts an element at the end of a list, or an id into a list of ids. */
	| { op: 'add'; key: string; value: ConfigValue }
	/** Takes an element out by its place, `key[2]`, or an id out of a list of ids. */
	| { op: 'remove'; key: string; id?: string }
	/** Moves `key[2]` to another place in its list. */
	| { op: 'move'; key: string; to: number };

/** Internal: what one change did. */
interface Applied {
	source: string;
	/** The line to add by hand, when it has no clear place. */
	manual?: string;
}

function keyOf(steps: Segment[]): string {
	return steps
		.map((step) => (step.index === undefined ? step.name : `${step.name}[${step.index}]`))
		.join('.');
}

/** Internal: adds the imports a change needs, unless any library giving the same is there. */
export function withImports(source: string, imports: string[][]): string {
	let result = source;
	for (const libraries of imports) {
		if (libraries.some((library) => result.includes(`import '${library}'`))) continue;
		const first = libraries[0];
		if (first) result = addImportLine(result, `import '${first}';`);
	}
	return result;
}

/** Internal: the field a step of a key is, from its whole key so far. */
function fieldAt(steps: Segment[], depth: number): SchemaField | undefined {
	const key = steps
		.slice(0, depth + 1)
		.map((step) => step.name)
		.join('.');
	return byKey.get(key);
}

/** Internal: the text to write, in place of the code, for a manual line. */
function manualLine(key: string, value: string): string {
	return `${key}: ${value}`;
}

/** Internal: sets one value, making the configs on the way to it when they are not there. */
function setValue(source: string, key: string, value: ConfigValue): Applied {
	const { field } = fieldFor(key);
	const steps = segments(key);
	const text = textOf(source);
	const place = locate(text, steps);
	const imports: string[][] = [];

	if (place.kind === 'none') {
		if (!onlyMatch(text.code, initCall)) {
			return { source, manual: manualLine(key, dartValue(field, value, false, [])) };
		}
		throw new CliError(`There is no ${key} in lib/main.dart.`, {
			hint: 'Look at what is there with config --json.',
		});
	}
	if (place.kind === 'code') {
		const at = keyOf(steps.slice(0, place.depth + 1));
		return {
			source,
			manual: `${manualLine(key, dartValue(field, value, false, []))} (${at} is written as code)`,
		};
	}

	if (place.kind === 'found') {
		if (field.type === 'section' && value !== null) {
			const call = callIn(text.code, place.start, place.end, field.className);
			if (call) {
				// It is there: each setting goes into it.
				let result = source;
				for (const [name, inner] of Object.entries(value === true ? {} : (value as object))) {
					const applied = setValue(result, `${key}.${name}`, inner as ConfigValue);
					if (applied.manual) return applied;
					result = applied.source;
				}
				return { source: result };
			}
			if (written(text, place.start, place.end) !== 'null') {
				return { source, manual: `${key} is written as code, so change it by hand` };
			}
		}
		const dart = dartValue(field, value, place.constant, imports);
		const edited = `${source.slice(0, place.start)}${dart}${source.slice(place.end)}`;
		return { source: withImports(edited, imports) };
	}

	// Missing: the rest of the way is made, inside out, and put into the deepest call there is.
	const rest = steps.slice(place.depth);
	if (rest.some((step) => step.index !== undefined)) {
		throw new CliError(`There is no ${key} in lib/main.dart.`, {
			hint: `Add it to ${keyOf(steps.slice(0, steps.findIndex((step) => step.index !== undefined) + 1)).replace(/\[\d+\]$/, '')} with --add first.`,
		});
	}
	const inside = place.depth === 0 ? false : place.constant;
	let dart = '';
	for (let depth = steps.length - 1; depth >= place.depth; depth--) {
		const outermost = depth === place.depth;
		const inConst = outermost ? inside : true;
		if (depth === steps.length - 1) {
			dart = dartValue(field, value, inConst, imports);
			continue;
		}
		const section = fieldAt(steps, depth) as SchemaField;
		const step = steps[depth + 1] as Segment;
		dart = dartCallWith(section, step.name, dart, inConst, imports);
	}

	const name = (steps[place.depth] as Segment).name;
	const top = place.depth === 0 ? fieldAt(steps, 0) : undefined;
	const edited = setArgumentAt(source, place.open, name, dart, {
		...(place.depth === 0 ? { before: 'extensions' } : {}),
		...(top?.comment ? { comment: top.comment } : {}),
	});
	if (edited === undefined) return { source, manual: manualLine(key, dart) };
	return { source: withImports(edited, imports) };
}

/** Internal: a config made with one argument already written as Dart. */
function dartCallWith(
	section: SchemaField,
	name: string,
	argument: string,
	inConst: boolean,
	imports: string[][],
): string {
	const missing = (section.fields ?? []).filter((inner) => inner.required && inner.key !== name);
	if (missing.length > 0) {
		throw new CliError(
			`A new ${section.className} needs ${missing.map((inner) => inner.key).join(' and ')}.`,
			{
				hint:
					section.className === 'CarImageConfig'
						? 'Give the car a picture first, with appearance --picture.'
						: 'Make it first, with all of them, as JSON.',
			},
		);
	}
	if (section.imports) imports.push(section.imports);
	return asConst(`${section.className}(${name}: ${argument})`, inConst);
}

/** Internal: takes a value out, so SmartifyOS's default is used again. */
function unsetValue(source: string, key: string): Applied {
	const { field, list } = fieldFor(key);
	if (list === field) {
		throw new CliError(`${key} is an element of a list.`, {
			hint: `Take it out with --remove ${key}.`,
		});
	}
	const text = textOf(source);
	const place = locate(text, segments(key));
	if (place.kind === 'missing' || place.kind === 'none') return { source };
	if (place.kind === 'code') return { source, manual: `take ${key} out` };
	const edited = removeArgumentAt(source, place.container, (segments(key).pop() as Segment).name);
	return edited === undefined ? { source, manual: `take ${key} out` } : { source: edited };
}

/** Internal: where a list is, as a literal. */
function listAt(
	text: Text,
	key: string,
	field: SchemaField,
): { open: number; constant: boolean } | 'missing' | 'code' {
	const place = locate(text, segments(key));
	if (place.kind === 'missing') return 'missing';
	if (place.kind !== 'found') return 'code';
	const bracket = field.type === 'ids' && field.set ? '{' : '[';
	const literal =
		collectionIn(text.code, place.start, place.end, bracket) ??
		(bracket === '[' && field.type === 'ids'
			? collectionIn(text.code, place.start, place.end, '{')
			: undefined);
	return literal ? { open: literal.open, constant: literal.constant || place.constant } : 'code';
}

/** Internal: puts an element at the end of a list. */
function addElement(source: string, key: string, value: ConfigValue): Applied {
	const { field } = fieldFor(key);
	if (field.type !== 'list' && field.type !== 'ids') {
		throw new CliError(`${key} is not a list.`, { hint: `Set it with --set ${key}=...` });
	}
	const text = textOf(source);
	const list = listAt(text, key, field);
	if (list === 'missing') {
		const whole = field.type === 'ids' ? [value as string] : [value as unknown as ConfigElement];
		return setValue(source, key, whole as ConfigValue);
	}
	const imports: string[][] = [];
	const element =
		field.type === 'ids'
			? dartValue({ ...field, type: 'string' }, value, true, imports)
			: dartCall(
					field,
					value as unknown as Record<string, ConfigValue>,
					list !== 'code' && list.constant,
					imports,
				);
	if (list === 'code') return { source, manual: `${element} in ${key}` };
	if (field.type === 'ids') {
		const close = closingBracket(text.code, list.open);
		const known = elements(text.code, list.open, close).map((item) =>
			idOf(field, written(text, item.start, item.end)),
		);
		if (known.includes(value as string)) return { source };
	}
	if (field.type === 'list' && field.imports) imports.push(field.imports);
	return { source: withImports(appendElement(source, text.code, list.open, element), imports) };
}

/** Internal: takes an element out, by its place or by its id, and the list when it is empty. */
function removeFrom(source: string, key: string, id: string | undefined): Applied {
	const steps = segments(key);
	const last = steps[steps.length - 1] as Segment;
	const index = last.index;
	const listKey = keyOf([...steps.slice(0, -1), { name: last.name }]);
	const { field } = fieldFor(listKey);
	if (index === undefined && id === undefined) {
		throw new CliError(`Say which element of ${key} to take out.`, {
			hint: `Use --remove ${key}[0] for the first, or --remove ${key}=name for a name in it.`,
		});
	}
	const text = textOf(source);
	const list = listAt(text, listKey, field);
	if (list === 'missing') return { source };
	if (list === 'code')
		return { source, manual: `take ${id ?? `element ${index}`} out of ${listKey}` };

	const items = elements(text.code, list.open, closingBracket(text.code, list.open));
	const target =
		index ?? items.findIndex((item) => idOf(field, written(text, item.start, item.end)) === id);
	let at = 0;
	const edited = removeElement(source, text.code, list.open, () => at++ === target);
	if (edited === source) return { source };

	// An empty list says nothing the default does not, so it goes too.
	const after = textOf(edited);
	const left = listAt(after, listKey, field);
	if (left !== 'missing' && left !== 'code') {
		const close = closingBracket(after.code, left.open);
		if (elements(after.code, left.open, close).length === 0) {
			const place = locate(after, segments(listKey));
			if (place.kind === 'found') {
				const without = removeArgumentAt(edited, place.container, last.name);
				if (without !== undefined) return { source: without };
			}
		}
	}
	return { source: edited };
}

/** Internal: moves an element to another place in its list, one step at a time. */
function moveElement(source: string, key: string, to: number): Applied {
	const steps = segments(key);
	const last = steps[steps.length - 1] as Segment;
	if (last.index === undefined) {
		throw new CliError(`Say which element of ${key} to move.`, { hint: `Use --move ${key}[2]=0.` });
	}
	const listKey = keyOf([...steps.slice(0, -1), { name: last.name }]);
	const { field } = fieldFor(listKey);
	let result = source;
	let from = last.index;
	while (from !== to) {
		const text = textOf(result);
		const list = listAt(text, listKey, field);
		if (list === 'missing') return { source };
		if (list === 'code')
			return { source, manual: `move element ${last.index} of ${listKey} to ${to}` };
		const items = elements(text.code, list.open, closingBracket(text.code, list.open));
		const other = to < from ? from - 1 : from + 1;
		const a = items[Math.min(from, other)];
		const b = items[Math.max(from, other)];
		if (!a || !b) break;
		result = `${result.slice(0, a.start)}${result.slice(b.start, b.end)}${result.slice(a.end, b.start)}${result.slice(a.start, a.end)}${result.slice(b.end)}`;
		from = other;
	}
	return { source: result };
}

/**
 * Writes changes into the source of `lib/main.dart`, one after the other.
 *
 * @returns the new source, and every change that has no clear place, as the line to add by hand.
 */
export function setConfig(
	source: string,
	changes: ConfigChange[],
): { source: string; manual: string[] } {
	let result = source;
	const manual: string[] = [];
	for (const change of changes) {
		const applied =
			change.op === 'set'
				? setValue(result, change.key, change.value)
				: change.op === 'unset'
					? unsetValue(result, change.key)
					: change.op === 'add'
						? addElement(result, change.key, change.value)
						: change.op === 'remove'
							? removeFrom(result, change.key, change.id)
							: moveElement(result, change.key, change.to);
		result = applied.source;
		if (applied.manual) manual.push(applied.manual);
	}
	return { source: result, manual };
}

/** What {@link changeConfig} did. */
export interface ConfigChanged extends ConfigReport {
	changed: boolean;
	/** Every change that has to be made by hand, as the line to add. */
	manual: string[];
}

/**
 * Changes how the car's app is set up in its `lib/main.dart`, formatted afterwards. A running app only has it after a restart, since `SmartifyOs().init`
 * reads it.
 */
export async function changeConfig(
	appDir: string,
	changes: ConfigChange[],
): Promise<ConfigChanged> {
	const mainPath = join(appDir, 'lib', 'main.dart');
	const before = await Bun.file(mainPath).text();
	const { source, manual } = setConfig(before, changes);
	await writeDart(mainPath, before, source);
	const after = await Bun.file(mainPath).text();
	return { changed: after !== before, manual, ...readConfig(after) };
}
