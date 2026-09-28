import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { version as cliVersion } from '../../utils/version.ts';
import type { FlutterVersion } from '../flutter.ts';
import type { AptNeed, CarNeeds } from '../linux/collect.ts';
import { type LinuxArch, officialLinux } from '../linux/distro.ts';
import { scripts } from '../linux/scripts.ts';
import {
	addNeeds,
	carSystemNeeds,
	flutterToolchainNeeds,
	type PackageSet,
	renderSet,
	type SetName,
} from '../linux/set.ts';
import type { CarState } from '../project/car.ts';
import { packBundle, packSource } from './pack.ts';

/**
 * Putting SmartifyOS on a USB stick for a car: an installer for a new car, or an update for
 * one that runs SmartifyOS already.
 *
 * Both are one `smartify-os` folder on the stick, laid out the same way, so SmartifyOS on
 * the car can read an update exactly as install.sh reads an installer:
 *
 *   export.conf            what this is, see {@link renderConf}
 *   linux.sh               the one step every install, build and update runs
 *   install.sh             only in an installer
 *   README.txt             what to do with it, for a person
 *   source.tar.gz          the car's app, when the car builds it
 *   app.tar.gz             the finished build, when this computer built it
 *   packages/run/          what the car needs to run it, see src/core/linux/set.ts
 *   packages/build/        what the car needs to build it, when it does
 */

/** An installer for a new car, or an update for one that has SmartifyOS. */
export type ExportKind = 'installer' | 'update';

/** Where SmartifyOS is built: on the car from its source, or on this computer. */
export type BuildOn = 'car' | 'computer';

/** The name of the folder on the stick. */
export const exportFolderName = 'smartify-os';

/** A finished build made on this computer. */
export interface Built {
	bundle: string;
	arch: LinuxArch;
	/** The libraries it links against, worked out where it was built. */
	libraries: AptNeed[];
}

export interface ExportInput {
	kind: ExportKind;
	buildOn: BuildOn;
	state: CarState;
	needs: CarNeeds;
	/** The program's name in the build, from the app's linux/CMakeLists.txt. */
	binary: string;
	/** The Flutter a car that builds itself installs. */
	flutter?: FlutterVersion;
	/** The build, when this computer made it. */
	built?: Built;
	/** When it was made, for export.conf. */
	now?: Date;
}

/** What went on the stick. */
export interface ExportResult {
	/** The `smartify-os` folder. */
	folder: string;
	/** Every file in it, relative to it. */
	files: string[];
	sets: PackageSet[];
}

/** The package sets an export carries. */
export function exportSets(input: Pick<ExportInput, 'buildOn' | 'needs' | 'built'>): PackageSet[] {
	const sets: PackageSet[] = [
		{
			name: 'smartify-os-run',
			description: 'SmartifyOS',
			apt: addNeeds(addNeeds(carSystemNeeds(), input.needs.run), input.built?.libraries ?? []),
			udev: input.needs.udev,
			groups: input.needs.groups,
			flutterToolchain: false,
		},
	];
	if (input.buildOn === 'car') {
		sets.push({
			name: 'smartify-os-build',
			description: 'building SmartifyOS',
			apt: addNeeds(flutterToolchainNeeds(), input.needs.build),
			udev: [],
			groups: [],
			flutterToolchain: true,
		});
	}
	return sets;
}

/** Internal: the folder a set goes in. */
function setFolder(name: SetName): string {
	return name === 'smartify-os-run' ? 'packages/run' : 'packages/build';
}

/** Internal: a value that cannot break a KEY=value line. */
function value(text: string | undefined): string {
	return (text ?? '').replace(/[\r\n]+/g, ' ').trim();
}

/**
 * export.conf: one `KEY=value` per line, read by install.sh without being run, and by
 * SmartifyOS on the car. Keys are only ever added, never changed in meaning, so an older
 * car can read a newer stick. `FORMAT` goes up only if that ever has to break.
 */
export function renderConf(input: ExportInput): string {
	const { state } = input;
	const lines: [string, string | undefined][] = [
		['FORMAT', '1'],
		['KIND', input.kind],
		['BUILD_ON', input.buildOn],
		['PAYLOAD', input.buildOn === 'car' ? 'source.tar.gz' : 'app.tar.gz'],
		['APP', pubspecField(state.pubspecText, 'name')],
		['APP_VERSION', pubspecField(state.pubspecText, 'version')],
		['BINARY', input.binary],
		['SMARTIFY_OS_VERSION', state.core.version],
		['FLUTTER_VERSION', input.flutter?.version],
		['FLUTTER_CHANNEL', input.flutter?.channel],
		['ARCH', input.built?.arch],
		['LINUX_ID', officialLinux.id],
		['LINUX_VERSION_ID', officialLinux.versionId],
		['LINUX_NAME', officialLinux.name],
		['CREATED', (input.now ?? new Date()).toISOString()],
		['CLI_VERSION', cliVersion],
	];
	return [
		'# What is on this USB stick, written by smartify-os export. Read by install.sh and',
		'# by SmartifyOS on the car. One KEY=value per line, nothing is ever run.',
		...lines.map(([key, text]) => `${key}=${value(text)}`),
		'',
	].join('\n');
}

