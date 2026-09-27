import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
	buildBundle,
	binaryName as bundleBinaryName,
	bundleLibraries,
	writeBuildTools,
} from '../../core/export/build.ts';
import { type Builder, type FindBuilder, findBuilder } from '../../core/export/builder.ts';
import { buildInContainer, type ContainerStep } from '../../core/export/container.ts';
import { listDrives } from '../../core/export/drives.ts';
import {
	type BuildOn,
	type Built,
	type ExportKind,
	exportFolderName,
	exportSets,
	readExistingExport,
	writeExport,
} from '../../core/export/export.ts';
import { addPlatforms, type FlutterVersion, flutterVersion } from '../../core/flutter.ts';
import { type CarNeeds, collectNeeds } from '../../core/linux/collect.ts';
import { hostArch, type LinuxArch, linuxArchs, officialLinux } from '../../core/linux/distro.ts';
import { runInTerminal, runStreaming } from '../../core/process.ts';
import type { CarState } from '../../core/project/car.ts';
import { requireCar } from '../../core/project/find.ts';
import { emit, isJsonMode } from '../../ui/json.ts';
import { describeSets, renderNeedProblems, setData } from '../../ui/linux.ts';
import { intro, log, outro } from '../../ui/output.ts';
import { readCarStep, step } from '../../ui/project.ts';
import { confirm, isInteractive, note, select, spinner, text } from '../../ui/prompt.ts';
import { theme } from '../../ui/theme.ts';
import { CliError } from '../../utils/errors.ts';
import { binaryName } from '../flags.ts';
import type { FlagSpec, Flags } from '../types.ts';

/**
 * What `export installer` and `export update` share, which is nearly everything: an update
 * is an installer without install.sh.
 */

/** The flags both take. */
export const exportFlags: Record<string, FlagSpec> = {
	to: {
		type: 'string',
		describe: 'The USB stick to put it on, or any folder to copy onto one later',
	},
	'build-on': {
		type: 'string',
		describe: 'Where SmartifyOS is built: car, or computer (this one)',
	},
	arch: {
		type: 'string',
		describe: "The car's architecture when this computer builds: x64, or arm64 (a Raspberry Pi)",
	},
};

/** What an export did, as `--json` reports it. The same shape when nothing was written. */
export interface ExportData {
	changed: boolean;
	kind: ExportKind;
	buildOn: BuildOn;
	/** The `smartify-os` folder written, null when nothing was. */
	folder: string | null;
	files: string[];
	/** The architecture of the finished build, null when the car builds it. */
	arch: string | null;
	/** How this computer built it, null when the car builds it. */
	builder: 'docker' | 'podman' | 'native' | null;
	/** The Flutter it is built with, the same as this computer's. */
	flutter: FlutterVersion | null;
	sets: ReturnType<typeof setData>[];
	/** Problems in the lists of the car's packages. Those entries were left out. */
	problems: CarNeeds['problems'];
	/** Libraries the build links against that no package installed. */
	warnings: string[];
}

