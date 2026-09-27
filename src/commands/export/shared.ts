import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
	type BuildHere,
	buildBundle,
	binaryName as bundleBinaryName,
	bundleLibraries,
	canBuildHere,
	writeBuildTools,
} from '../../core/export/build.ts';
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
import { officialLinux } from '../../core/linux/distro.ts';
import { runInTerminal, runStreaming } from '../../core/process.ts';
import type { CarState } from '../../core/project/car.ts';
import { requireCar } from '../../core/project/find.ts';
import { emit, isJsonMode } from '../../ui/json.ts';
import { describeSets, renderNeedProblems, setData } from '../../ui/linux.ts';
import { intro, log, outro } from '../../ui/output.ts';
import { readCarStep, step } from '../../ui/project.ts';
import { confirm, isInteractive, note, select, text } from '../../ui/prompt.ts';
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
	/** The Flutter a car that builds itself installs. */
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
	const here = await canBuildHere();
	const buildOn = await pickBuildOn(flags['build-on'], here);

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

	let flutter: FlutterVersion | undefined;
	let built: Built | undefined;
	let warnings: string[] = [];
	if (buildOn === 'car') {
		flutter = await step(
			'Checking which Flutter the car should build with',
			() => flutterVersion(),
			(found) => `The car builds with Flutter ${found.version}, the same as this computer`,
		);
	} else if (here.ok) {
		({ built, warnings } = await buildOnThisComputer(state, needs, here.arch));
	}

	const result = await step(
		`Putting ${kind === 'installer' ? 'the installer' : 'the update'} on it`,
		() => writeExport({ kind, buildOn, state, needs, binary, flutter, built }, target),
		(result) => `Written to ${theme.code(result.folder)}`,
	);

	if (kind === 'installer') {
		note(
			[
				`1. Install ${officialLinux.name} on the car, and log in as the user SmartifyOS runs as.`,
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
		flutter: flutter ?? null,
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
async function pickBuildOn(given: Flags[string], here: BuildHere): Promise<BuildOn> {
	if (given !== undefined) {
		if (given !== 'car' && given !== 'computer') {
			throw new CliError(`--build-on is car or computer, not ${String(given)}.`, {
				hint: `${theme.code('--build-on car')} builds it on the car, ${theme.code('--build-on computer')} on this computer.`,
			});
		}
		if (given === 'computer' && !here.ok) {
			throw new CliError(here.reason, {
				hint: `Pass ${theme.code('--build-on car')} instead, and the car builds it for itself.`,
			});
		}
		return given;
	}

	if (!here.ok) {
		log.info(`SmartifyOS is built on the car. ${theme.dim(here.reason)}`);
		return 'car';
	}

	return await select<BuildOn>({
		message: 'Where should SmartifyOS be built?',
		options: [
			{
				value: 'computer',
				label: 'On this computer',
				hint: `for ${here.arch} cars, the car only installs the finished app`,
			},
			{
				value: 'car',
				label: 'On the car',
				hint: 'it needs the internet and takes a while there',
			},
		],
	});
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

/**
 * Internal: builds the car's app here, after making sure this computer has what building
 * needs, and works out which libraries the build links against for the car's list.
 */
async function buildOnThisComputer(
	state: CarState,
	needs: CarNeeds,
	arch: Built['arch'],
): Promise<{ built: Built; warnings: string[] }> {
	const tools = await writeBuildTools(needs);
	try {
		await installBuildPackages(tools.script, tools.set);
		const bundle = await step(
			'Building SmartifyOS for the car (this takes a few minutes the first time)',
			() => buildBundle(state.app.dir, arch),
			() => 'Built SmartifyOS',
		);
		const { libraries, warnings } = await step(
			'Reading which libraries the build links against',
			() => bundleLibraries(tools, bundle),
			(found) => `The build links against libraries from ${found.libraries.length} packages`,
		);
		for (const warning of warnings) log.warn(warning);
		return { built: { bundle, arch, libraries }, warnings };
	} finally {
		await tools.remove();
	}
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