/** Internal: a top level value of the car's pubspec.yaml, `name` or `version`. */
function pubspecField(pubspecText: string, key: string): string | undefined {
	return new RegExp(`^${key}:\\s*(\\S+)`, 'm').exec(pubspecText)?.[1];
}

/** README.txt, for whoever finds the stick. */
export function renderReadme(input: ExportInput): string {
	const lines =
		input.kind === 'installer'
			? [
					'SmartifyOS installer',
					'',
					`1. Install ${officialLinux.name} on the car (${officialLinux.piName} on a Raspberry Pi),`,
					'   and log in on it as the user SmartifyOS should run as.',
					'2. Plug this USB stick in. With no desktop on the car, nothing opens it by itself,',
					'   so open it with this (lsblk lists the drives, if the stick is not sda1):',
					'',
					'     sudo mount /dev/sda1 /mnt',
					'',
					'   Debian installed with a root password has no sudo. Type su -c "mount /dev/sda1 /mnt"',
					'   there instead, and the root password.',
					'3. Run this:',
					'',
					`     bash /mnt/${exportFolderName}/install.sh`,
					'',
					'It asks for your password once. The car needs the internet while it installs, and',
					'restarts straight into SmartifyOS when it is done.',
					...(input.buildOn === 'car'
						? ['SmartifyOS is built on the car, which takes a while the first time.']
						: []),
				]
			: [
					'SmartifyOS update',
					'',
					'Plug this USB stick into the car while SmartifyOS runs, and it offers the update.',
				];
	return [...lines, '', `Made by smartify-os ${cliVersion}.`, ''].join('\n');
}

/**
 * Writes an export into `target`, the root of the USB stick, as its `smartify-os` folder.
 *
 * Everything is written next to it first and only swapped in once complete, so a stick
 * pulled out halfway, or a build that fails, never leaves half an export behind, and an
 * export that was there before stays until the new one is whole.
 */
export async function writeExport(
	input: ExportInput,
	target: string,
	onStep?: (step: 'pack' | 'write') => void,
): Promise<ExportResult> {
	const folder = join(target, exportFolderName);
	const staging = join(target, `.${exportFolderName}-new`);
	await rm(staging, { recursive: true, force: true });
	await mkdir(staging, { recursive: true });
	const files: string[] = [];
	const write = async (path: string, text: string, executable = false) => {
		const full = join(staging, path);
		await mkdir(dirname(full), { recursive: true });
		await Bun.write(full, text);
		// A FAT stick keeps no permissions, which is why the README says `bash install.sh`.
		if (executable) await chmod(full, 0o755).catch(() => {});
		files.push(path);
	};

	try {
		onStep?.('pack');
		if (input.buildOn === 'car') {
			await packSource(
				input.state.app.dir,
				input.state.pubspecText,
				input.state.links,
				join(staging, 'source.tar.gz'),
			);
			files.push('source.tar.gz');
		} else {
			if (!input.built) throw new Error('A build on this computer needs its bundle.');
			await packBundle(input.built.bundle, join(staging, 'app.tar.gz'));
			files.push('app.tar.gz');
		}

		onStep?.('write');
		const sets = exportSets(input);
		for (const set of sets) {
			for (const [path, text] of renderSet(set))
				await write(`${setFolder(set.name)}/${path}`, text);
		}
		await write('linux.sh', scripts['linux.sh'], true);
		if (input.kind === 'installer') await write('install.sh', scripts['install.sh'], true);
		await write('export.conf', renderConf(input));
		await write('README.txt', renderReadme(input));

		await rm(folder, { recursive: true, force: true });
		await rename(staging, folder);
		return { folder, files: files.sort(), sets };
	} catch (error) {
		await rm(staging, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}

/** What an export already on a stick is, from its export.conf. */
export interface ExistingExport {
	kind: string;
	app: string;
	created: string;
}

/** The export already in `target`, or undefined when there is none. */
export async function readExistingExport(target: string): Promise<ExistingExport | undefined> {
	const file = Bun.file(join(target, exportFolderName, 'export.conf'));
	if (!(await file.exists())) return undefined;
	const values = new Map<string, string>();
	for (const line of (await file.text()).split(/\r?\n/)) {
		const at = line.indexOf('=');
		if (at > 0 && !line.startsWith('#')) values.set(line.slice(0, at), line.slice(at + 1));
	}
	return {
		kind: values.get('KIND') ?? 'export',
		app: values.get('APP') ?? '',
		created: values.get('CREATED') ?? '',
	};
}
