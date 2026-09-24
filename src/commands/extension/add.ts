import { displayUrl, listReleases, normalizeRepoUrl, type Release } from '../../core/git.ts';
import { withExtension } from '../../core/project/block.ts';
import {
	type CarState,
	describeVersion,
	findEntry,
	titleFromPackage,
	titleOf,
} from '../../core/project/car.ts';
import { tryChange, writePubspec } from '../../core/project/change.ts';
import { carFiles, requireCar } from '../../core/project/find.ts';
import { type SwitchResult, switchOnInFile } from '../../core/project/main-dart.ts';
import {
	newestExtension,
	newestFitting,
	type RemoteExtension,
	readRemoteExtension,
} from '../../core/project/remote.ts';
import { readPackageRoots } from '../../core/pubspec/read.ts';
import { coreReleases } from '../../core/smartify-os.ts';
import { intro, log, outro } from '../../ui/output.ts';
import { followSteps, readCarStep, renderChangeFailure, step } from '../../ui/project.ts';
import { isInteractive, select, spinner, text } from '../../ui/prompt.ts';
import { renderSwitchOn, switchData } from '../../ui/switch-on.ts';
import { theme } from '../../ui/theme.ts';
import { CliError } from '../../utils/errors.ts';
import { lowerBound, meetsLowerBound } from '../../utils/semver.ts';
import { binaryName } from '../flags.ts';
import type { Command } from '../types.ts';
import { type MovedExtension, moveCore } from '../update.ts';

/**
 * Adds an extension to the car from its repository.
 */
export const extensionAddCommand: Command = {
	name: 'add',
	aliases: ['install'],
	summary: 'Add an extension to your car',
	description:
		"Adds an extension to your car from its GitHub address. It takes the newest release, or the newest commit when there has never been one, checks it works with your car's SmartifyOS, and keeps it only if everything still builds. Then it switches it on in lib/main.dart. Run it in your car's app folder.",
	usage: '<url>',
	examples: [
		`${binaryName} extension add https://github.com/Mauznemo/smartify_os_android_auto`,
		`${binaryName} extension add Mauznemo/smartify_os_android_auto --version 0.1.0`,
	],
	flags: {
		version: { type: 'string', describe: 'Add one particular release, for example 0.1.0' },
	},
	async run({ flags, positionals }) {
		intro('Add an extension');
		const app = await requireCar();

		const input =
			positionals[0] ??
			(await text({
				message: 'Where is the extension? Paste its GitHub address.',
				placeholder: 'https://github.com/someone/smartify_os_dashcam',
				validate: (value) => (value?.trim() ? undefined : 'The address is needed to find it.'),
			}));
		const url = normalizeRepoUrl(input);
		const wanted = typeof flags.version === 'string' ? flags.version.replace(/^v/, '') : undefined;

		let state = await readCarStep(app);
		const found = await step(
			`Looking at ${displayUrl(url)}`,
			() => lookUp(url, wanted),
			(found) => `Found ${titleFromPackage(found.extension.packageName)}`,
		);
		let extension = found.extension;

		const already = state.extensions.find((e) => e.name === extension.packageName);
		if (already) {
			throw new CliError(`${already.title} is in this car already (${describeVersion(already)}).`, {
				hint: `Run ${theme.code(`${binaryName} extension update ${shortName(already.name)}`)} to move it to a newer one.`,
			});
		}

		const title = titleFromPackage(extension.packageName);
		if (extension.onBranch) {
			log.info(
				`${theme.strong(title)} has no releases yet, so its newest commit on ${theme.code(extension.source.ref)} is used.`,
			);
		} else {
			log.info(
				`${theme.strong(title)} ${extension.version ?? extension.source.ref} is ${wanted ? 'the release you asked for' : 'its newest release'}.`,
			);
		}

		const coreVersion = state.core.version ?? '0.0.0';
		let movedCore: { from: string; to: string; extensions: MovedExtension[] } | null = null;
		if (!meetsLowerBound(extension.coreConstraint, coreVersion)) {
			const from = describeVersion(state.core);
			const choice = await resolveTooNew(state, extension, found.releases, title);
			if (choice.kind === 'older') {
				extension = choice.extension;
			} else {
				state = await readCarStep(app);
				movedCore = { from, to: choice.label, extensions: choice.extensions };
			}
		}

		const progress = spinner();
		progress.start(`Adding ${title}`);
		let switched: SwitchResult | undefined;
		const result = await tryChange(app, {
			edit: () =>
				writePubspec(
					app,
					withExtension(state.pubspecText, extension.packageName, extension.source),
				),
			async afterFetch() {
				const root = (await readPackageRoots(app.dir)).get(extension.packageName);
				const entry = root ? await findEntry(extension.packageName, root) : undefined;
				switched = await switchOnInFile(carFiles(app).main, entry);
			},
			onStep: followSteps(progress),
		});

		if (!result.ok) {
			progress.error(`${title} does not fit this car`);
			renderChangeFailure(result.failure, (name) =>
				name === extension.packageName ? title : name,
			);
			throw new CliError(`${title} was not added, nothing was changed.`, {
				details: result.failure,
				hint:
					result.failure.kind === 'build'
						? `It does not build with SmartifyOS ${state.core.version ?? coreVersion}. Its author may not have caught up with it yet.`
						: 'It needs packages that cannot be used together with the ones in your car.',
			});
		}

		const root = (await readPackageRoots(app.dir)).get(extension.packageName);
		const finalTitle = await titleOf(extension.packageName, root);
		progress.stop(
			`Added ${theme.strong(finalTitle)} ${theme.dim(extension.onBranch ? extension.source.ref : (extension.version ?? ''))}`,
		);
		renderSwitchOn(switched, extension.packageName);
		outro('All done. It is in your car the next time you run it.');
		return {
			changed: true,
			extension: {
				name: extension.packageName,
				title: finalTitle,
				version: extension.version ?? null,
				source: extension.source,
				onBranch: extension.onBranch,
			},
			switchedOn: switchData(switched),
			// Set when SmartifyOS had to move first to make room for it.
			smartifyOs: movedCore,
		};
	},
};

