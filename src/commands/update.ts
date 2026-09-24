import { branchCommit, defaultBranch, listReleases, readRemoteFile } from '../core/git.ts';
import { withCore, withExtension } from '../core/project/block.ts';
import {
	type CarState,
	describeVersion,
	type Installed,
	overridesOfInstalledCore,
} from '../core/project/car.ts';
import { tryChange, writePubspec } from '../core/project/change.ts';
import { requireCar } from '../core/project/find.ts';
import { newestFitting, type RemoteExtension } from '../core/project/remote.ts';
import {
	changelogBetween,
	coreAt,
	coreFolder,
	corePackage,
	coreReleases,
	coreRepoUrl,
	isReleaseTag,
	neededOverrides,
} from '../core/smartify-os.ts';
import { intro, log, outro } from '../ui/output.ts';
import { followSteps, readCarStep, renderChangeFailure, step } from '../ui/project.ts';
import { confirm, note, spinner } from '../ui/prompt.ts';
import { theme } from '../ui/theme.ts';
import { CliError } from '../utils/errors.ts';
import { compareVersions, lowerBound, meetsLowerBound } from '../utils/semver.ts';
import { binaryName } from './flags.ts';
import type { Command } from './types.ts';

/**
 * Moves the car to another SmartifyOS.
 *
 * This is the `update` CLAUDE.md kept free: the car project is the default, so updating
 * means updating the project. Extensions have their own `extension update`, but this one
 * updates them too when the new SmartifyOS needs it, since that is the only way through.
 */
export const updateCommand: Command = {
	name: 'update',
	aliases: ['upgrade'],
	summary: 'Move your car to a newer SmartifyOS',
	description:
		"Moves your car to the newest SmartifyOS, or to the version you name. It shows what changed, tries the new version, and keeps it only if your app and every extension still build. An extension that has not caught up is offered its newest release at the same time. Run it in your car's app folder.",
	examples: [
		`${binaryName} update`,
		`${binaryName} update --check`,
		`${binaryName} update --to 0.3.0`,
	],
	flags: {
		to: { type: 'string', describe: 'Move to one particular version, newer or older, like 0.3.0' },
		check: { type: 'boolean', describe: 'Only say whether there is a newer SmartifyOS' },
	},
	async run({ flags }) {
		const to = typeof flags.to === 'string' ? flags.to.replace(/^v/, '') : undefined;

		intro('Update');
		const app = await requireCar();
		const state = await readCarStep(app);
		const current = state.core;

		if (current.link) {
			throw new CliError(`SmartifyOS is linked to ${current.link}, so this car runs that copy.`, {
				hint: `Run ${theme.code(`${binaryName} unlink smartify_os_core`)} first.`,
			});
		}

		const target = await step('Looking for SmartifyOS releases', () => pickTarget(current, to));
		const unchanged = (to: string | null): UpdateResult => ({
			changed: false,
			from: describeVersion(current),
			to,
			extensions: [],
		});
		if (!target) {
			outro(`Your car has the newest SmartifyOS ${theme.dim(describeVersion(current))}`);
			return unchanged(null);
		}

		if (flags.check === true) {
			log.info(
				`SmartifyOS ${theme.strong(target.label)} is available, your car has ${describeVersion(current)}.`,
			);
			outro(`Run ${theme.code(`${binaryName} update`)} when you are ready.`);
			return unchanged(target.label);
		}

		const currentVersion = current.version ?? '0.0.0';
		const older = target.release && compareVersions(target.version, currentVersion) < 0;
		if (older) refuseTooOld(state, target.version);

		if (current.source.kind === 'path') {
			log.warn(
				`Your car uses SmartifyOS from the folder ${theme.code(current.source.path)} right now. This switches it to SmartifyOS ${target.label} from GitHub.`,
			);
			log.message(
				theme.dim(
					`To keep using that folder instead, run ${theme.code(`${binaryName} link <folder>`)}.`,
				),
			);
		}

		if (target.release && !older) await showChangelog(target.ref, currentVersion, target.version);

		const go =
			flags.yes === true ||
			(await confirm({
				message: `Move your car from SmartifyOS ${describeVersion(current)} to ${target.label}?`,
				initialValue: true,
			}));
		if (!go) {
			outro(`Left as it is ${theme.dim('(nothing was changed)')}`);
			return unchanged(target.label);
		}

		const moved = await moveCore(state, target.ref, { yes: flags.yes === true });
		outro(`Your car runs SmartifyOS ${theme.success(theme.strong(moved.label))}`);
		return {
			changed: true,
			from: describeVersion(current),
			to: moved.label,
			extensions: moved.extensions,
		} satisfies UpdateResult;
	},
};

/**
 * What `update` reports with `--json`. `to` is where the car went, or with `--check`, or
 * when the answer was no, where it could go. Null when it has the newest already.
 */
