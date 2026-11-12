import { CliError } from '../../utils/errors.ts';
import { type ProcessResult, probe } from '../process.ts';
import { findAndroidTools } from './tools.ts';

/**
 * Setting up an Android tablet that is a car's screen, over adb, once per tablet: SmartifyOS
 * as its home screen, and if the owner wants, as its owner ("device owner").
 *
 * As the owner SmartifyOS can restart the tablet, set its clock, update itself from a stick
 * without Android asking, and grant itself every permission it needs without a dialog. Core
 * merges the device admin receiver that needs into every car's app
 * (`dev.smartify_os.core.SmartifyOsDeviceAdmin`). Android only allows it on a tablet with no
 * accounts, no other users and no other owner, and an owner app cannot be uninstalled until
 * it stops being the owner, which only the app itself can do (its developer options have
 * "Stop being the tablet's owner"). adb cannot take it back for an app that is not test only.
 */

/** A tablet plugged in, as adb reaches it. */
export interface Tablet {
	/** The adb program. */
	adb: string;
	/** The tablet's id, what `adb -s` takes. */
	serial: string;
}

/** The device admin receiver core merges into every car's app. */
export const deviceAdminReceiver = 'dev.smartify_os.core.SmartifyOsDeviceAdmin';

/** What the tablet has of the car's app. */
export interface TabletState {
	/** Whether the car's app is installed on it. */
	installed: boolean;
	/**
	 * The app's activity that can be the home screen, `com.example.my_car/.MainActivity`.
	 * Undefined when the app is not installed, or was built before it could be one.
	 */
	homeActivity: string | undefined;
	/** Whether the app is the tablet's home screen already. */
	isHome: boolean;
	/** The package of the app that owns the tablet, undefined when none does. */
	owner: string | undefined;
}

/**
 * The adb program: the Android SDK's, or one on PATH.
 *
 * @throws {CliError} when there is none.
 */
export async function findAdb(): Promise<string> {
	const found = (await findAndroidTools()).adb ?? Bun.which('adb');
	if (found) return found;
	throw new CliError('Talking to a tablet needs the Android SDK, which this computer has not.', {
		hint: 'Run smartify-os setup --android, which installs it for you.',
	});
}

/** Internal: runs adb on the tablet. Never throws, a program that would not start is code -1. */
async function adb(tablet: Tablet, args: string[], timeoutMs = 30_000): Promise<ProcessResult> {
	const result = await probe(tablet.adb, ['-s', tablet.serial, ...args], { timeoutMs });
	return result ?? { code: -1, stdout: '', stderr: 'adb could not be started.' };
}

/** Internal: what adb printed, both streams. */
function output(result: ProcessResult): string {
	return `${result.stdout}\n${result.stderr}`.trim();
}

/** The activities (`package/.Activity`) in what `cmd package query-activities --brief` printed. */
export function componentsIn(text: string): string[] {
	return [...text.matchAll(/^[ \t]*([\w.]+\/[\w.$]+)[ \t]*$/gm)].map((m) => m[1] as string);
}

/**
 * The package of the tablet's device owner in what `dumpsys device_policy` or
 * `dpm list-owners` printed, undefined when there is none.
 */
