import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CliError } from '../../utils/errors.ts';
import { findAndroidTools, missingAndroidTools } from '../android/tools.ts';
import { isPlatformioReady, platformioRunsHere, platformioVersion } from '../device/platformio.ts';
import { pioPath } from '../device/tools.ts';
import { flutterVersion } from '../flutter.ts';
import { findFlutter, probe } from '../process.ts';
import { gitInstallHint } from './flutter.ts';

/**
 * Checking what this computer has for making a car, the way `flutter doctor` does for
 * Flutter.
 *
 * Without Flutter (or the git it runs on) nothing works, so those are errors. Everything else
 * is only needed for some setups, so a missing one is a warning that says what it is for.
 */

export type CheckId = 'flutter' | 'git' | 'desktop' | 'platformio' | 'android';
export type CheckStatus = 'ok' | 'warning' | 'error';

/** One thing that was checked. */
export interface Check {
	id: CheckId;
	/** `Flutter`. */
	title: string;
	status: CheckStatus;
	/** What was found, `3.47.5 on stable`, or what is wrong. */
	summary: string;
	/** What it is needed for, when that is not everything. */
	neededFor?: string;
	/** What to do about it, only when it is not ok. */
	hint?: string;
	/**
	 * The arguments of the smartify-os command that puts it right, when one does, like
	 * `['setup']`. The hint says the same in words, a GUI can make it a button.
	 */
	fix?: string[];
	/** Where it is, when it was found. */
	path?: string;
}

/** Every check, in the order they are shown. They run side by side. */
export async function runChecks(): Promise<Check[]> {
	return await Promise.all([
		checkFlutter(),
		checkGit(),
		checkDesktop(),
		checkPlatformio(),
		checkAndroid(),
	]);
}

/** The first `1.2` or `1.2.3` in some text. */
export function firstVersion(text: string): string | undefined {
	return /\d+\.\d+(?:\.\d+)?/.exec(text)?.[0];
}

async function checkFlutter(): Promise<Check> {
	const base = { id: 'flutter', title: 'Flutter' } as const;
	const found = findFlutter();
	if (!found) {
		return {
			...base,
			status: 'error',
			summary: 'Not installed, and SmartifyOS needs it for everything',
			hint: 'Run smartify-os setup, which installs it for you.',
			fix: ['setup'],
		};
	}
	try {
		const { version, channel } = await flutterVersion();
		const where = found.own ? ', installed by smartify-os setup' : '';
		return { ...base, status: 'ok', summary: `${version} on ${channel}${where}`, path: found.path };
	} catch (error) {
		return {
			...base,
			status: 'error',
			summary: 'Installed, but it does not work',
			hint: [
				found.own
					? 'Run smartify-os setup to install it again.'
					: 'Run flutter doctor to see what is wrong with it.',
				error instanceof CliError ? error.hint : undefined,
			]
				.filter(Boolean)
				.join('\n'),
			// The one setup installed it puts right by installing it again.
			...(found.own ? { fix: ['setup'] } : {}),
			path: found.path,
		};
	}
}

async function checkGit(): Promise<Check> {
	const base = { id: 'git', title: 'git' } as const;
	const result = await probe('git', ['--version']);
	if (result?.code !== 0) {
		return {
			...base,
			status: 'error',
			summary: 'Not installed, and Flutter does not run without it',
			hint: gitInstallHint(),
		};
	}
	return {
		...base,
		status: 'ok',
		summary: firstVersion(result.stdout) ?? 'Installed',
		path: Bun.which('git') ?? undefined,
	};
}

/** What `smartify-os run` needs besides Flutter, which is different on every desktop. */
async function checkDesktop(): Promise<Check> {
	const neededFor = "Only needed to try your car's app on this computer.";
	if (process.platform === 'darwin') return await checkXcode(neededFor);
	if (process.platform === 'win32') return await checkVisualStudio(neededFor);
	return await checkLinuxTools(neededFor);
}

async function checkXcode(neededFor: string): Promise<Check> {
	const base = { id: 'desktop', title: 'Xcode', neededFor } as const;
	const xcode = await probe('xcodebuild', ['-version']);
	const version = xcode?.code === 0 ? /Xcode (\S+)/.exec(xcode.stdout)?.[1] : undefined;
	if (!version) {
		return {
			...base,
			status: 'warning',
			summary: 'Not installed',
			hint: 'Install Xcode from the App Store and open it once. If it is installed already, run sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer',
		};
	}
	const pods = await probe('pod', ['--version']);
	if (pods?.code !== 0) {
		return {
			...base,
			status: 'warning',
			summary: `${version}, but CocoaPods is missing`,
			hint: 'Install CocoaPods with brew install cocoapods, or see https://guides.cocoapods.org/using/getting-started.html',
		};
	}
	return {
		...base,
		status: 'ok',
		summary: `${version}, with CocoaPods ${firstVersion(pods.stdout) ?? ''}`.trim(),
	};
}

