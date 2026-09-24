import {
	applyUpdate,
	type InstallStep,
	isUpdatable,
	planUpdate,
	type UpdatePlan,
} from '../core/self-update/install.ts';
import { intro, log, outro } from '../ui/output.ts';
import { confirm, spinner } from '../ui/prompt.ts';
import { theme } from '../ui/theme.ts';
import { CliError } from '../utils/errors.ts';
import { isNewer } from '../utils/semver.ts';
import { binaryName } from './flags.ts';
import type { Command } from './types.ts';

/** What each step of an install is called while it is happening. */
const stepText: Record<InstallStep, string> = {
	download: 'Downloading',
	verify: 'Checking the download is intact',
	unpack: 'Unpacking',
	check: 'Making sure it runs on this machine',
	swap: 'Putting it in place',
};

/**
 * Updates the CLI itself.
 *
 * Named `self-update` rather than `update` on purpose. Nearly every command still to come
 * acts on the car project, and the project will want updating too, so `update` has to stay
 * free to mean that. Saying `self` here is the one word that makes it unambiguous.
 */
export const selfUpdateCommand: Command = {
	name: 'self-update',
	aliases: ['self-upgrade'],
	summary: 'Update the SmartifyOS CLI itself to the newest version',
	description:
		'Downloads the newest SmartifyOS CLI, checks it against its published checksum, runs it to make sure it works on this machine, and only then replaces the one you have. This updates the tool, not your car project.',
	examples: [
		`${binaryName} self-update`,
		`${binaryName} self-update --check`,
		`${binaryName} self-update --to 0.2.0`,
	],
	flags: {
		check: { type: 'boolean', describe: 'Only say whether there is a newer version' },
		to: { type: 'string', describe: 'Install one particular version, for example 0.2.0' },
	},
	utility: true,
	async run({ flags }) {
		if (!isUpdatable()) {
			throw new CliError(
				'This SmartifyOS CLI runs from its source code, so there is nothing to replace.',
				{
					hint: `Run ${theme.code('git pull')} in the CLI repo instead.`,
				},
			);
		}

		const to = typeof flags.to === 'string' ? flags.to : undefined;

		intro('Self update');

		const looking = spinner();
		looking.start(to ? `Looking for ${to}` : 'Looking for the newest version');
		let plan: UpdatePlan;
		try {
			plan = await planUpdate({ to, baseUrl: process.env.SMARTIFY_OS_BASE_URL });
		} catch (error) {
			looking.error('Could not check');
			throw error;
		}
		looking.stop(`Newest is ${theme.strong(plan.targetVersion)}`);

		// Without --to, there is nothing to do unless GitHub has something newer. With --to,
		// the user named a version, so install exactly that one, up, down or sideways.
		if (!to && !isNewer(plan.targetVersion, plan.currentVersion)) {
			outro(`You already have the newest version ${theme.dim(`(${plan.currentVersion})`)}`);
			return { changed: false, from: plan.currentVersion, to: null };
		}

		if (flags.check === true) {
			log.info(
				`Version ${theme.strong(plan.targetVersion)} is available, you have ${plan.currentVersion}.`,
			);
			outro(`Run ${theme.code(`${binaryName} self-update`)} when you are ready.`);
			return { changed: false, from: plan.currentVersion, to: plan.targetVersion };
		}

		const go =
			flags.yes === true ||
			(await confirm({
				message: `Update from ${plan.currentVersion} to ${plan.targetVersion}?`,
				initialValue: true,
			}));

		if (!go) {
			outro(`Left as it is ${theme.dim('(nothing was changed)')}`);
			return { changed: false, from: plan.currentVersion, to: plan.targetVersion };
		}

		const work = spinner();
		work.start(stepText.download);
		try {
			await applyUpdate(plan, {
				onStep: (step) => work.message(stepText[step]),
				onProgress: (received, total) => work.message(downloadedSoFar(received, total)),
			});
		} catch (error) {
			work.error('Stopped');
			throw error;
		}
		work.stop(`Updated to ${theme.success(theme.strong(plan.targetVersion))}`);

		outro('All done. The next command you run is the new one.');
		return { changed: true, from: plan.currentVersion, to: plan.targetVersion };
	},
};

/** Internal: the download line, as a percentage when the size is known and MB when it is not. */
function downloadedSoFar(received: number, total: number): string {
	const megabytes = (received / 1024 / 1024).toFixed(1);
	if (total <= 0) return `${stepText.download} ${theme.dim(`${megabytes} MB`)}`;

	const percent = Math.floor((received / total) * 100);
	return `${stepText.download} ${theme.dim(`${percent}%`)}`;
}
