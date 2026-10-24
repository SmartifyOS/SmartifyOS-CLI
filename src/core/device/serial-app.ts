import { existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { analyzeErrors, packageConfigPath } from '../flutter.ts';
import { formatDart } from '../project/dart-file.ts';
import {
	addImportLine,
	appendElement,
	closingBracket,
	codeOnly,
	onlyMatch,
	setArgumentAt,
} from '../project/main-dart.ts';
import { addToConfig, dartFiles, dartString } from './app.ts';

/**
 * The boards on a USB cable in the car's app: each a `SerialDevice`, handed to
 * `SmartifyOs().init` in `SerialConfig(devices: [...])`.
 *
 * Unlike a `CanDevice`, which only goes into its config, a new one is a constant of its own
 * in `lib/serial.dart`, since the owner's code names it to read it
 * (`SmartifyOsSerial.values(dashboard, 'oil')`). The config only gets its name.
 *
 * Which port a board is on is never written here: the car finds it by itself, by what the
 * board says it is (`SerialIdentity` in core), and the editor runs on another computer than
 * the car anyway.
 */

/** `SerialDevice.baudRate` when it is left out, core's own default. */
export const defaultBaudRate = 115200;

/** Where a new board's constant goes. */
export const serialFile = join('lib', 'serial.dart');

/** A board as the car's app defines it. */
export interface SerialDeviceDefinition {
	/** `SerialDevice.name`, what its sketch says it is. */
	name: string;
	/** `SerialDevice.title`, what the driver reads. */
	title: string;
	baudRate: number;
	/** The port it is tied to, null for one the car finds by itself. */
	port: string | null;
	/** The file it is written in, relative to the app, with `/`. */
	file: string;
	/** The line its `SerialDevice(` is on, from 1. */
	line: number;
}

/** Internal: one `SerialDevice(...)` in a file, with where its brackets are. */
interface Found extends SerialDeviceDefinition {
	path: string;
	open: number;
}

async function findAll(appDir: string): Promise<Found[]> {
	const found: Found[] = [];
	for (const path of await dartFiles(appDir)) {
		const source = await Bun.file(path).text();
		const code = codeOnly(source);
		for (const match of code.matchAll(/\bSerialDevice\s*\(/g)) {
			const open = match.index + match[0].length - 1;
			const close = closingBracket(code, open);
			if (close === -1) continue;
			const args = source.slice(open + 1, close);
			const name = /\bname\s*:\s*['"]([^'"]+)['"]/.exec(args)?.[1];
			if (!name) continue;
			const title = /\btitle\s*:\s*['"]([^'"]+)['"]/.exec(args)?.[1];
			const baud = /\bbaudRate\s*:\s*(\d+)/.exec(args)?.[1];
			const port = /\bport\s*:\s*['"]([^'"]+)['"]/.exec(args)?.[1];
			found.push({
				name,
				title: title ?? name,
				baudRate: baud ? Number(baud) : defaultBaudRate,
				port: port ?? null,
				file: relative(appDir, path).split(sep).join('/'),
				line: source.slice(0, match.index).split('\n').length,
				path,
				open,
			});
		}
	}
	return found;
}

/**
 * The boards the car's app defines, for the ones written out plainly as
 * `SerialDevice(name: 'dashboard', title: '...', ...)`.
 */
export async function definedSerialDevices(appDir: string): Promise<SerialDeviceDefinition[]> {
	return (await findAll(appDir)).map(({ path: _path, open: _open, ...definition }) => definition);
}

/** The Dart for a new board's constant, with a comment saying what it is. */
export function serialDeviceConstant(device: { name: string; title: string; baudRate: number }) {
	return [
		`/// ${device.title}, a board on a USB cable. Its sketch is in devices/${device.name}/.`,
		`const ${device.name} = SerialDevice(name: ${dartString(device.name)}, title: ${dartString(device.title)}, baudRate: ${device.baudRate});`,
	].join('\n');
}

/** What happened when a board was put into the car's app. */
export type SerialAddResult =
	| { kind: 'done'; files: string[] }
	| { kind: 'manual'; dart: string; reason: 'no-place' | 'does-not-build' };

/**
 * Puts a new board into the car's app: its constant at the end of `lib/serial.dart` (made
 * when there is none), and its name into the one `SerialConfig`, or, when there is none, a
 * `SerialConfig` of its own handed to `SmartifyOs().init` in `lib/main.dart`. Puts every file
 * back when the app has more errors with it than without.
 */
export async function addSerialDeviceToApp(
	appDir: string,
	device: { name: string; title: string; baudRate: number },
): Promise<SerialAddResult> {
	const constant = serialDeviceConstant(device);
	const manual = (reason: 'no-place' | 'does-not-build'): SerialAddResult => ({
		kind: 'manual',
		dart: `${constant}\n\nserial: SerialConfig(devices: [${device.name}]),`,
		reason,
	});

	const constantPath = join(appDir, serialFile);
	const edits = new Map<string, { before: string | null; after: string }>();
	const current = async (path: string) =>
		edits.get(path)?.after ??
		(existsSync(path) ? await Bun.file(path).text() : (null as string | null));
	const edit = async (path: string, change: (source: string) => string | undefined) => {
		const source = await current(path);
		if (source === null) return false;
		const after = change(source);
		if (after === undefined) return false;
		edits.set(path, { before: edits.get(path)?.before ?? source, after });
		return true;
	};

	// The constant.
	const coreImport = "import 'package:smartify_os_core/serial.dart';";
	const existing = await current(constantPath);
	edits.set(constantPath, {
		before: existing,
		after:
			existing === null
				? `${coreImport}\n\n${constant}\n`
				: `${addImportLine(existing, coreImport).trimEnd()}\n\n${constant}\n`,
	});

	// Its name in the config.
	const configs: string[] = [];
	for (const path of await dartFiles(appDir)) {
		const source = await current(path);
		if (source === null) continue;
		for (const _ of codeOnly(source).matchAll(/\bSerialConfig\s*\(/g)) configs.push(path);
	}
	if (configs.length > 1) return manual('no-place');
	const configPath = configs[0] ?? join(appDir, 'lib', 'main.dart');
	const placed = await edit(configPath, (source) =>
		configs[0]
			? addToConfig(source, device.name, 'SerialConfig')
			: addSerialToInit(source, device.name),
	);
	if (!placed) return manual('no-place');
	if (configPath !== constantPath) {
		const ownImport = await importOf(appDir, configPath, constantPath);
		await edit(configPath, (source) => addImportLine(addImportLine(source, coreImport), ownImport));
	}

	// Written, and taken back when the app no longer analyzes.
	const paths = [...edits.keys()];
	const write = async (which: 'before' | 'after') => {
		for (const [path, text] of edits) {
			const content = text[which];
			if (content === null) await Bun.file(path).delete();
			else await Bun.write(path, content);
		}
	};
	await write('after');
	const packages = packageConfigPath(appDir);
	const after = await analyzeErrors(paths, packages);
	if (after.length > 0) {
		await write('before');
		const had = await analyzeErrors(
			paths.filter((path) => edits.get(path)?.before !== null),
			packages,
		);
		if (after.length > had.length) return manual('does-not-build');
		await write('after');
	}
	await formatDart(paths);
	return { kind: 'done', files: paths.map((path) => relative(appDir, path).split(sep).join('/')) };
}

/**
 * Internal: the import of `target` in `from`, by the app's package name the way its own
 * files import each other, or relative when the pubspec has no name.
 */
async function importOf(appDir: string, from: string, target: string): Promise<string> {
	const pubspec = Bun.file(join(appDir, 'pubspec.yaml'));
	const name = (await pubspec.exists())
		? /^name:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/m.exec(await pubspec.text())?.[1]
		: undefined;
	const inLib = relative(join(appDir, 'lib'), target).split(sep).join('/');
	if (name) return `import 'package:${name}/${inLib}';`;
	return `import '${relative(dirname(from), target).split(sep).join('/')}';`;
}

/**
 * Hands `SmartifyOs().init` a `SerialConfig` with the board in it, for an app with no boards
 * on USB yet. Undefined when there is no one `init`, or it has a `serial` already.
 */
export function addSerialToInit(source: string, element: string): string | undefined {
	const code = codeOnly(source);
	const init = onlyMatch(code, /\bSmartifyOs\s*\(\s*\)\s*\.\s*init\s*\(/);
	if (!init) return undefined;
	const open = init.index + init[0].length - 1;
	if (/\bserial\s*:/.test(code.slice(open, closingBracket(code, open)))) return undefined;
	return appendElement(source, code, open, `serial: SerialConfig(devices: [${element}])`);
}

/**
 * Changes what the driver reads for a board, or the speed it talks at, where the car's app
 * defines it. Undefined when there is not exactly one `SerialDevice` of that name.
 */
export async function changeSerialDevice(
	appDir: string,
	name: string,
	change: { title?: string; baudRate?: number },
): Promise<SerialDeviceDefinition | undefined> {
	const matches = (await findAll(appDir)).filter((device) => device.name === name);
	const device = matches[0];
	if (!device || matches.length > 1) return undefined;
	const before = await Bun.file(device.path).text();
	let after: string | undefined = before;
	if (change.baudRate !== undefined && after !== undefined) {
		after = setArgumentAt(after, device.open, 'baudRate', String(change.baudRate));
	}
	if (change.title !== undefined && after !== undefined) {
		after = setArgumentAt(after, device.open, 'title', dartString(change.title));
	}
	if (after === undefined) return undefined;
	if (after !== before) {
		await Bun.write(device.path, after);
		await formatDart([device.path]);
	}
	return (await definedSerialDevices(appDir)).find(
		(found) => found.name === name && found.file === device.file,
	);
}
