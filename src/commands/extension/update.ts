import { branchCommit, defaultBranch, listReleases } from '../../core/git.ts';
import { withExtension } from '../../core/project/block.ts';
import { describeVersion, type Installed } from '../../core/project/car.ts';
import { tryChange, writePubspec } from '../../core/project/change.ts';
import { requireCar } from '../../core/project/find.ts';
import { newestFitting, type RemoteExtension } from '../../core/project/remote.ts';
import { isReleaseTag } from '../../core/smartify-os.ts';
import { intro, log, outro } from '../../ui/output.ts';
import { followSteps, readCarStep, renderChangeFailure, step } from '../../ui/project.ts';
import { confirm, isInteractive, multiselect, spinner } from '../../ui/prompt.ts';
import { theme } from '../../ui/theme.ts';
import { CliError } from '../../utils/errors.ts';
import { lowerBound } from '../../utils/semver.ts';
import { binaryName } from '../flags.ts';
import type { Command } from '../types.ts';
import { pickInstalled } from './pick.ts';

/** Internal: one extension that can move on, and to what. */
type Plan =
	| { extension: Installed; to: RemoteExtension }
	| { extension: Installed; upgrade: true; commit: string };

/**
 * Moves extensions on to their newest release that works with the car's SmartifyOS.
 */
export const extensionUpdateCommand: Command = {
	name: 'update',
	aliases: ['upgrade'],
	summary: "Update your car's extensions",
	description:
		"Moves every extension, or the one you name, to its newest release that works with your car's SmartifyOS, or to its newest commit for one without releases. It keeps the update only if everything still builds. To move SmartifyOS itself, use update. Run it in your car's app folder.",
	usage: '[name]',
	examples: [
		`${binaryName} extension update`,
		`${binaryName} extension update android_auto`,
		`${binaryName} extension update --check`,
	],
	flags: {
		check: { type: 'boolean', describe: 'Only say which extensions have an update' },
	},
	async run({ flags, positionals }) {
		intro('Update extensions');
		const app = await requireCar();
		const state = await readCarStep(app);

		if (state.extensions.length === 0) {
			outro(
				`This car has no extensions yet. Add one with ${theme.code(`${binaryName} extension add`)}.`,
			);
			return;
		}

		const chosen = positionals[0]
			? [await pickInstalled(state.extensions, positionals[0], '')]
			: state.extensions;
		const coreVersion = state.core.version ?? '0.0.0';

		const found = await step('Looking for updates', () => findPlans(chosen, coreVersion));
		for (const note of found.notes) log.info(note);

		if (found.plans.length === 0) {
			outro(`${chosen.length === 1 ? 'It is' : 'Everything is'} up to date`);
			return;
		}

		log.info(
			[
				'Updates:',
				...found.plans.map(
					(plan) =>
						`  ${plan.extension.title} ${theme.dim(describeVersion(plan.extension))} ${theme.dim('to')} ${target(plan)}`,
				),
			].join('\n'),
		);

		if (flags.check === true) {
			outro(`Run ${theme.code(`${binaryName} extension update`)} when you are ready.`);
			return;
		}

		let plans = found.plans;
		if (flags.yes !== true && isInteractive()) {
			if (plans.length > 1) {
				const picked = await multiselect({
					message: 'Which ones?',
					options: plans.map((plan) => ({
						value: plan.extension.name,
						label: plan.extension.title,
						hint: target(plan),
					})),
					initialValues: plans.map((plan) => plan.extension.name),
					required: false,
				});
				plans = plans.filter((plan) => picked.includes(plan.extension.name));
			} else if (!(await confirm({ message: 'Update it?', initialValue: true }))) {
				plans = [];
			}
		} else if (flags.yes !== true) {
			throw new CliError(
				'Needed to ask which extensions to update, but there is nobody to answer.',
				{
					hint: `Pass ${theme.code('--yes')} to update all of them.`,
				},
			);
		}

		if (plans.length === 0) {
			outro(`Left as they are ${theme.dim('(nothing was changed)')}`);
			return;
		}

		const titleOf = (name: string) => state.extensions.find((e) => e.name === name)?.title ?? name;

		// When some of them do not build, the rest are tried again without them, once.
		for (let attempt = 0; attempt < 2 && plans.length > 0; attempt++) {
			const progress = spinner();
			progress.start(`Updating ${plans.map((plan) => plan.extension.title).join(', ')}`);
			const current = plans;
			const result = await tryChange(app, {
				async edit() {
					let text = state.pubspecText;
					for (const plan of current) {
						if ('to' in plan) text = withExtension(text, plan.extension.name, plan.to.source);
					}
					await writePubspec(app, text);
				},
				upgrade: current.filter((plan) => 'upgrade' in plan).map((plan) => plan.extension.name),
				onStep: followSteps(progress),
			});

			if (result.ok) {
				progress.stop(
					`Updated ${current.map((plan) => `${theme.strong(plan.extension.title)} to ${target(plan)}`).join(', ')}`,
				);
				outro('All done.');
				return;
			}

			progress.error('That did not fit');
			renderChangeFailure(result.failure, titleOf);

			const failing =
				result.failure.kind === 'build'
					? new Set(result.failure.problems.map((group) => group.name))
					: new Set<string | undefined>();
			const rest = current.filter((plan) => !failing.has(plan.extension.name));
			if (
				result.failure.kind === 'fetch' ||
				failing.has(undefined) ||
				rest.length === current.length
			)
				break;

			for (const plan of current.filter((p) => failing.has(p.extension.name))) {
				log.warn(
					`${theme.strong(plan.extension.title)} ${target(plan)} does not build in this car, it is left out.`,
				);
			}
			plans = rest;
		}

		throw new CliError('Nothing was updated, your car is as it was.', {
			hint: 'The errors above say what did not fit.',
		});
	},
};

/** Internal: what a plan moves an extension to, in words. */
function target(plan: Plan): string {
	return 'to' in plan ? (plan.to.version ?? plan.to.source.ref) : `${plan.commit.slice(0, 7)}`;
}

/**
 * Internal: for each extension, the newest release that works with the car's SmartifyOS,
 * or the newest commit of its branch, plus a note for each that cannot move and why.
 */
async function findPlans(
	extensions: Installed[],
	coreVersion: string,
): Promise<{ plans: Plan[]; notes: string[] }> {
	const plans: Plan[] = [];
	const notes: string[] = [];

	for (const extension of extensions) {
		const source = extension.source;
		if (extension.link) {
			notes.push(`${extension.title} is linked to ${extension.link}, so it is left alone.`);
			continue;
		}
		if (source.kind !== 'git') {
			notes.push(`${extension.title} does not come from a repository, so it is left alone.`);
			continue;
		}

		if (isReleaseTag(source.ref)) {
			const releases = await listReleases(source.url);
			const { fits, needsNewerCore } = await newestFitting(
				source.url,
				releases,
				coreVersion,
				extension.version,
			);
			const [newest] = needsNewerCore;
			if (newest) {
				notes.push(
					`${extension.title} ${newest.version} needs SmartifyOS ${lowerBound(newest.coreConstraint)}. Run ${theme.code(`${binaryName} update`)} to move your car there.`,
				);
			}
			if (fits) plans.push({ extension, to: fits });
			continue;
		}

		const branch = source.ref ?? (await defaultBranch(source.url)).branch;
		const commit = await branchCommit(source.url, branch);
		if (commit && commit !== extension.commit) plans.push({ extension, upgrade: true, commit });
	}

	return { plans, notes };
}
