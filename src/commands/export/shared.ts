import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { collectDownloads } from '../../core/downloads/collect.ts';
import { fetchItem, isCached } from '../../core/downloads/fetch.ts';
import {
	chooseDownloads,
	type DownloadChoice,
	dependsOnArch,
	itemPath,
} from '../../core/downloads/list.ts';
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
	exportSets,
	installSteps,
	readExistingExport,
	type StickDownload,
	writeExport,
} from '../../core/export/export.ts';
import { addPlatforms, type FlutterVersion, flutterVersion } from '../../core/flutter.ts';
import { type CarNeeds, collectNeeds } from '../../core/linux/collect.ts';
import { hostArch, type LinuxArch, linuxArchs, officialLinux } from '../../core/linux/distro.ts';
import { runInTerminal, runStreaming } from '../../core/process.ts';
import type { CarState } from '../../core/project/car.ts';
import { requireCar } from '../../core/project/find.ts';
import { ensureFlutterGpu } from '../../ui/flutter-gpu.ts';
import { emit, isJsonMode } from '../../ui/json.ts';
import { describeSets, renderNeedProblems, setData } from '../../ui/linux.ts';
import { intro, log, outro } from '../../ui/output.ts';
import { readCarStep, step } from '../../ui/project.ts';
import {
	confirm,
	isInteractive,
	multiselect,
	note,
	select,
	spinner,
	text,
} from '../../ui/prompt.ts';
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
		describe: "The car's architecture: x64, or arm64 (a Raspberry Pi)",
	},
	download: {
		type: 'string',
		multiple: true,
		describe:
			'Something an extension downloads to put on the car with it, by its name, again for more. none for nothing',
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
	/** What the extensions download that went on the stick with it. */
	downloads: { key: string; title: string; sizeMb: number; path: string }[];
}

export async function runExport(kind: ExportKind, flags: Flags): Promise<ExportData> {
	intro(kind === 'installer' ? 'Make an installer' : 'Make an update');
	const app = await requireCar();
	const state = await readCarStep(app);

	const binary = await ensureLinux(state);
	const { buildOn, found } = await pickBuildOn(kind, flags['build-on'], await findBuilder());
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

	const choices = await pickDownloads(state, flags, arch);
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
		downloads: [],
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

	const downloads = await fetchDownloads(choices);

	let built: (Built & { remove?: () => Promise<void> }) | undefined;
	let warnings: string[] = [];
	if (builder && arch) {
		({ built, warnings } = await buildOnThisComputer(builder, arch, state, needs, flutter));
	}

	let result: Awaited<ReturnType<typeof writeExport>>;
	try {
		result = await step(
			`Putting ${kind === 'installer' ? 'the installer' : 'the update'} on it`,
			() => writeExport({ kind, buildOn, state, needs, binary, flutter, built, downloads }, target),
			(result) => `Written to ${theme.code(result.folder)}`,
		);
	} finally {
		await built?.remove?.();
	}

	if (kind === 'installer') {
		note(installSteps(buildOn, theme.code).join('\n'), 'On the car');
	}
	outro(
		kind === 'installer'
			? 'All done. README.txt on the stick says the same.'
			: `All done. Plug it into the car while SmartifyOS runs, and it offers the update. ${theme.dim(buildOn === 'car' ? 'The car needs the internet for it only to download what is new (a newer Flutter, or packages it did not have).' : 'The car needs the internet for it only when it needs something new installed.')}`,
	);

	return data(true, {
		folder: result.folder,
		files: result.files,
		arch: built?.arch ?? null,
		builder: builder ? (builder.kind === 'container' ? builder.engine : 'native') : null,
		flutter,
		sets: result.sets.map(setData),
		warnings,
		downloads: choices.map((choice) => ({
			key: choice.key,
			title: choice.item.title,
			sizeMb: choice.item.sizeMb,
			path: itemPath(choice.list, choice.item),
		})),
	});
}

/**
 * Internal: what the car's extensions download that goes on the stick with it, from
 * `--download`, by asking, or what the car needs unless told otherwise (with `--yes`, or when
 * nobody can be asked).
 */
