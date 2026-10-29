import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CliError } from '../../utils/errors.ts';
import { probe, run } from '../process.ts';
import { readPackageRoots } from '../pubspec/read.ts';
import { type AndroidTools, findAndroidTools, runSdkmanager } from './tools.ts';

/**
 * What building one car's app for Android needs on top of what `setup --android` installs
 * (src/core/android/tools.ts): the CMake versions the car's packages pin, which Gradle does
 * not download on its own (the first build fails with "CMake '3.31.4' was not found in SDK").
 * The versions are read from the packages themselves, so nothing here has to know which
 * package needs which. And the Android devices to run on.
 */

/**
 * Every CMake version a package's Android build pins (`version "3.31.4"` inside a `cmake {}`
 * block of its android/build.gradle), from every package the car's app resolved.
 */
export async function pinnedCmakeVersions(appDir: string): Promise<string[]> {
	const versions = new Set<string>();
	for (const root of (await readPackageRoots(appDir)).values()) {
		for (const name of ['build.gradle', 'build.gradle.kts']) {
			const file = Bun.file(join(root, 'android', name));
			if (!(await file.exists())) continue;
			for (const version of cmakeVersionsIn(await file.text())) versions.add(version);
		}
	}
	return [...versions].sort();
}

/** The CMake versions pinned in one Gradle file, Groovy or Kotlin. */
export function cmakeVersionsIn(gradle: string): string[] {
	// A version in a comment pins nothing (jni has `// version "3.10.2"`).
	const text = gradle.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
	const found: string[] = [];
	for (const block of text.matchAll(/\bcmake\s*\{/g)) {
		const body = blockAt(text, (block.index ?? 0) + block[0].length);
		const version = /\bversion\s*=?\s*["']([0-9][0-9.]*)["']/.exec(body)?.[1];
		if (version && !found.includes(version)) found.push(version);
	}
	return found;
}

/** Internal: what is inside the braces opened just before `from`. */
function blockAt(text: string, from: number): string {
	let depth = 1;
	for (let i = from; i < text.length; i++) {
		if (text[i] === '{') depth++;
		else if (text[i] === '}' && --depth === 0) return text.slice(from, i);
	}
	return text.slice(from);
}

/**
 * Installs every CMake version the car's packages pin that the Android SDK does not have yet.
 *
 * @returns the versions it installed.
 * @throws {CliError} when the SDK or its command line tools are missing, or one would not install.
 */
export async function ensureCmake(appDir: string, tools?: AndroidTools): Promise<string[]> {
	const versions = await pinnedCmakeVersions(appDir);
	if (versions.length === 0) return [];
	const found = tools ?? (await findAndroidTools());
	const { sdk } = found;
	if (!sdk || !found.sdkmanager) {
		throw new CliError(
			`Building for Android needs CMake ${versions.join(' and ')}, and the Android SDK to install it into.`,
			{
				hint: 'Run smartify-os setup --android, which installs what building for Android needs.',
			},
		);
	}

	const missing = versions.filter((version) => !existsSync(join(sdk, 'cmake', version)));
	for (const version of missing) {
		const result = await runSdkmanager(found, [`cmake;${version}`]);
		if (result.code !== 0 || !existsSync(join(sdk, 'cmake', version))) {
			throw new CliError(
				`CMake ${version}, which building for Android needs, could not be installed.`,
				{
					hint: result.output.split('\n').slice(-8).join('\n'),
				},
			);
		}
	}
	return missing;
}

/** An Android device Flutter can run on. */
export interface AndroidDevice {
	id: string;
	name: string;
	/** `Android 13 (API 33)`. */
	sdk: string;
	emulator: boolean;
}

/** The Android devices plugged in or running, as Flutter sees them. */
export async function androidDevices(): Promise<AndroidDevice[]> {
	const result = await run('flutter', ['devices', '--machine'], { timeoutMs: 60_000 });
	try {
		const json = result.stdout.slice(result.stdout.indexOf('['));
		const devices = JSON.parse(json) as Record<string, unknown>[];
		return devices
			.filter((d) => typeof d.targetPlatform === 'string' && d.targetPlatform.startsWith('android'))
			.filter((d) => d.isSupported !== false)
			.map((d) => ({
				id: String(d.id),
				name: String(d.name ?? d.id),
				sdk: String(d.sdk ?? ''),
				emulator: d.emulator === true,
			}));
	} catch {
		return [];
	}
}

/** Whether adb is anywhere, for saying why no device shows up. */
export async function hasAdb(): Promise<boolean> {
	const { adb } = await findAndroidTools();
	return adb !== undefined || (await probe('adb', ['version'])) !== undefined;
}