/** `smartify_os_dashcam` becomes `dashcam`, which is what people type. */
export function shortName(packageName: string): string {
	return packageName.replace(/^smartify_os_/, '');
}

/** Internal: the release asked for, or the newest there is. */
async function lookUp(
	url: string,
	wanted: string | undefined,
): Promise<{ releases: Release[]; extension: RemoteExtension }> {
	if (!wanted) {
		const { releases, newest } = await newestExtension(url);
		return { releases, extension: newest };
	}

	const releases = await listReleases(url);
	const release = releases.find((r) => r.version === wanted);
	if (!release) {
		const newest = releases
			.slice(0, 5)
			.map((r) => r.version)
			.join(', ');
		throw new CliError(`${displayUrl(url)} has no release ${wanted}.`, {
			hint: newest ? `These are the newest: ${newest}.` : 'It has not made any release yet.',
		});
	}
	return { releases, extension: await readRemoteExtension(url, release.tag, false) };
}

/**
 * Internal: an extension that needs a newer SmartifyOS than the car has. The car can move to
 * a SmartifyOS that fits, or take an older release of the extension that fits the car.
 */
async function resolveTooNew(
	state: CarState,
	extension: RemoteExtension,
	releases: Release[],
	title: string,
): Promise<
	| ({ kind: 'moved' } & Awaited<ReturnType<typeof moveCore>>)
	| { kind: 'older'; extension: RemoteExtension }
> {
	const needed = lowerBound(extension.coreConstraint) ?? '?';
	const coreVersion = state.core.version ?? '0.0.0';
	log.warn(
		`${theme.strong(title)} needs SmartifyOS ${needed} or newer, your car has ${coreVersion}.`,
	);

	const [newCore, older] = await step('Looking for a way to fit it in', async () => {
		const cores = await coreReleases();
		const core = cores.find((release) =>
			meetsLowerBound(extension.coreConstraint, release.version),
		);
		const { fits } = await newestFitting(extension.source.url, releases, coreVersion);
		return [core, fits] as const;
	});

	const options: { value: 'core' | 'older'; label: string; hint?: string }[] = [];
	if (newCore && !state.core.link) {
		options.push({
			value: 'core',
			label: `Move your car to SmartifyOS ${newCore.version} first`,
			hint: 'recommended',
		});
	}
	if (older) {
		options.push({
			value: 'older',
			label: `Add ${title} ${older.version} instead`,
			hint: 'an older release that fits',
		});
	}

	if (options.length === 0) {
		throw new CliError(`${title} needs a SmartifyOS that has not been released yet.`, {
			hint: 'Try again once there is a release of SmartifyOS it works with.',
		});
	}

	if (!isInteractive()) {
		throw new CliError(`${title} needs a newer SmartifyOS than your car has.`, {
			hint: [
				newCore
					? `Run ${theme.code(`${binaryName} update --to ${newCore.version}`)} first, then add it again.`
					: '',
				older
					? `Or add ${theme.code(`--version ${older.version}`)}, an older release that fits.`
					: '',
			]
				.filter(Boolean)
				.join('\n'),
		});
	}

	const choice = await select({ message: 'What would you like to do?', options });
	if (choice === 'older' && older) return { kind: 'older', extension: older };
	if (!newCore) throw new CliError('Nothing was changed.');

	const moved = await moveCore(state, newCore.tag, { yes: false });
	return { kind: 'moved', ...moved };
}