async function pickDownloads(
	state: CarState,
	flags: Flags,
	known: LinuxArch | undefined,
): Promise<DownloadChoice[]> {
	const found = await collectDownloads(state);
	renderNeedProblems(found.problems);
	if (found.lists.length === 0) return [];

	const given = (Array.isArray(flags.download) ? flags.download : [flags.download])
		.filter((value): value is string => typeof value === 'string')
		.flatMap((value) => value.split(','))
		.map((value) => value.trim())
		.filter(Boolean);
	const asking = given.length === 0 && flags.yes !== true && isInteractive();

	let arch = known ?? (flags.arch as LinuxArch | undefined);
	if (arch !== undefined && !linuxArchs.includes(arch)) {
		throw new CliError(`--arch is x64 or arm64, not ${String(arch)}.`);
	}
	if (!arch && asking && dependsOnArch(found.lists)) {
		arch = await select<LinuxArch>({
			message: 'What does the car run on? It decides which downloads suit it.',
			options: [
				{ value: 'arm64', label: 'A Raspberry Pi', hint: 'or another ARM board, arm64' },
				{ value: 'x64', label: 'A PC or mini PC', hint: 'Intel or AMD, x64' },
			],
			initialValue: 'x64',
		});
	}
	const choices = chooseDownloads(found.lists, found.settings, arch);

	if (given.length > 0) {
		if (given.includes('none')) return [];
		return choices
			.filter(
				(choice) => choice.item.required || given.some((name) => matches(choice, name, choices)),
			)
			.concat(unknownDownloads(given, choices));
	}
	if (!asking) return choices.filter((choice) => choice.picked);

	const optional = choices.filter((choice) => !choice.item.required);
	const required = choices.filter((choice) => choice.item.required);
	if (optional.length === 0) return required;
	const several = found.lists.length > 1;
	const cached = new Set<string>();
	for (const choice of optional) {
		if (await isCached(choice.list, choice.item)) cached.add(choice.key);
	}
	const keys = await multiselect<string>({
		message: `What should go on the car with it? ${several ? 'Your extensions download' : `${found.lists[0]?.requester.title} downloads`} these by itself while it runs, but a car on the road often has no internet.`,
		options: optional.map((choice) => ({
			value: choice.key,
			label: several ? `${choice.list.requester.title}: ${choice.item.title}` : choice.item.title,
			hint: [
				choice.reason === 'setting' ? 'Your app uses it' : choice.item.about,
				`${choice.item.sizeMb} MB`,
				cached.has(choice.key) ? 'downloaded already' : undefined,
			]
				.filter(Boolean)
				.join(', '),
		})),
		initialValues: optional.filter((choice) => choice.picked).map((choice) => choice.key),
		required: false,
	});
	return [...required, ...optional.filter((choice) => keys.includes(choice.key))];
}

/** Internal: whether a name given with --download is this choice: its key, or its id when that is unique. */
function matches(choice: DownloadChoice, name: string, all: DownloadChoice[]): boolean {
	if (choice.key === name) return true;
	return choice.item.id === name && all.filter((other) => other.item.id === name).length === 1;
}

/** Internal: throws for a name given with --download that is none of them. */
function unknownDownloads(given: string[], choices: DownloadChoice[]): DownloadChoice[] {
	const unknown = given.filter((name) => !choices.some((choice) => matches(choice, name, choices)));
	if (unknown.length > 0) {
		throw new CliError(`There is nothing called ${unknown.join(' or ')} to download.`, {
			hint: `These are: ${choices.map((choice) => choice.key).join(', ')}, or none.`,
		});
	}
	return [];
}

/**
 * Internal: downloads what goes on the stick, or takes it from what this computer kept, and
 * says where each is.
 */
