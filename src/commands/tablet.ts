import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildApk, readApplicationId } from '../core/android/apk.ts';
import {
	findAdb,
	installApk,
	makeDeviceOwner,
	readTablet,
	restartApp,
	setHomeScreen,
	type Tablet,
	type TabletState,
} from '../core/android/tablet.ts';
import { requireCar } from '../core/project/find.ts';
import { ensureAndroidTools, pickAndroidDevice, prepareAndroid } from '../ui/android.ts';
import { intro, log, outro } from '../ui/output.ts';
import { readCarStep, step } from '../ui/project.ts';
import { confirm, isInteractive, note } from '../ui/prompt.ts';
import { theme } from '../ui/theme.ts';
import { CliError } from '../utils/errors.ts';
import { binaryName } from './flags.ts';
import type { Command } from './types.ts';

/** What the question about making SmartifyOS the tablet's owner says it means. */
const ownerQuestion =
	"Make your car's app the tablet's owner too? It can then restart the tablet, set its clock, update itself from a USB stick without asking, and allow itself everything it needs without a question on screen. While it is the owner it cannot be uninstalled: its Settings, System, Developer options, Android has Stop being the tablet's owner for that. Android only allows it on a tablet with no Google or other account on it.";

/** Where the app's own way out of being the owner is, for the notes. */
const stopOwner =
	"To uninstall it later, first tap Stop being the tablet's owner in its Settings, System, Developer options, Android.";

/**
 * Sets an Android tablet up as the car's screen, over USB, once per tablet: puts the car's
 * app on it when it is not there, makes it the tablet's home screen, and asks whether it
 * should be the tablet's owner as well (src/core/android/tablet.ts says what that means).
 */
