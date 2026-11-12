import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { binaryName } from '../commands/flags.ts';
import { readApplicationId } from '../core/android/apk.ts';
import { type AndroidSync, syncAndroid } from '../core/android/project.ts';
import { type AndroidDevice, androidDevices, ensureCmake, hasAdb } from '../core/android/sdk.ts';
import { findAdb, readTablet } from '../core/android/tablet.ts';
import {
	type AndroidSetUp,
	type AndroidSetUpStep,
	findAndroidTools,
	missingAndroidTools,
	setUpAndroid,
} from '../core/android/tools.ts';
import { addPlatforms } from '../core/flutter.ts';
import type { CarState } from '../core/project/car.ts';
import { CliError } from '../utils/errors.ts';
import { renderNeedProblems } from './linux.ts';
import { log } from './output.ts';
import { step } from './project.ts';
import { confirm, isInteractive, select, spinner } from './prompt.ts';
import { theme } from './theme.ts';

/**
 * What every Android build of a car's app does first, on screen: gives the app its Android
 * part when it has none, writes what SmartifyOS and the extensions need into it, and installs
 * the CMake versions the packages pin.
 */
export async function prepareAndroid(state: CarState, yes = false): Promise<AndroidSync> {
	const dir = state.app.dir;
	await ensureAndroidTools(yes);
	if (!existsSync(join(dir, 'android'))) {
		const name = /^name:\s*(\S+)/m.exec(state.pubspecText)?.[1] ?? 'app';
		await step(
			"Your car's app has no Android part yet, adding it",
			() => addPlatforms(dir, ['android'], name),
			() => "Added the Android part to your car's app",
		);
	}

	const sync = await step(
		'Setting up the Android part the way SmartifyOS needs it',
		() => syncAndroid(dir),
		(sync) =>
			sync.changed.length > 0
				? `Set up ${sync.changed.length === 1 ? 'one file' : `${sync.changed.length} files`} of the Android part`
				: 'The Android part is set up the way SmartifyOS needs it',
	);
	renderAndroidSync(sync);

	await step(
		'Checking this computer has the CMake your packages need',
		() => ensureCmake(dir),
		(installed) =>
			installed.length > 0
				? `Installed CMake ${installed.join(' and ')}, which building for Android needs`
				: 'This computer can build for Android',
	);
	return sync;
}

/** What an Android sync left for the owner, and the mistakes in what packages list for it. */
export function renderAndroidSync(sync: AndroidSync): void {
	if (sync.needs) renderNeedProblems(sync.needs.problems);
	if (sync.manual.length > 0) {
		log.warn(
			`Some of what your car needs on Android has no clear place, so set it by hand:\n${sync.manual.map((line) => theme.dim(line)).join('\n')}`,
		);
	}
}

/** What the question about the Android build tools says they are, and that it means accepting Google's licence. */
export const androidToolsQuestion =
	"It installs Google's Android SDK, and Java when there is none, and accepts Google's licence for the SDK.";

/** What is on screen while each part of setting Android up happens. */
const androidStepText: Record<AndroidSetUpStep, string> = {
	java: 'Downloading Java, which building for Android runs on',
	'cmdline-tools': "Downloading the Android SDK's command line tools",
	licences: "Accepting Google's licence for the Android SDK",
	'platform-tools': "Installing the Android SDK's platform tools",
	flutter: 'Telling Flutter where the Android SDK and Java are',
};

/** Installs what building for Android needs under a spinner, or says it is there already. */
export async function setUpAndroidStep(): Promise<AndroidSetUp> {
	const progress = spinner();
	progress.start('Looking for what building for Android needs');
	try {
		const done = await setUpAndroid((step) => progress.message(androidStepText[step]));
		progress.stop(
			done.installed.length > 0
				? `Installed ${listed(done.installed)}, for building for Android`
				: 'This computer has everything building for Android needs',
		);
		return done;
	} catch (error) {
		progress.error('Building for Android could not be set up');
		throw error;
	}
}

/**
 * Before an Android build: installs what building for Android needs when something is
 * missing, once the owner says yes (or `--yes` did), and fails saying what to run otherwise.
 */
export async function ensureAndroidTools(yes: boolean): Promise<void> {
	const missing = missingAndroidTools(await findAndroidTools());
	if (missing.length === 0) return;
	const go =
		yes ||
		(isInteractive() &&
			(await confirm({
				message: `Building for Android needs ${listed(missing)}. Install ${missing.length === 1 ? 'it' : 'them'} now? ${androidToolsQuestion}`,
				initialValue: true,
			})));
	if (!go) {
		throw new CliError(`Building for Android needs ${listed(missing)}.`, {
			hint: `Run ${binaryName} setup --android, which installs ${missing.length === 1 ? 'it' : 'them'} for you.`,
		});
	}
	await setUpAndroidStep();
}

/** Internal: `a`, `a and b`, `a, b and c`. */
function listed(items: string[]): string {
	return items.length <= 1
		? items.join('')
		: `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** The Android device to use, by its id or name (`--device`), the only one, or by asking. */
export async function pickAndroidDevice(flag: unknown, action = 'run on'): Promise<AndroidDevice> {
	const devices = await step(
		'Looking for Android devices',
		() => androidDevices(),
		(found) =>
			found.length === 1
				? `Found ${found[0]?.name}`
				: `Found ${found.length === 0 ? 'no' : found.length} Android devices`,
	);
	const given = typeof flag === 'string' ? flag.trim() : undefined;
	if (given) {
		const found = devices.find((d) => d.id === given || d.name === given);
		if (found) return found;
		throw new CliError(`There is no Android device ${given} plugged in.`, {
			hint: devices.length
				? `These are: ${devices.map((d) => `${d.name} (${d.id})`).join(', ')}.`
				: 'Plug it in with a USB cable, with USB debugging switched on in its developer options.',
		});
	}
	const [only] = devices;
	if (devices.length === 1 && only) return only;
	if (devices.length === 0) {
		throw new CliError('No Android device is plugged into this computer.', {
			hint: (await hasAdb())
				? 'Plug it in with a USB cable and switch USB debugging on in its developer options (tap the build number in About seven times to show them). Then say yes to this computer on its screen.'
				: `Running on Android needs the Android SDK. Run ${binaryName} setup --android, then plug the device in with USB debugging on.`,
		});
	}
	return await select<AndroidDevice>({
		message: `Which Android device should it ${action}?`,
		options: devices.map((d) => ({
			value: d,
			label: d.name,
			hint: d.emulator ? `an emulator, ${d.sdk}` : d.sdk,
		})),
	});
}

/**
 * Before running on a tablet: says once in a line how to make it start into the car's app,
 * while it does not. Quiet for an emulator and when anything about it cannot be found out.
 */
export async function tabletHint(appDir: string, device: AndroidDevice): Promise<void> {
	if (device.emulator) return;
	try {
		const tablet = { adb: await findAdb(), serial: device.id };
		const state = await readTablet(tablet, await readApplicationId(appDir));
		if (state.isHome) return;
		log.info(
			`Is ${theme.strong(device.name)} your car's screen? ${theme.code(`${binaryName} tablet`)} makes it start into your car's app.`,
		);
	} catch {
		// Only a hint.
	}
}