interface UpdateResult {
	changed: boolean;
	from: string;
	to: string | null;
	extensions: MovedExtension[];
}

/** An extension that was moved along with SmartifyOS. */
export interface MovedExtension {
	name: string;
	title: string;
	from: string;
	to: string;
}

/** Internal: the SmartifyOS to move to. */
interface Target {
	ref: string;
	version: string;
	/** Whether it is a release, rather than the newest commit of a branch. */
	release: boolean;
	label: string;
}

/**
 * Internal: which SmartifyOS `update` moves to, or undefined when the car has it already.
 *
 * The newest release, or the one asked for. While SmartifyOS has never made a release, the
 * newest commit of its default branch.
 */
async function pickTarget(current: Installed, to: string | undefined): Promise<Target | undefined> {
	const releases = await coreReleases();
	const currentRef = current.source.kind === 'git' ? current.source.ref : undefined;
	const onRelease = isReleaseTag(currentRef);

	if (to) {
		const release = releases.find((r) => r.version === to);
		if (!release) {
			const newest = releases
				.slice(0, 5)
				.map((r) => r.version)
				.join(', ');
			throw new CliError(`There is no SmartifyOS ${to}.`, {
				hint: newest
					? `These are the newest: ${newest}.`
					: 'SmartifyOS has not made a release yet.',
			});
		}
		if (onRelease && release.version === current.version) return undefined;
		return { ref: release.tag, version: release.version, release: true, label: release.version };
	}

	const [newest] = releases;
	if (newest) {
		const behind = !onRelease || compareVersions(newest.version, current.version ?? '0.0.0') > 0;
		if (!behind) return undefined;
		return { ref: newest.tag, version: newest.version, release: true, label: newest.version };
	}

	// No release yet: follow the newest commit instead.
	const { branch, commit } = await defaultBranch(coreRepoUrl());
	if (currentRef === branch && current.commit === commit) return undefined;
	return {
		ref: branch,
		version: current.version ?? '0.0.0',
		release: false,
		label: `${branch} (${commit.slice(0, 7)})`,
	};
}

/**
 * Internal: going back to an older SmartifyOS is refused when an extension needs a newer one,
 * naming them, since pub itself would never notice (the car's override hides it).
 */
function refuseTooOld(state: CarState, version: string): void {
	const blocking = state.extensions.filter(
		(extension) => !meetsLowerBound(extension.coreConstraint, version),
	);
	if (blocking.length === 0) return;

	const [only] = blocking;
	throw new CliError(
		only && blocking.length === 1
			? `${only.title} needs SmartifyOS ${lowerBound(only.coreConstraint)} or newer, so your car cannot go back to ${version}.`
			: `These extensions need a newer SmartifyOS than ${version}: ${blocking.map((e) => e.title).join(', ')}.`,
		{
			hint: `Remove ${blocking.length === 1 ? 'it' : 'them'} first with ${theme.code(`${binaryName} extension remove`)}, or pick a newer version.`,
		},
	);
}

/** Internal: what is new in SmartifyOS between the car's version and the one it moves to. */
async function showChangelog(ref: string, from: string, to: string): Promise<void> {
	const text = await readRemoteFile(coreRepoUrl(), ref, `${coreFolder}/CHANGELOG.md`).catch(
		() => undefined,
	);
	const news = text ? changelogBetween(text, from, to) : undefined;
	if (news) note(news, `What is new in SmartifyOS ${to}`);
}

/** Internal: an extension update offered because the new SmartifyOS needs it. */
type Offer =
	| { extension: Installed; to: RemoteExtension }
	| { extension: Installed; upgrade: true; commit: string };

/**
 * Moves the car to SmartifyOS at `ref` and keeps it only when everything still builds.
 *
 * When an extension does not build with it, its newest release that allows the new
 * SmartifyOS (or its newest commit, for one on a branch) is offered in the same step, and
 * it is tried again. When there is nothing to offer, the car stays as it was.
 *
 * Also used by `extension add`, for an extension that needs a newer SmartifyOS first.
 *
 * @returns how the new version reads, for the closing line, and the extensions moved with it.
 * @throws {CliError} when it does not work out, after putting everything back.
 */
