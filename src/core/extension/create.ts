import { existsSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError } from '../../utils/errors.ts';
import type { GitSource } from '../git.ts';
import { runOrThrow } from '../process.ts';
import { gitEntry, pathEntry } from '../project/block.ts';
import { setEntry } from '../pubspec/blocks.ts';
import { corePackage, type NeededOverride } from '../smartify-os.ts';

/**
 * Turning SmartifyOS's extension template into someone's own extension.
 *
 * The template names its feature in exactly three spellings, `my_feature`, `MyFeature` and
 * `My feature`, none of which contains another, and every file in it is text. So renaming is
 * a plain replace of those three, in every file and in every file and folder name.
 */

/** Every spelling of an extension's name. */
export interface ExtensionNames {
	/** As the driver reads it: `Reverse camera`. */
	name: string;
	/** `reverse_camera`. */
	snake: string;
	/** `ReverseCamera`. */
	pascal: string;
	/** `smartify_os_reverse_camera`, which is also the folder's name. */
	packageName: string;
}

/**
 * Words Dart does not allow as a name. The snake case name ends up as one (`t.my_feature`
 * in the generated strings), so none of these can be used.
 */
const dartKeywords = new Set(
	`abstract as assert async await base break case catch class const continue covariant default
	deferred do dynamic else enum export extends extension external factory false final finally
	for function get hide if implements import in interface is late library mixin native new null
	of on operator part patch required rethrow return sealed set show source static super switch
	sync this throw true try type typedef var void when while with yield`.split(/\s+/),
);

/**
 * Every spelling of a name, from the name as the driver should read it.
 *
 * @throws {CliError} when it is not a name that works as a package, saying why.
 */
export function extensionNames(input: string): ExtensionNames {
	const name = input.trim().replace(/\s+/g, ' ');

	if (!/^[A-Za-z][A-Za-z0-9 ]*$/.test(name)) {
		throw new CliError(`"${input}" cannot be the name of an extension.`, {
			hint: 'Start it with a letter, and use only letters, digits and spaces, like "Reverse camera".',
		});
	}

	const words = name.split(' ');
	const snake = words.map((word) => word.toLowerCase()).join('_');
	const pascal = words
		.map((word) => `${word[0]?.toUpperCase() ?? ''}${word.slice(1).toLowerCase()}`)
		.join('');

	if (dartKeywords.has(snake)) {
		throw new CliError(`"${name}" is a word Dart keeps for itself, so it cannot be a name.`, {
			hint: 'Add a word to it, like "Dashcam" or "Rear camera".',
		});
	}

	return { name, snake, pascal, packageName: `smartify_os_${snake}` };
}

/** The template's three spellings, in the order they are replaced. */
function replacements(names: ExtensionNames): [string, string][] {
	return [
		['my_feature', names.snake],
		['MyFeature', names.pascal],
		['My feature', names.name],
	];
}

/** Renames every spelling of the template's name in a piece of text. */
export function renameText(text: string, names: ExtensionNames): string {
	let result = text;
	for (const [from, to] of replacements(names)) result = result.replaceAll(from, to);
	return result;
}

/** What is never copied out of the template: what a machine made, not what the template is. */
const leftOut = new Set([
	'pubspec_overrides.yaml',
	'pubspec.lock',
	'.dart_tool',
	'build',
	'.DS_Store',
	'.git',
]);

/**
 * Copies the template into a new folder, renaming every spelling of its name in every file,
 * and in every file and folder name.
 */
export async function copyTemplate(from: string, to: string, names: ExtensionNames): Promise<void> {
	await mkdir(to, { recursive: true });

	for (const entry of await readdir(from, { withFileTypes: true })) {
		if (leftOut.has(entry.name)) continue;
		const source = join(from, entry.name);
		const target = join(to, renameText(entry.name, names));

		if (entry.isDirectory()) {
			await copyTemplate(source, target, names);
			continue;
		}

		const bytes = new Uint8Array(await Bun.file(source).arrayBuffer());
		// Every file in the template is text. Should that ever change, a binary file is
		// copied as it is rather than mangled.
		if (bytes.includes(0)) await Bun.write(target, bytes);
		else await Bun.write(target, renameText(new TextDecoder().decode(bytes), names));
	}
}

/**
 * The new extension's pubspec.yaml: its description, and the oldest SmartifyOS it works
 * with, which is the one it is made with.
 */
export function finishPubspec(
	text: string,
	description: string | undefined,
	coreVersion: string,
): string {
	let result = setEntry(text, 'dependencies', corePackage, [`${corePackage}: ">=${coreVersion}"`]);
	if (description) {
		result = result.replace(/^description:.*$/m, `description: ${JSON.stringify(description)}`);
	}
	return result;
}

/** Where an extension's own copy of SmartifyOS comes from: a release or branch, or a folder. */
export type CoreLocation = { kind: 'git'; source: GitSource } | { kind: 'path'; path: string };

/**
 * The `pubspec_overrides.yaml` an extension or its example app needs to find SmartifyOS.
 *
 * An extension only says which SmartifyOS it needs at least, so without this file pub
 * would look for SmartifyOS on pub.dev and find nothing. The example app is an app, so it
 * also repeats the overrides SmartifyOS itself needs.
 */
export function extensionOverrides(core: CoreLocation, needed: NeededOverride[] = []): string {
	const entry =
		core.kind === 'git' ? gitEntry(corePackage, core.source) : pathEntry(corePackage, core.path);
	const lines = [
		'# Where this computer gets SmartifyOS from. Written by smartify-os, and never',
		'# committed: a car decides that for itself.',
		'dependency_overrides:',
		...[...entry, ...needed.flatMap((override) => override.lines)].map((line) => `  ${line}`),
	];
	return `${lines.join('\n')}\n`;
}

/** Deletes a folder, for undoing a creation that did not get far. Never throws. */
export async function removeFolder(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * What `flutter create` adds to an example app besides the platform folders, none of which
 * belongs there: a `widget_test.dart` that does not compile against the example, an
 * `analysis_options.yaml` that includes `flutter_lints`, which the example does not depend
 * on, and a README about "a new Flutter project".
 */
const createLeftovers = ['test', 'analysis_options.yaml', 'README.md'];

/**
 * Gives an extension's example app the folders for these desktop platforms, and takes back
 * out whatever else `flutter create` put there that was not there before.
 */
export async function addExamplePlatforms(example: string, platforms: string[]): Promise<void> {
	const had = new Set(createLeftovers.filter((name) => existsSync(join(example, name))));
	await runOrThrow(
		'flutter',
		['create', `--platforms=${platforms.join(',')}`, '--project-name', 'example', '.'],
		{ message: 'Flutter could not set up the example app.' },
		{ cwd: example },
	);
	for (const name of createLeftovers) {
		if (!had.has(name)) await rm(join(example, name), { recursive: true, force: true });
	}
}