async function checkVisualStudio(neededFor: string): Promise<Check> {
	const base = { id: 'desktop', title: 'Visual Studio', neededFor } as const;
	const vswhere = join(
		process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
		'Microsoft Visual Studio',
		'Installer',
		'vswhere.exe',
	);
	const result = await probe(vswhere, [
		'-latest',
		'-products',
		'*',
		'-requires',
		'Microsoft.VisualStudio.Workload.NativeDesktop',
		'-property',
		'displayName',
	]);
	const name = result?.code === 0 ? result.stdout.trim().split(/\r?\n/)[0] : undefined;
	if (!name) {
		return {
			...base,
			status: 'warning',
			summary: 'Not installed with Desktop development with C++',
			hint: 'Install Visual Studio (Community is free) from https://visualstudio.microsoft.com/downloads/ and pick the Desktop development with C++ workload.',
		};
	}
	return { ...base, status: 'ok', summary: name };
}

/** The Linux programs Flutter builds a desktop app with, and the Debian package of each. */
const linuxBuildTools = [
	{ program: 'clang', apt: 'clang' },
	{ program: 'cmake', apt: 'cmake' },
	{ program: 'ninja', apt: 'ninja-build' },
	{ program: 'pkg-config', apt: 'pkg-config' },
] as const;

async function checkLinuxTools(neededFor: string): Promise<Check> {
	const base = { id: 'desktop', title: 'Linux build tools', neededFor } as const;
	const missing: string[] = linuxBuildTools
		.filter((tool) => !Bun.which(tool.program))
		.map((tool) => tool.apt);
	const gtk = await probe('pkg-config', ['--exists', 'gtk+-3.0']);
	if (gtk?.code !== 0) missing.push('libgtk-3-dev');
	if (missing.length > 0) {
		return {
			...base,
			status: 'warning',
			summary: `Missing ${missing.join(', ')}`,
			hint: `Install them with sudo apt install ${missing.join(' ')} (or your package manager's names for them).`,
		};
	}
	return { ...base, status: 'ok', summary: 'clang, cmake, ninja, pkg-config and GTK 3' };
}

async function checkPlatformio(): Promise<Check> {
	const base = {
		id: 'platformio',
		title: 'PlatformIO',
		neededFor: "Only needed to build the devices on your car's CAN bus.",
	} as const;
	if (!platformioRunsHere()) {
		return {
			...base,
			status: 'warning',
			summary: 'Does not run on this computer',
			hint: 'Build the firmware on another computer: macOS, Windows, or a Linux like Debian or Ubuntu.',
		};
	}
	if (await isPlatformioReady()) {
		return {
			...base,
			status: 'ok',
			summary: `${platformioVersion}, set up by SmartifyOS`,
			path: pioPath(),
		};
	}
	return {
		...base,
		status: 'warning',
		summary: existsSync(pioPath())
			? 'An older version, updated when it is next used'
			: 'Not set up',
		hint: 'Run smartify-os setup --platformio, or it sets itself up the first time you build a device.',
		fix: ['setup', '--platformio'],
	};
}

/**
 * Everything building a car's app for Android needs: the SDK with its command line and
 * platform tools, its licence accepted, and a new enough Java (src/core/android/tools.ts).
 * Only some cars have an Android tablet as their screen, so a missing piece is a warning.
 */
async function checkAndroid(): Promise<Check> {
	const base = {
		id: 'android',
		title: 'Android',
		neededFor: "Only needed when an Android tablet is your car's screen.",
	} as const;
	const tools = await findAndroidTools();
	const missing = missingAndroidTools(tools);
	if (missing.length > 0) {
		const none = !tools.sdk && !tools.java;
		return {
			...base,
			status: 'warning',
			summary: none ? 'Not set up' : `Missing ${listed(missing)}`,
			hint: 'Run smartify-os setup --android, which installs what building for Android needs.',
			fix: ['setup', '--android'],
			...(tools.sdk ? { path: tools.sdk } : {}),
		};
	}
	const adb = tools.adb ? await probe(tools.adb, ['version']) : undefined;
	const version = firstVersion(/^Version .*$/m.exec(adb?.stdout ?? '')?.[0] ?? '');
	return {
		...base,
		status: 'ok',
		summary: `The Android SDK, Java ${tools.java?.version}${version ? ` and adb ${version}` : ''}`,
		...(tools.sdk ? { path: tools.sdk } : {}),
	};
}

/** Internal: `a`, `a and b`, `a, b and c`. */
function listed(items: string[]): string {
	return items.length <= 1
		? items.join('')
		: `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}