export async function moveCore(
	state: CarState,
	ref: string,
	options: { yes: boolean },
): Promise<{ label: string; extensions: MovedExtension[] }> {
	const next = await step(`Reading SmartifyOS ${ref}`, () => coreAt(ref));
	const onBranch = !isReleaseTag(ref);
	const label = onBranch ? ref : next.version;
	const previous = await overridesOfInstalledCore(state);
	const moved = new Map<string, RemoteExtension>();
	const upgrades = new Set<string>(onBranch ? [corePackage] : []);
	/** The commit each extension on a branch is moved to, by package name. */
	const commits = new Map<string, string>();

	while (true) {
		const progress = spinner();
		progress.start(`Trying SmartifyOS ${label}`);
		const result = await tryChange(state.app, {
			async edit() {
				let text = withCore(
					state.pubspecText,
					next.source,
					neededOverrides(next.pubspecText),
					previous,
				);
				for (const [name, extension] of moved) text = withExtension(text, name, extension.source);
				await writePubspec(state.app, text);
			},
			upgrade: [...upgrades],
			onStep: followSteps(progress),
		});

		if (result.ok) {
			progress.stop(`Moved to SmartifyOS ${label}`);
			const extensions: MovedExtension[] = [];
			for (const [name, extension] of moved) {
				const installed = state.extensions.find((e) => e.name === name);
				const title = installed?.title ?? name;
				const to = extension.version ?? extension.source.ref ?? '';
				log.success(`${title} moved to ${to} with it`);
				extensions.push({ name, title, from: installed ? describeVersion(installed) : '', to });
			}
			for (const [name, commit] of commits) {
				const installed = state.extensions.find((e) => e.name === name);
				if (!installed) continue;
				const to = commit.slice(0, 7);
				extensions.push({ name, title: installed.title, from: describeVersion(installed), to });
			}
			return { label, extensions };
		}

		progress.error(`SmartifyOS ${label} does not fit this car yet`);
		const titleOf = (name: string) => state.extensions.find((e) => e.name === name)?.title ?? name;
		const stay = `Your car stays on SmartifyOS ${describeVersion(state.core)}, nothing was changed.`;

		const { failure } = result;
		if (failure.kind === 'fetch' || failure.problems.some((group) => !group.name)) {
			renderChangeFailure(failure, titleOf);
			throw new CliError(stay, {
				details: failure,
				hint:
					failure.kind === 'fetch'
						? `Something in your car needs a version of a package that SmartifyOS ${label} does not allow, see above.`
						: `Your app uses something that changed in SmartifyOS ${label}. Fix what is listed above, then run this again.`,
			});
		}

		const culprits = failure.problems
			.map((group) => state.extensions.find((e) => e.name === group.name))
			.filter(
				(e): e is Installed => e !== undefined && !moved.has(e.name) && !upgrades.has(e.name),
			);

		const offers = await step('Looking for extension updates that fit', () =>
			findOffers(culprits, next.version),
		);
		const behind = culprits.filter((e) => !offers.some((offer) => offer.extension === e));

		if (offers.length === 0 || behind.length > 0) {
			renderChangeFailure(failure, titleOf);
			for (const extension of behind) {
				log.warn(
					`${theme.strong(extension.title)} has not caught up with SmartifyOS ${label} yet.`,
				);
			}
			throw new CliError(stay, {
				details: { ...failure, behind: behind.map((e) => e.name) },
				hint: `Try again once ${behind.length === 1 ? 'it has' : 'they have'} a release for it, or remove ${behind.length === 1 ? 'it' : 'them'} with ${theme.code(`${binaryName} extension remove`)}.`,
			});
		}

		log.info(
			[
				`${offers.length === 1 ? 'This extension needs' : 'These extensions need'} updating for SmartifyOS ${label}:`,
				...offers.map(
					(offer) =>
						`  ${offer.extension.title} ${theme.dim(describeVersion(offer.extension))} ${theme.dim('to')} ${'to' in offer ? (offer.to.version ?? offer.to.source.ref) : offer.commit.slice(0, 7)}`,
				),
			].join('\n'),
		);
		const go =
			options.yes ||
			(await confirm({ message: 'Update them too, in the same step?', initialValue: true }));
		if (!go) throw new CliError(stay, { hint: 'Nothing was changed.' });

		for (const offer of offers) {
			if ('to' in offer) {
				moved.set(offer.extension.name, offer.to);
			} else {
				upgrades.add(offer.extension.name);
				commits.set(offer.extension.name, offer.commit);
			}
		}
	}
}

/**
 * Internal: for each extension that does not build with a new SmartifyOS, a newer release
 * that says it works with it, or its newest commit when it follows a branch.
 */
async function findOffers(extensions: Installed[], coreVersion: string): Promise<Offer[]> {
	const offers: Offer[] = [];
	for (const extension of extensions) {
		const source = extension.source;
		if (extension.link || source.kind !== 'git') continue;

		if (isReleaseTag(source.ref)) {
			const releases = await listReleases(source.url);
			const { fits } = await newestFitting(source.url, releases, coreVersion, extension.version);
			if (fits) offers.push({ extension, to: fits });
			continue;
		}

		const branch = source.ref ?? (await defaultBranch(source.url)).branch;
		const commit = await branchCommit(source.url, branch);
		if (commit && commit !== extension.commit) offers.push({ extension, upgrade: true, commit });
	}
	return offers;
}