async function fetchDownloads(choices: DownloadChoice[]): Promise<StickDownload[]> {
	const downloads: StickDownload[] = [];
	const total = choices.reduce((sum, choice) => sum + choice.item.sizeMb, 0);
	for (const choice of choices) {
		const path = itemPath(choice.list, choice.item);
		// Two items can share a folder, and only need it once.
		if (downloads.some((download) => download.path === path)) continue;
		if (await isCached(choice.list, choice.item)) {
			downloads.push({ path, from: await fetchItem(choice.list, choice.item) });
			continue;
		}
		const progress = spinner();
		const what = `Downloading ${choice.item.title}`;
		progress.start(`${what} (${choice.item.sizeMb} MB)`);
		let shown = -1;
		try {
			const from = await fetchItem(choice.list, choice.item, (received) => {
				const mb = Math.floor(received / 1_000_000);
				// A step at a time, so a fast download does not redraw for every packet.
				if (mb - shown < Math.max(1, Math.round(choice.item.sizeMb / 50))) return;
				shown = mb;
				progress.message(
					`${what} (${Math.min(mb, choice.item.sizeMb)} of ${choice.item.sizeMb} MB)`,
				);
			});
			progress.stop(`Downloaded ${choice.item.title}`);
			downloads.push({ path, from });
		} catch (error) {
			progress.error(`${choice.item.title} did not download`);
			throw error;
		}
	}
	if (choices.length > 0) {
		log.info(
			`${choices.length === 1 ? choices[0]?.item.title : `${choices.length} downloads`} go on the stick (${total} MB). ${theme.dim('The car leaves alone what it has already.')}`,
		);
	}
	return downloads;
}

/**
 * Internal: the name of the program the build makes. A car's app made without a Linux part
 * gets one, since the car cannot run it otherwise, and one made before SmartifyOS drew the
 * 3D car with Flutter GPU gets that switched on.
 */
async function ensureLinux(state: CarState): Promise<string> {
	const found = await bundleBinaryName(state.app.dir);
	if (found) {
		await ensureFlutterGpu(state.app.dir);
		return found;
	}

	const name = /^name:\s*(\S+)/m.exec(state.pubspecText)?.[1] ?? 'app';
	await step(
		"Your car's app has no Linux part yet, adding it",
		() => addPlatforms(state.app.dir, ['linux'], name),
		() => "Added the Linux part to your car's app",
	);
	return (await bundleBinaryName(state.app.dir)) ?? name;
}

/**
 * Internal: where it is built, from the flag or by asking, and how this computer builds when
 * that is here.
 *
 * Asked even when this computer cannot build right now, saying why next to it, so starting
 * Docker Desktop and picking it again is enough: picking it looks for Docker again.
 */
async function pickBuildOn(
	kind: ExportKind,
	given: Flags[string],
	found: FindBuilder,
): Promise<{ buildOn: BuildOn; found: FindBuilder }> {
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
		return { buildOn: given, found };
	}

	// Nobody to ask, so the car builds it, as it is the one that always can.
	if (!found.ok && !isInteractive()) {
		log.info(`SmartifyOS is built on the car. ${theme.dim(`${found.reason} ${found.hint}`)}`);
		return { buildOn: 'car', found };
	}

	while (true) {
		const buildOn = await select<BuildOn>({
			message:
				kind === 'installer'
					? 'Where should SmartifyOS be built? Either way, the car needs the internet while it installs.'
					: 'Where should SmartifyOS be built?',
			options: [
				{
					value: 'computer',
					label: 'On this computer',
					hint: !found.ok
						? found.option
						: found.builder.kind === 'container'
							? 'in Docker, quicker, the car only installs the finished app'
							: `for ${found.builder.arch} cars, quicker, the car only installs the finished app`,
				},
				{
					value: 'car',
					label: 'On the car',
					hint:
						kind === 'installer'
							? 'the car also downloads Flutter, and building takes a while there'
							: 'needs the internet on the car when Flutter or the packages changed',
				},
			],
			...(found.ok ? {} : { initialValue: 'car' as const }),
		});
		if (buildOn === 'car' || found.ok) return { buildOn, found };

		// Not a step, which would show a check mark when Docker is still not there.
		const looking = spinner();
		looking.start('Looking for Docker');
		found = await findBuilder();
		if (found.ok) {
			looking.stop('Docker is running');
			return { buildOn, found };
		}
		looking.error(found.reason);
	}
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

/**
 * The folder it goes in, from the flag, or picked from the drives plugged in. Also where
 * `device export` puts the firmware of the car's devices.
 */
export async function pickTarget(given: Flags[string]): Promise<string> {
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
	rebuild: 'Building SmartifyOS again, the emulated build got stuck (it happens now and then)',
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