export async function runExport(kind: ExportKind, flags: Flags): Promise<ExportData> {
	intro(kind === 'installer' ? 'Make an installer' : 'Make an update');
	const app = await requireCar();
	const state = await readCarStep(app);

	const binary = await ensureLinux(state);
	const found = await findBuilder();
	const buildOn = await pickBuildOn(flags['build-on'], found);
	const builder = buildOn === 'computer' && found.ok ? found.builder : undefined;
	const arch = builder ? await pickArch(flags.arch, builder) : undefined;

	const needs = await step(
		'Reading what your car needs installed',
		() => collectNeeds(app.dir),
		(needs) => describeSets(exportSets({ buildOn, needs })),
	);
	renderNeedProblems(needs.problems);
	if (state.links.size > 0) {
		const titles = [...state.links.keys()].map((name) =>
			theme.strong(
				name === state.core.name
					? state.core.title
					: (state.extensions.find((e) => e.name === name)?.title ?? name),
			),
		);
		log.info(
			`Your car uses ${titles.join(' and ')} from ${titles.length === 1 ? 'a folder' : 'folders'} on this computer, and ${titles.length === 1 ? 'that copy is' : 'those copies are'} what goes on the stick.`,
		);
	}

	const target = await pickTarget(flags.to);
	const data = (changed: boolean, extra: Partial<ExportData> = {}): ExportData => ({
		changed,
		kind,
		buildOn,
		folder: null,
		files: [],
		arch: null,
		builder: null,
		flutter: null,
		sets: exportSets({ buildOn, needs }).map(setData),
		problems: needs.problems,
		warnings: [],
		...extra,
	});

	const existing = await readExistingExport(target);
	if (existing) {
		const what = existing.kind === 'installer' ? 'an installer' : 'an update';
		const go =
			flags.yes === true ||
			(await confirm({
				message: `There is ${what}${existing.app ? ` for ${existing.app}` : ''} on it already. Replace it?`,
				initialValue: true,
			}));
		if (!go) {
			outro(`Left as it is ${theme.dim('(nothing was changed)')}`);
			return data(false);
		}
	}

	const flutter = await step(
		'Checking which Flutter to build with',
		() => flutterVersion(),
		(found) =>
			`${buildOn === 'car' ? 'The car builds' : 'It is built'} with Flutter ${found.version}, the same as this computer`,
	);

	let built: (Built & { remove?: () => Promise<void> }) | undefined;
	let warnings: string[] = [];
	if (builder && arch) {
		({ built, warnings } = await buildOnThisComputer(builder, arch, state, needs, flutter));
	}

	let result: Awaited<ReturnType<typeof writeExport>>;
	try {
		result = await step(
			`Putting ${kind === 'installer' ? 'the installer' : 'the update'} on it`,
			() => writeExport({ kind, buildOn, state, needs, binary, flutter, built }, target),
			(result) => `Written to ${theme.code(result.folder)}`,
		);
	} finally {
		await built?.remove?.();
	}

	if (kind === 'installer') {
		note(
			[
				`1. Install ${officialLinux.name} on the car (${officialLinux.piName} on a Raspberry Pi), and log in as the user SmartifyOS runs as.`,
				'2. Plug the stick in and open a terminal.',
				`3. Run ${theme.code(`bash /media/<you>/<stick>/${exportFolderName}/install.sh`)}`,
				'',
				theme.dim(
					`It asks for the password once, and needs the internet.${buildOn === 'car' ? ' Building on the car takes a while the first time.' : ''}`,
				),
			].join('\n'),
			'On the car',
		);
	}
	outro(
		kind === 'installer'
			? 'All done. README.txt on the stick says the same.'
			: 'All done. Plug it into the car while SmartifyOS runs, and it offers the update.',
	);

	return data(true, {
		folder: result.folder,
		files: result.files,
		arch: built?.arch ?? null,
		builder: builder ? (builder.kind === 'container' ? builder.engine : 'native') : null,
		flutter,
		sets: result.sets.map(setData),
		warnings,
	});
}

/**
 * Internal: the name of the program the build makes. A car's app made without a Linux part
 * gets one, since the car cannot run it otherwise.
 */
async function ensureLinux(state: CarState): Promise<string> {
	const found = await bundleBinaryName(state.app.dir);
	if (found) return found;

	const name = /^name:\s*(\S+)/m.exec(state.pubspecText)?.[1] ?? 'app';
	await step(
		"Your car's app has no Linux part yet, adding it",
		() => addPlatforms(state.app.dir, ['linux'], name),
		() => "Added the Linux part to your car's app",
	);
	return (await bundleBinaryName(state.app.dir)) ?? name;
}

/** Internal: where it is built, from the flag or by asking when this computer can do it. */
async function pickBuildOn(given: Flags[string], found: FindBuilder): Promise<BuildOn> {
	if (given !== undefined) {
		if (given !== 'car' && given !== 'computer') {
			throw new CliError(`--build-on is car or computer, not ${String(given)}.`, {
				hint: `${theme.code('--build-on car')} builds it on the car, ${theme.code('--build-on computer')} on this computer.`,
			});
		}
		if (given === 'computer' && !found.ok) {
			throw new CliError(found.reason, {
				hint: `${found.hint} Or pass ${theme.code('--build-on car')}, and the car builds it for itself.`,
			});
		}
		return given;
	}

	if (!found.ok) {
		log.info(`SmartifyOS is built on the car. ${theme.dim(`${found.reason} ${found.hint}`)}`);
		return 'car';
	}

	return await select<BuildOn>({
		message: 'Where should SmartifyOS be built?',
		options: [
			{
				value: 'computer',
				label: 'On this computer',
				hint:
					found.builder.kind === 'container'
						? 'in Docker, the car only installs the finished app'
						: `for ${found.builder.arch} cars, the car only installs the finished app`,
			},
			{
				value: 'car',
				label: 'On the car',
				hint: 'it needs the internet and takes a while there',
			},
		],
	});
}

/**
 * Internal: the architecture of the car, from the flag or by asking. A build right here can
 * only be for this computer's own.
 */
async function pickArch(given: Flags[string], builder: Builder): Promise<LinuxArch> {
	if (given !== undefined && !linuxArchs.includes(given as LinuxArch)) {
		throw new CliError(`--arch is x64 or arm64, not ${String(given)}.`, {
			hint: `${theme.code('--arch arm64')} for a Raspberry Pi, ${theme.code('--arch x64')} for a PC.`,
		});
	}
	if (builder.kind === 'native') {
		if (given !== undefined && given !== builder.arch) {
			throw new CliError(`This computer can only build for ${builder.arch} cars.`, {
				hint: 'Install Docker to build for the other one, or let the car build it for itself.',
			});
		}
		return builder.arch;
	}

	const arch =
		(given as LinuxArch | undefined) ??
		(await select<LinuxArch>({
			message: 'What does the car run on?',
			options: [
				{ value: 'arm64', label: 'A Raspberry Pi', hint: 'or another ARM board, arm64' },
				{ value: 'x64', label: 'A PC or mini PC', hint: 'Intel or AMD, x64' },
			],
			initialValue: hostArch() ?? 'x64',
		}));
	if (arch !== hostArch()) {
		log.info(
			`This computer is not ${arch}, so the build runs emulated, which takes a good deal longer.`,
		);
	}
	return arch;
}

