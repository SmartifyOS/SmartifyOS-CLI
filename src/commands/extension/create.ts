import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
	addExamplePlatforms,
	type CoreLocation,
	copyTemplate,
	type ExtensionNames,
	extensionNames,
	extensionOverrides,
	finishPubspec,
	removeFolder,
} from '../../core/extension/create.ts';
import { withClone } from '../../core/git.ts';
import { run, runOrThrow } from '../../core/process.ts';
import { readCar } from '../../core/project/car.ts';
import { findProject } from '../../core/project/find.ts';
import { parsePubspec } from '../../core/pubspec/read.ts';
import {
	coreAt,
	coreRepoUrl,
	isReleaseTag,
	neededOverrides,
	newestCore,
	templateFolder,
} from '../../core/smartify-os.ts';
import { intro, log, outro } from '../../ui/output.ts';
import { step } from '../../ui/project.ts';
import { isInteractive, note, text } from '../../ui/prompt.ts';
import { theme } from '../../ui/theme.ts';
import { CliError } from '../../utils/errors.ts';
import { pubPath } from '../../utils/pub-path.ts';
import { binaryName } from '../flags.ts';
import type { Command } from '../types.ts';

/**
 * Creates a new extension from SmartifyOS's template, tested and committed, in one go.
 */
export const extensionCreateCommand: Command = {
	name: 'create',
	aliases: ['new'],
	summary: 'Create your own extension',
	description:
		"Creates a new extension from the SmartifyOS template: a folder with a working extension in it, an example app to try it on this computer, and passing tests, ready to put on GitHub. Inside a car's app folder it is made for that car's SmartifyOS and put next to the app, anywhere else for the newest SmartifyOS, right where you are.",
	usage: '[name]',
	examples: [
		`${binaryName} extension create`,
		`${binaryName} extension create "Reverse camera" --description "Shows the reverse camera"`,
	],
	flags: {
		name: { type: 'string', describe: 'What the driver should read, like "Reverse camera"' },
		description: { type: 'string', describe: 'One line saying what it does' },
		dir: { type: 'string', describe: 'The folder to create it in (the default is here)' },
	},
	async run({ flags, positionals }) {
		intro('Create an extension');
		const cwd = process.cwd();
		const project = await findProject(cwd);
		// Next to a car's app rather than inside it, where the app would analyze it as its own.
		const defaultDir = project?.kind === 'car' ? dirname(project.dir) : cwd;
		const asking = isInteractive() && flags.yes !== true;

		const givenName = typeof flags.name === 'string' ? flags.name : positionals[0];
		const names = givenName
			? extensionNames(givenName)
			: extensionNames(
					await text({
						message: 'What is it called? This is the name the driver reads.',
						placeholder: 'Reverse camera',
						validate: (value) => validName(value ?? ''),
					}),
				);

		let description = typeof flags.description === 'string' ? flags.description.trim() : undefined;
		if (description === undefined && asking) {
			description = (
				await text({
					message: 'Say in one line what it does (you can leave this empty)',
					placeholder: `${names.name} for SmartifyOS.`,
				})
			)?.trim();
		}

		let parent = typeof flags.dir === 'string' ? resolve(cwd, flags.dir) : defaultDir;
		if (typeof flags.dir !== 'string' && asking) {
			const shown = relative(cwd, defaultDir) || '.';
			parent = resolve(
				cwd,
				await text({
					message: 'Where should its folder go?',
					initialValue: shown,
					defaultValue: shown,
				}),
			);
		}

		const target = join(parent, names.packageName);
		if (existsSync(target)) {
			throw new CliError(`There is a folder called ${names.packageName} there already.`, {
				hint: 'Pick another name, or another place with --dir.',
			});
		}

		const core = await step('Finding which SmartifyOS to make it for', () =>
			coreToBuildOn(project?.kind === 'car' ? project.dir : undefined),
		);
		log.info(`Made for SmartifyOS ${theme.strong(core.label)}`);

		try {
			await step(
				'Copying the template',
				() => core.copyTemplate(target, names),
				() => `Copied the template to ${theme.code(relative(cwd, target) || '.')}`,
			);
			await writeProjectFiles(target, description, core);
			await step('Adding the example app for this computer', () =>
				addExamplePlatforms(join(target, 'example'), ['linux', 'macos', 'windows']),
			);
			await step('Fetching packages', () => fetchPackages(target));
		} catch (error) {
			await removeFolder(target);
			throw error;
		}

		await step(
			'Running its tests',
			async () => {
				const result = await run('flutter', ['test'], { cwd: target });
				if (result.code !== 0) {
					throw new CliError('The new extension does not pass its own tests.', {
						hint: `That is a bug in SmartifyOS, not something you did. Please report it at https://github.com/Mauznemo/SmartifyOS-CLI/issues with this:\n${result.stdout.slice(-2000)}`,
					});
				}
			},
			() => 'Its tests pass',
		);

		const committed = await step('Making it a git repository', () => commitFirst(target, names));
		if (!committed) {
			log.warn('It could not be committed, so it has no history yet. Everything else is ready.');
		}

		const folder = relative(cwd, target) || '.';
		note(
			[
				`${theme.code(`cd ${folder}`)}`,
				`Start in ${theme.code(`lib/src/${names.snake}_extension.dart`)}.`,
				`${theme.code(`${binaryName} extension run`)}  runs it in SmartifyOS on this computer`,
				...(project?.kind === 'car'
					? [
							`${theme.code(`${binaryName} link ${relative(project.dir, target)}`)}  in your car's app puts it in your car`,
						]
					: []),
				'',
				'EXTENSIONS.md in the SmartifyOS repository explains everything else.',
			].join('\n'),
			'Next',
		);
		outro(`${theme.success(theme.strong(names.name))} is ready`);
	},
};