export function deviceOwnerIn(text: string): string | undefined {
	return (
		/Device Owner:[ \t]*\r?\n[ \t]*admin=ComponentInfo\{([\w.]+)\//.exec(text)?.[1] ??
		/admin=([\w.]+)\/[^,\s]*,DeviceOwner/.exec(text)?.[1]
	);
}

/** What the tablet has of the car's app. */
export async function readTablet(tablet: Tablet, applicationId: string): Promise<TabletState> {
	const path = await adb(tablet, ['shell', 'pm', 'path', applicationId]);
	const installed = path.code === 0 && path.stdout.includes('package:');
	const intent = ['-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.HOME'];
	const homes = installed
		? componentsIn(
				(
					await adb(tablet, [
						'shell',
						'cmd',
						'package',
						'query-activities',
						'--brief',
						...intent,
						applicationId,
					])
				).stdout,
			)
		: [];
	const current = componentsIn(
		(await adb(tablet, ['shell', 'cmd', 'package', 'resolve-activity', '--brief', ...intent]))
			.stdout,
	).at(-1);
	const policy = await adb(tablet, ['shell', 'dumpsys', 'device_policy']);
	return {
		installed,
		homeActivity: homes[0],
		isHome: installed && current?.split('/')[0] === applicationId,
		owner: deviceOwnerIn(policy.stdout),
	};
}

/**
 * Installs an `.apk` on the tablet, over the version there, keeping its settings.
 *
 * @throws {CliError} when Android would not install it.
 */
export async function installApk(tablet: Tablet, apk: string): Promise<void> {
	const result = await adb(tablet, ['install', '-r', apk], 10 * 60_000);
	const text = output(result);
	if (result.code === 0 && text.includes('Success')) return;
	if (text.includes('INSTALL_FAILED_UPDATE_INCOMPATIBLE')) {
		throw new CliError(
			"The app on the tablet was built on another computer, so Android will not update it with this one's.",
			{
				hint: "Uninstall it on the tablet first, its settings go with it. If SmartifyOS is the tablet's owner, tap Stop being the tablet's owner in its Settings, System, Developer options, Android before that.",
			},
		);
	}
	if (text.includes('INSTALL_FAILED_INSUFFICIENT_STORAGE')) {
		throw new CliError('The tablet has no room for the app.', {
			hint: 'Make some room on it, then try again.',
		});
	}
	throw new CliError("Your car's app could not be installed on the tablet.", {
		hint: text.split('\n').slice(-6).join('\n'),
	});
}

/**
 * Makes the app's activity the tablet's home screen, so Android never asks which one.
 *
 * @throws {CliError} when Android does not allow it.
 */
export async function setHomeScreen(tablet: Tablet, activity: string): Promise<void> {
	const result = await adb(tablet, ['shell', 'cmd', 'package', 'set-home-activity', activity]);
	if (result.code === 0 && !/error/i.test(output(result))) return;
	throw new CliError("Android did not let SmartifyOS be the tablet's home screen.", {
		hint: "Press the home button on the tablet, pick your car's app and then Always.",
	});
}

/** What to tell the owner when `dpm set-device-owner` failed, from what it printed. */
export function ownerFailure(text: string): { message: string; hint: string } {
	const again = 'then run smartify-os tablet again';
	if (/already some accounts/i.test(text)) {
		return {
			message:
				"The tablet has an account on it (a Google or Samsung account, say), and Android only lets an app become a tablet's owner while it has none.",
			hint: `Remove every account in the tablet's settings (Accounts, or Passwords and accounts), or reset it to factory settings and skip signing in, ${again}. A tablet that is only the car's screen needs no account.`,
		};
	}
	if (/several users|multiple users/i.test(text)) {
		return {
			message:
				"The tablet has more than one user (a guest or a second person), and Android only lets an app become a tablet's owner while it has one.",
			hint: `Remove the other users in the tablet's settings (System, Multiple users), ${again}.`,
		};
	}
	if (
		/device owner.*is already set|already has a (device|profile) owner|profile owner/i.test(text)
	) {
		return {
			message: 'Another app is already the owner of this tablet.',
			hint: `A tablet has only one owner. Take that app off as the owner in its own settings, or reset the tablet to factory settings and skip signing in, ${again}.`,
		};
	}
	if (/already (been )?provisioned|already set up|already paired/i.test(text)) {
		return {
			message: 'Android says the tablet is already set up in a way that keeps an owner out.',
			hint: `Remove every account and every other user in the tablet's settings, or reset it to factory settings and skip signing in, ${again}.`,
		};
	}
	if (/unknown admin|bad admin|not installed/i.test(text)) {
		return {
			message: "The app on the tablet is from before SmartifyOS could be a tablet's owner.",
			hint: "Run smartify-os tablet --install, which puts the newest build of your car's app on it, then try again.",
		};
	}
	const reason = /Exception:\s*(.+)/.exec(text)?.[1] ?? text.split('\n').slice(-4).join('\n');
	return { message: "SmartifyOS could not become the tablet's owner.", hint: reason };
}

/**
 * Makes the car's app the tablet's owner. Ask the owner first: an owner app cannot be
 * uninstalled until it stops being the owner, which only the app itself can do.
 *
 * @throws {CliError} when Android does not allow it, saying what to do about it.
 */
export async function makeDeviceOwner(tablet: Tablet, applicationId: string): Promise<void> {
	const result = await adb(tablet, [
		'shell',
		'dpm',
		'set-device-owner',
		`${applicationId}/${deviceAdminReceiver}`,
	]);
	const text = output(result);
	if (result.code === 0 && /success/i.test(text)) return;
	const failure = ownerFailure(text);
	throw new CliError(failure.message, { hint: failure.hint });
}

/**
 * Starts the car's app again on the tablet, so it works out afresh what it may do there (it
 * does so once as it starts), and shows it. Never throws, a tablet that does not start it
 * shows it the next time home is pressed.
 */
export async function restartApp(
	tablet: Tablet,
	applicationId: string,
	activity: string,
): Promise<void> {
	await adb(tablet, ['shell', 'am', 'force-stop', applicationId]);
	await adb(tablet, ['shell', 'am', 'start', '-n', activity]);
}