export const tabletCommand: Command = {
	name: 'tablet',
	summary: "Set up an Android tablet as your car's screen",
	description:
		"Sets up an Android tablet plugged into this computer as your car's screen: puts your car's app on it if it is not there yet, makes it what the tablet starts into and what its home button goes back to, and asks whether it should be the tablet's owner too, which lets it restart the tablet, set its clock, update itself from a USB stick without asking and allow itself everything it needs. Do it once per tablet, it stays that way when you update the app. Run it in your car's app folder, with USB debugging switched on on the tablet.",
	examples: [
		`${binaryName} tablet`,
		`${binaryName} tablet --owner`,
		`${binaryName} tablet --install --no-owner`,
	],
	flags: {
		device: {
			type: 'string',
			describe: 'Which Android device, by its id, when more than one is plugged in',
		},
		install: {
			type: 'boolean',
			describe: "Build your car's app and put it on the tablet even when it is there already",
		},
		owner: {
			type: 'boolean',
			describe: "Make your car's app the tablet's owner without asking",
		},
		'no-owner': {
			type: 'boolean',
			describe: "Leave the tablet's owner as it is, without asking",
		},
	},
	async run({ flags }) {
		if (flags.owner === true && flags['no-owner'] === true) {
			throw new CliError('--owner and --no-owner say opposite things.', {
				hint: 'Pass one of them, or neither to be asked.',
			});
		}
		const yes = flags.yes === true;
		intro('Set up a tablet');
		const app = await requireCar();
		const state = await readCarStep(app);
		await ensureAndroidTools(yes);
		const device = await pickAndroidDevice(flags.device, 'set up');
		const tablet: Tablet = { adb: await findAdb(), serial: device.id };
		const name = theme.strong(device.name);

		const hasAndroid = existsSync(join(app.dir, 'android'));
		let applicationId = hasAndroid ? await readApplicationId(app.dir) : undefined;
		let found: TabletState | undefined = applicationId
			? await step(
					`Looking at ${device.name}`,
					() => readTablet(tablet, applicationId as string),
					(found) =>
						found.installed
							? `Your car's app is on ${device.name}`
							: `Your car's app is not on ${device.name} yet`,
				)
			: undefined;

		// Put the app on it: when it is not there, when it is from before it could be the home
		// screen, or when asked to.
		const outdated = found?.installed === true && found.homeActivity === undefined;
		let install = flags.install === true;
		if (!install && !found?.installed) {
			install = await ask(
				`Your car's app is not on ${device.name} yet. Build it and put it on there now? The first build takes ten minutes or more.`,
				yes,
			);
			if (!install) {
				throw new CliError(`Your car's app has to be on ${device.name} first.`, {
					hint: `Run ${binaryName} tablet again and say yes, or ${binaryName} run --android.`,
				});
			}
		} else if (!install && outdated) {
			install = await ask(
				`The app on ${device.name} is from before SmartifyOS could be a tablet's home screen. Build it again and put the new one on there? It keeps its settings.`,
				yes,
			);
		}
		if (install) {
			await prepareAndroid(state, yes);
			applicationId = await readApplicationId(app.dir);
			const apk = await step(
				'Building it for Android (ten minutes or more the first time)',
				() => buildApk(app.dir),
				() => 'Built it for Android',
			);
			await step(
				`Putting it on ${device.name}`,
				() => installApk(tablet, apk),
				() => `Put your car's app on ${device.name}`,
			);
			found = await readTablet(tablet, applicationId);
		}
		if (!applicationId || !found) throw new CliError("Your car's app has no Android part yet.");
		const id = applicationId;

		// The home screen.
		let home: 'set' | 'already' | 'outdated';
		const activity = found.homeActivity;
		if (found.isHome) {
			home = 'already';
			log.success(`Your car's app is ${name}'s home screen already`);
		} else if (activity) {
			await step(
				`Making your car's app ${device.name}'s home screen`,
				() => setHomeScreen(tablet, activity),
				() => `${device.name} starts into your car's app now, and its home button goes back to it`,
			);
			home = 'set';
		} else {
			home = 'outdated';
			log.warn(
				`The app on ${name} cannot be its home screen yet. Run ${theme.code(`${binaryName} tablet --install`)} to put the newest one on it.`,
			);
		}

		// The owner, only ever once the owner said so.
		let owner: 'set' | 'already' | 'skipped';
		if (found.owner === id) {
			owner = 'already';
			log.success(`Your car's app is ${name}'s owner already`);
		} else {
			const wanted =
				flags.owner === true ||
				(flags['no-owner'] !== true &&
					!yes &&
					isInteractive() &&
					(await confirm({
						message: ownerQuestion,
						initialValue: true,
					})));
			if (wanted) {
				if (found.owner) {
					throw new CliError(
						`Another app, ${found.owner}, is already the owner of ${device.name}.`,
						{
							hint: `A tablet has only one owner. Take that app off as the owner in its own settings, or reset the tablet to factory settings and skip signing in, then run ${binaryName} tablet again.`,
						},
					);
				}
				await step(
					`Making your car's app ${device.name}'s owner`,
					() => makeDeviceOwner(tablet, id),
					() => `Your car's app is ${device.name}'s owner now`,
				);
				owner = 'set';
			} else {
				owner = 'skipped';
				if (flags['no-owner'] !== true) {
					log.info(
						`Your car's app is not ${name}'s owner. ${theme.code(`${binaryName} tablet --owner`)} makes it one later.`,
					);
				}
			}
		}

		// Started again, so it sees what it may do now and shows on the tablet.
		const changed = install || home === 'set' || owner === 'set';
		if (changed && activity) await restartApp(tablet, id, activity);

		if (owner === 'set' || owner === 'already') note(stopOwner, 'Uninstalling it');
		outro(changed ? `${device.name} is set up as your car's screen.` : 'Nothing to change.');
		return {
			changed,
			device: { id: device.id, name: device.name },
			applicationId: id,
			installed: install,
			home,
			owner,
		};
	},
};

/** Internal: a yes or no question that `--yes` answers yes and nobody to answer answers no. */
async function ask(message: string, yes: boolean): Promise<boolean> {
	if (yes) return true;
	if (!isInteractive()) return false;
	return await confirm({ message, initialValue: true });
}
