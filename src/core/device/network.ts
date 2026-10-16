import { join } from 'node:path';
import { CliError } from '../../utils/errors.ts';
import type { CarState } from '../project/car.ts';
import { parsePubspec } from '../pubspec/read.ts';

/**
 * What the firmware of a car's devices is built from: the header SmartifyOS writes from the
 * CAN bus defined in the car's app, and the library and platform SmartifyOS names.
 */

/**
 * Where SmartifyOS writes the header, relative to the car's app (`CanConfig.firmwareHeader`).
 * It writes it while the app runs on the computer it is made on, see `smartify-os run`.
 */
export const headerPath = 'firmware/smartify_os_network.h';

/** One device in `network::nodes`. */
export interface NetworkNode {
	/** Its name in C++, which is `CanDevice.name` made into a C++ name. */
	name: string;
	/** Its number on the bus. */
	node: number;
	/** What a person calls it, `CanDevice.title`. */
	title: string;
}

/**
 * The devices in a header, from its `namespace nodes`:
 *
 * ```cpp
 * namespace nodes {
 * /// Pop-up headlights
 * constexpr uint8_t headlights = 2;
 * }  // namespace nodes
 * ```
 */
export function parseNodes(header: string): NetworkNode[] {
	const block = /namespace nodes \{\n([\s\S]*?)\}\s*\/\/ namespace nodes/.exec(header)?.[1];
	if (!block) return [];
	const nodes: NetworkNode[] = [];
	let title: string | undefined;
	for (const line of block.split(/\r?\n/)) {
		const comment = /^\s*\/\/\/\s?(.*)$/.exec(line);
		if (comment) {
			title = comment[1]?.trim();
			continue;
		}
		const constant = /^\s*constexpr\s+uint8_t\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)\s*;/.exec(
			line,
		);
		if (constant?.[1] && constant[2]) {
			nodes.push({ name: constant[1], node: Number(constant[2]), title: title || constant[1] });
		}
		title = undefined;
	}
	return nodes;
}

/** The devices in the car's header, or undefined when SmartifyOS has not written one yet. */
export async function readNodes(appDir: string): Promise<NetworkNode[] | undefined> {
	const file = Bun.file(join(appDir, headerPath));
	if (!(await file.exists())) return undefined;
	return parseNodes(await file.text());
}

/**
 * What every device of a car is built with, from `smartify_os: firmware:` in the pubspec of
 * the SmartifyOS the car runs, the way an extension's template is taken from its tag.
 */
export interface FirmwareSource {
	/** The SmartifyOS-ESP32 library's git url. */
	library: string;
	/** The library's release, a tag. */
	version: string;
	/** The PlatformIO platform the library is built and tried with, `espressif32@7.1.3`. */
	platform: string;
}

/** Reads it from the pubspec text of SmartifyOS, undefined when it names none. */
export function parseFirmwareSource(corePubspecText: string): FirmwareSource | undefined {
	const pubspec = parsePubspec(corePubspecText, 'pubspec.yaml') as Record<string, unknown>;
	const smartifyOs = pubspec.smartify_os as Record<string, unknown> | null | undefined;
	const firmware = smartifyOs?.firmware as Record<string, unknown> | null | undefined;
	const library = firmware?.library;
	const version = firmware?.version;
	const platform = firmware?.platform;
	if (typeof library !== 'string' || typeof platform !== 'string') return undefined;
	if (typeof version !== 'string' && typeof version !== 'number') return undefined;
	return { library: library.trim(), version: String(version).trim(), platform: platform.trim() };
}

/**
 * What the SmartifyOS this car runs builds firmware with.
 *
 * @throws {CliError} when it names nothing, which is a SmartifyOS from before devices.
 */
export async function readFirmwareSource(state: CarState): Promise<FirmwareSource> {
	const root = state.core.root;
	const file = root ? Bun.file(join(root, 'pubspec.yaml')) : undefined;
	const found = file && (await file.exists()) ? parseFirmwareSource(await file.text()) : undefined;
	if (found) return found;
	const which = state.core.version ? `SmartifyOS ${state.core.version}` : 'This SmartifyOS';
	throw new CliError(`${which} does not know about devices on the CAN bus yet.`, {
		hint: 'Move your car to a newer SmartifyOS with smartify-os update.',
	});
}

/**
 * A device's name the way the header writes it in C++: letters, digits and underscores, not
 * starting with a digit, the same as SmartifyOS's `CanFirmwareHeader`.
 */
export function cppName(name: string): string {
	const cleaned = name.replace(/[^A-Za-z0-9_]/g, '_');
	if (!cleaned) return '_';
	return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}
