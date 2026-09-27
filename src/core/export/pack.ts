import { existsSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { runOrThrow } from '../process.ts';
import { overridesFileName, renderOverrides } from '../project/links.ts';

/**
 * Packing what goes on the USB stick into archives: the car's app as source, or a finished
 * build.
 *
 * Archives rather than folders, because a USB stick is usually FAT or exFAT, which keeps no
 * symlinks and no permissions, and a Flutter build or a source tree can need both.
 */

/**
 * What never goes into the source: whatever a build or an editor made, which the car makes
 * again for itself, and this computer's own settings.
 */
const skippedNames = new Set([
	'.dart_tool',
	'.git',
	'.idea',
	'.vscode',
	'.DS_Store',
	'.gradle',
	'.flutter-plugins',
	'.flutter-plugins-dependencies',
	'ephemeral',
	'Pods',
	// Where the Android SDK is on this computer.
	'local.properties',
]);

/**
 * Internal: `tar` making a `.tar.gz`. The tar on macOS also packs Finder's metadata as `._`
 * files and extended attributes unless told not to, which the car's tar warns about.
 */
const tarCreate =
	process.platform === 'darwin' ? ['--no-mac-metadata', '--no-xattrs', '-czf'] : ['-czf'];
const tarOptions = { env: { COPYFILE_DISABLE: '1' } };

/** Internal: what the car's copy of `pubspec_overrides.yaml` starts with. */
const overridesHeader = [
	'# Written by `smartify-os export`: this car was exported while it used these',
	'# packages from folders on the computer it was exported from, and those copies are',
	'# in ../links.',
	'',
].join('\n');

/** Whether a path is left out of the source. */
export function isSkipped(path: string): boolean {
	const name = basename(path);
	if (skippedNames.has(name) || name.endsWith('.iml')) return true;
	// Folders on this computer. The export writes one of its own when anything is linked.
	if (name === overridesFileName) return true;
	// A package's build output, but not a `build` folder somebody keeps their code in.
	if (name === 'build' && existsSync(join(dirname(path), 'pubspec.yaml'))) return true;
	return false;
}

/** Copies a package's folder, leaving out what {@link isSkipped}. */
async function copyPackage(from: string, to: string): Promise<void> {
	await cp(from, to, {
		recursive: true,
		verbatimSymlinks: true,
		filter: (source) => source === from || !isSkipped(source),
	});
}

/**
 * Packs the car's app into a `.tar.gz` holding `app/`, and `links/<package>/` for every
 * package it uses from a folder on this computer, with an `app/pubspec_overrides.yaml`
 * pointing at those, so the car builds exactly what this computer would.
 */
export async function packSource(
	appDir: string,
	pubspecText: string,
	links: Map<string, string>,
	out: string,
): Promise<void> {
	const staging = await mkdtemp(join(tmpdir(), 'smartify-os-export-'));
	try {
		await copyPackage(appDir, join(staging, 'app'));

		const packed = new Map<string, string>();
		for (const [name, path] of links) {
			await copyPackage(resolve(appDir, path), join(staging, 'links', name));
			packed.set(name, `../links/${name}`);
		}
		if (packed.size > 0) {
			const overrides = renderOverrides(pubspecText, packed).replace(/^(#.*\n)+/, overridesHeader);
			await Bun.write(join(staging, 'app', overridesFileName), overrides);
		}

		await runOrThrow(
			'tar',
			[...tarCreate, out, '-C', staging, 'app', ...(packed.size > 0 ? ['links'] : [])],
			{ message: "Your car's app could not be packed." },
			tarOptions,
		);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

/** Packs a finished Flutter build into a `.tar.gz` holding `bundle/`. */
export async function packBundle(bundle: string, out: string): Promise<void> {
	await runOrThrow(
		'tar',
		[...tarCreate, out, '-C', dirname(bundle), basename(bundle)],
		{ message: 'The finished build could not be packed.' },
		tarOptions,
	);
}