/** Internal: the prompt's check on a name, with the same wording as the error. */
function validName(value: string): string | undefined {
	try {
		extensionNames(value);
		return undefined;
	} catch (error) {
		return error instanceof CliError ? (error.hint ?? error.message) : String(error);
	}
}

/** Internal: the SmartifyOS a new extension is made for, and where its template comes from. */
interface CoreToBuildOn {
	label: string;
	version: string;
	pubspecText: string;
	/** Where SmartifyOS is, with a path given absolute. */
	location: CoreLocation;
	copyTemplate(target: string, names: ExtensionNames): Promise<void>;
}

/**
 * Internal: the car's own SmartifyOS when inside a car's app, so the extension is made for
 * what that car runs, otherwise the newest. A SmartifyOS in a folder on this computer comes
 * with its template from the folder next to it, which is what someone working on
 * SmartifyOS itself wants.
 */
async function coreToBuildOn(carDir: string | undefined): Promise<CoreToBuildOn> {
	if (carDir) {
		const state = await readCar({ kind: 'car', dir: carDir });
		const source = state.core.source;
		const folder = state.core.link ?? (source.kind === 'path' ? source.path : undefined);

		if (folder) {
			const corePath = resolve(carDir, folder);
			const pubspecText = await Bun.file(join(corePath, 'pubspec.yaml')).text();
			const version = String(parsePubspec(pubspecText, 'pubspec.yaml').version ?? '0.0.0');
			const localTemplate = join(dirname(corePath), templateFolder);
			const fallback = existsSync(localTemplate) ? undefined : await newestCore();
			return {
				label: `${version} from ${folder}`,
				version,
				pubspecText,
				location: { kind: 'path', path: corePath },
				copyTemplate: (target, names) =>
					fallback
						? cloneTemplate(fallback.source.ref, target, names)
						: copyTemplate(localTemplate, target, names),
			};
		}

		if (source.kind === 'git' && source.ref) {
			const at = await coreAt(source.ref);
			const ref = source.ref;
			return {
				label: isReleaseTag(ref) ? at.version : ref,
				version: state.core.version ?? at.version,
				pubspecText: at.pubspecText,
				location: { kind: 'git', source: at.source },
				copyTemplate: (target, names) => cloneTemplate(ref, target, names),
			};
		}
	}

	const newest = await newestCore();
	return {
		label: isReleaseTag(newest.source.ref) ? newest.version : newest.source.ref,
		version: newest.version,
		pubspecText: newest.pubspecText,
		location: { kind: 'git', source: newest.source },
		copyTemplate: (target, names) => cloneTemplate(newest.source.ref, target, names),
	};
}

/** Internal: copies the template out of the SmartifyOS repository at a tag or branch. */
async function cloneTemplate(ref: string, target: string, names: ExtensionNames): Promise<void> {
	await withClone(coreRepoUrl(), ref, [templateFolder], async (dir) => {
		const template = join(dir, templateFolder);
		if (!existsSync(template)) {
			throw new CliError(`SmartifyOS ${ref} has no extension template.`, {
				hint: 'It was added in a later SmartifyOS. Move your car to a newer one first.',
			});
		}
		await copyTemplate(template, target, names);
	});
}

/** Internal: the description, the SmartifyOS lower bound and both overrides files. */
async function writeProjectFiles(
	target: string,
	description: string | undefined,
	core: CoreToBuildOn,
): Promise<void> {
	const pubspecPath = join(target, 'pubspec.yaml');
	const pubspec = await Bun.file(pubspecPath).text();
	await Bun.write(pubspecPath, finishPubspec(pubspec, description, core.version));

	const where = (dir: string): CoreLocation =>
		core.location.kind === 'path'
			? { kind: 'path', path: pubPath(dir, core.location.path) }
			: core.location;
	const example = join(target, 'example');

	await Bun.write(join(target, 'pubspec_overrides.yaml'), extensionOverrides(where(target)));
	await Bun.write(
		join(example, 'pubspec_overrides.yaml'),
		extensionOverrides(where(example), neededOverrides(core.pubspecText)),
	);
}

/** Internal: pub in the extension and its example, then the generated strings. */
async function fetchPackages(target: string): Promise<void> {
	const failure = { message: 'The packages for the new extension could not be fetched.' };
	await runOrThrow('flutter', ['pub', 'get'], failure, { cwd: target });
	await runOrThrow('flutter', ['pub', 'get'], failure, { cwd: join(target, 'example') });
	// The generated strings carry the template's name until they are made again.
	await runOrThrow(
		'dart',
		['run', 'slang'],
		{ message: 'Its texts could not be generated.' },
		{ cwd: target },
	);
}

/** Internal: `git init` and the first commit. False when git would not commit. */
async function commitFirst(target: string, names: ExtensionNames): Promise<boolean> {
	const steps = [
		['init', '--quiet'],
		['symbolic-ref', 'HEAD', 'refs/heads/main'],
		['add', '--all'],
		['commit', '--quiet', '--message', `Create ${names.name} from the SmartifyOS template`],
	];
	for (const args of steps) {
		if ((await run('git', args, { cwd: target })).code !== 0) return false;
	}
	return true;
}