/** Internal: the folder it goes in, from the flag, or picked from the drives plugged in. */
async function pickTarget(given: Flags[string]): Promise<string> {
	let path = typeof given === 'string' && given.trim() ? given.trim() : undefined;

	if (!path) {
		const drives = await listDrives();
		if (drives.length > 0) {
			path = await select<string>({
				message: 'Which USB stick should it go on?',
				options: [
					...drives.map((drive) => ({ value: drive.path, label: drive.label, hint: drive.path })),
					{ value: '', label: 'Another folder' },
				],
			});
		}
		if (!path) {
			path = await text({
				message: 'Which folder should it go in? The USB stick, or any folder to copy onto one.',
				placeholder: process.platform === 'win32' ? 'E:\\' : '/Volumes/USB',
				validate: (value) => (value?.trim() ? undefined : 'The folder is needed.'),
			});
		}
	}

	const folder = resolve(process.cwd(), path);
	const found = await stat(folder).catch(() => undefined);
	if (!found?.isDirectory()) {
		throw new CliError(`There is no folder ${folder}.`, {
			hint: `Plug the USB stick in, or pass the folder with ${theme.code('--to')}.`,
		});
	}
	return folder;
}

/** Internal: what each step of a build in a container is called while it happens. */
const containerStepText: Record<ContainerStep, string> = {
	container: 'Starting the build container',
	packages: 'Installing what building needs in it',
	flutter: 'Installing Flutter in it (only the first time, it takes a while)',
	copy: "Copying your car's app in",
	build: 'Building SmartifyOS (a few minutes the first time)',
	libraries: 'Reading which libraries the build links against',
};

/**
 * Internal: builds the car's app on this computer, in a container or right here, and works
 * out which libraries the build links against for the car's list.
 */
async function buildOnThisComputer(
	builder: Builder,
	arch: LinuxArch,
	state: CarState,
	needs: CarNeeds,
	flutter: FlutterVersion,
): Promise<{ built: Built & { remove?: () => Promise<void> }; warnings: string[] }> {
	let built: Built & { remove?: () => Promise<void> };
	let warnings: string[];

	if (builder.kind === 'container') {
		const progress = spinner();
		progress.start(containerStepText.container);
		try {
			const result = await buildInContainer({
				engine: builder.engine,
				arch,
				flutter,
				state,
				needs,
				onStep: (step) => progress.message(containerStepText[step]),
			});
			progress.stop(`Built SmartifyOS for ${arch} cars in a ${officialLinux.name} container`);
			built = { bundle: result.bundle, arch, libraries: result.libraries, remove: result.remove };
			warnings = result.warnings;
		} catch (error) {
			progress.error('It did not build');
			throw error;
		}
	} else {
		const tools = await writeBuildTools(needs);
		try {
			await installBuildPackages(tools.script, tools.set);
			const bundle = await step(
				'Building SmartifyOS for the car (this takes a few minutes the first time)',
				() => buildBundle(state.app.dir, arch),
				() => 'Built SmartifyOS',
			);
			const found = await step(
				'Reading which libraries the build links against',
				() => bundleLibraries(tools, bundle),
				(found) => `The build links against libraries from ${found.libraries.length} packages`,
			);
			built = { bundle, arch, libraries: found.libraries };
			warnings = found.warnings;
		} finally {
			await tools.remove();
		}
	}

	for (const warning of warnings) log.warn(warning);
	return { built, warnings };
}

/**
 * Internal: runs `linux.sh packages` for what building needs on this computer. It only asks
 * for a password when something is missing, and only when somebody is there to type it.
 */
async function installBuildPackages(script: string, set: string): Promise<void> {
	log.step('Checking this computer has everything building needs');
	// This is someone's own computer: what SmartifyOS no longer needs is pointed out, not removed.
	const args = [script, 'packages', set, '--keep-unused'];

	let code: number;
	if (isJsonMode()) {
		code = await runStreaming('bash', args, undefined, (stream, line) =>
			emit({ type: 'output', stream, text: line }),
		).exited;
	} else {
		code = await runInTerminal('bash', args, undefined, {
			SMARTIFY_OS_SUDO_ASK: isInteractive() ? '1' : '0',
		});
	}

	if (code !== 0) {
		throw new CliError('This computer is missing something building needs.', {
			hint: isJsonMode()
				? `Installing it needs sudo, which asks for a password here. Run ${theme.code(`${binaryName} export`)} in a terminal once, where it can ask.`
				: 'What was printed above says why.',
		});
	}
}
