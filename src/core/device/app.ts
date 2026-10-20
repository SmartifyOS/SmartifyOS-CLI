import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { analyzeErrors, packageConfigPath } from '../flutter.ts';
import { formatDart } from '../project/dart-file.ts';
import {
	addImportLine,
	appendElement,
	closingBracket,
	codeOnly,
	onlyMatch,
} from '../project/main-dart.ts';

/**
 * Putting a new device into the car's app, which is where every device on the CAN bus is
 * defined: a `CanDevice` in `CanConfig(devices: [...])`.
 *
 * That is Dart the owner wrote, so it is edited the way `lib/main.dart` is for extensions:
 * only when the one place it goes can be found without doubt, and taken back again when the
 * app no longer analyzes. Otherwise the caller prints the line instead.
 */

/** A device as the car's app defines it. */
export interface DeviceDefinition {
	node: number;
	/** `CanDevice.name`, what the stick names its firmware by. */
	name: string;
	/** `CanDevice.title`, what the driver reads. */
	title: string;
}

/** The Dart for one device. */
export function deviceCall(device: DeviceDefinition): string {
	return `CanDevice(node: ${device.node}, name: ${dartString(device.name)}, title: ${dartString(device.title)})`;
}

/** Internal: a Dart string literal, in double quotes when that saves escaping one. */
function dartString(text: string): string {
	const escaped = text.replace(/\\/g, '\\\\').replace(/\$/g, '\\$');
	if (text.includes("'") && !text.includes('"')) return `"${escaped}"`;
	return `'${escaped.replace(/'/g, "\\'")}'`;
}

/** Every Dart file in the app's `lib`. */
async function dartFiles(appDir: string): Promise<string[]> {
	const found: string[] = [];
	const walk = async (dir: string) => {
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.name.endsWith('.dart')) found.push(path);
		}
	};
	await walk(join(appDir, 'lib'));
	return found.sort();
}

/**
 * The devices the car's app defines, read from its Dart, for the ones written out plainly as
 * `CanDevice(node: 2, name: 'headlights', ...)`. The header says the same once the app ran,
 * and this is what knows about one added since.
 */
export async function definedDevices(appDir: string): Promise<DeviceDefinition[]> {
	const devices: DeviceDefinition[] = [];
	for (const path of await dartFiles(appDir)) {
		const source = await Bun.file(path).text();
		const code = codeOnly(source);
		for (const match of code.matchAll(/\bCanDevice\s*\(/g)) {
			const open = match.index + match[0].length - 1;
			const close = closingBracket(code, open);
			if (close === -1) continue;
			const args = source.slice(open + 1, close);
			const node = /\bnode\s*:\s*(\d+)/.exec(args)?.[1];
			const name = /\bname\s*:\s*['"]([^'"]+)['"]/.exec(args)?.[1];
			const title = /\btitle\s*:\s*['"]([^'"]+)['"]/.exec(args)?.[1];
			if (node && name) devices.push({ node: Number(node), name, title: title ?? name });
		}
	}
	return devices;
}

/** What happened when a device was put into the car's app. */
export type AddResult =
	| { kind: 'done'; file: string }
	| { kind: 'manual'; dart: string; reason: 'no-place' | 'does-not-build' };

/**
 * Puts a device into the car's app: into its one `CanConfig`, or, when it has none, a
 * `CanConfig` of its own handed to `SmartifyOs().init` in `lib/main.dart`. Analyzes the file
 * afterwards and puts it back when it has errors it did not have before.
 */
export async function addDeviceToApp(appDir: string, device: DeviceDefinition): Promise<AddResult> {
	const element = deviceCall(device);
	const manual = (reason: 'no-place' | 'does-not-build'): AddResult => ({
		kind: 'manual',
		dart: element,
		reason,
	});

	const placed = await findPlace(appDir, element);
	if (!placed) return manual('no-place');

	const before = await Bun.file(placed.file).text();
	await Bun.write(placed.file, placed.edited);
	const packages = packageConfigPath(appDir);
	const after = await analyzeErrors([placed.file], packages);
	if (after.length > 0) {
		await Bun.write(placed.file, before);
		const had = await analyzeErrors([placed.file], packages);
		if (after.length > had.length) return manual('does-not-build');
		await Bun.write(placed.file, placed.edited);
	}
	await formatDart([placed.file]);
	return { kind: 'done', file: relative(appDir, placed.file) };
}

/** Internal: the file the device goes in, and what it reads with it there. */
async function findPlace(
	appDir: string,
	element: string,
): Promise<{ file: string; edited: string } | undefined> {
	const configs: { file: string; source: string }[] = [];
	for (const file of await dartFiles(appDir)) {
		const source = await Bun.file(file).text();
		const count = [...codeOnly(source).matchAll(/\bCanConfig\s*\(/g)].length;
		for (let i = 0; i < count; i++) configs.push({ file, source });
	}
	if (configs.length > 1) return undefined;
	const config = configs[0];
	if (config) {
		const edited = addToConfig(config.source, element);
		return edited === undefined ? undefined : { file: config.file, edited };
	}

	// No CAN bus at all yet: a CanConfig of its own, in main.dart.
	const main = join(appDir, 'lib', 'main.dart');
	const file = Bun.file(main);
	if (!(await file.exists())) return undefined;
	const edited = addToInit(await file.text(), element);
	return edited === undefined ? undefined : { file: main, edited };
}

/**
 * Puts a device into the one `CanConfig(...)` in a file: at the end of its `devices` list,
 * or a `devices` list of its own when it has none. Undefined when there is no one place.
 */
export function addToConfig(source: string, element: string): string | undefined {
	const code = codeOnly(source);
	const config = onlyMatch(code, /\bCanConfig\s*\(/);
	if (!config) return undefined;
	const open = config.index + config[0].length - 1;
	const close = closingBracket(code, open);
	if (close === -1) return undefined;
	const inside = code.slice(open, close);
	const list = onlyMatch(inside, /\bdevices\s*:\s*\[/);
	if (list) return appendElement(source, code, open + list.index + list[0].length - 1, element);
	if (/\bdevices\s*:/.test(inside)) return undefined;
	return appendElement(source, code, open, `devices: [${element}]`);
}

/**
 * Hands `SmartifyOs().init` a `CanConfig` with the device in it, for an app with no CAN bus
 * yet, and imports it. Undefined when there is no one `init`, or it has a `can` already.
 */
export function addToInit(source: string, element: string): string | undefined {
	const code = codeOnly(source);
	const init = onlyMatch(code, /\bSmartifyOs\s*\(\s*\)\s*\.\s*init\s*\(/);
	if (!init) return undefined;
	const open = init.index + init[0].length - 1;
	if (/\bcan\s*:/.test(code.slice(open, closingBracket(code, open)))) return undefined;
	const edited = appendElement(source, code, open, `can: CanConfig(devices: [${element}])`);
	return addImportLine(edited, "import 'package:smartify_os_core/can.dart';");
}
