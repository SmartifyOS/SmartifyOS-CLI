import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { removeFolder } from '../core/extension/create.ts';
import {
	addPlatforms,
	analyzeErrors,
	desktopPlatform,
	packageConfigPath,
} from '../core/flutter.ts';
import { commitFirst } from '../core/git.ts';
import { run, runOrThrow } from '../core/process.ts';
import {
	type BarChoice,
	type CarLooks,
	type CarNames,
	type CarSetup,
	carNames,
	type DriverSide,
	finishAppPubspec,
	isTimeZone,
	layouts,
	localTimeZone,
	lookAsset,
	lookExtensions,
	renameCarText,
	setUpMain,
} from '../core/project/create.ts';
import { findProject } from '../core/project/find.ts';
import {
	appTemplateFolder,
	type CoreAt,
	isReleaseTag,
	miataFolder,
	newestCore,
} from '../core/smartify-os.ts';
import { copyFolder, withCoreFolder } from '../core/template.ts';
import { nextSteps } from '../ui/next-steps.ts';
import { intro, log, outro } from '../ui/output.ts';
import { step } from '../ui/project.ts';
import { confirm, isInteractive, select, text } from '../ui/prompt.ts';
import { theme } from '../ui/theme.ts';
import { CliError } from '../utils/errors.ts';
import { binaryName } from './flags.ts';
import type { Command, Flags } from './types.ts';

/** What a new car's app can start from. */
type Start = 'minimal' | 'miata';

/** What `--bar` takes, and the `BarContent` each one is. */
const barFlag: Record<string, BarChoice> = {
	'info-display': 'infoDisplay',
	dock: 'dock',
	both: 'infoDisplayAndDock',
};

/** The flags that set a minimal app up, which the Miata app has no use for. */
const setupFlags = [
	'name',
	'car',
	'layout',
	'driver-side',
	'bar',
	'time-zone',
	'model-3d',
	'drawing',
	'picture',
	'reverse-camera',
];

/**
 * Creates a new car's app, set up for the car with a few questions, built and committed.
 */
export const createCommand: Command = {
	name: 'create',
	aliases: ['new'],
	summary: "Create your car's app",
	description:
		"Creates the app for your car, the one you then try, add extensions to and put on the car. It asks for what is different in every car (its name, how the screen is laid out, which side the driver sits on, a picture of it) and writes your answers into lib/main.dart, where you can change them any time. Or it copies the Miata app, the example car with everything in it, to learn from. Inside a car's app folder the new one goes next to it, anywhere else right where you are.",
	usage: '[name]',
	examples: [
		`${binaryName} create`,
		`${binaryName} create "Golf 4" --car "Volkswagen Golf IV" --layout split --driver-side right`,
		`${binaryName} create --from miata`,
	],
	flags: {
		from: {
			type: 'string',
			describe: 'What to start from: minimal (the default, set up for your car) or miata',
		},
		name: { type: 'string', describe: 'What the car is called, like "Miata"' },
		car: { type: 'string', describe: 'What car it is, for the About page, like "Mazda MX-5 NB"' },
		layout: {
			type: 'string',
			describe: `How the screen is laid out: ${layouts.map((layout) => layout.id).join(', ')}`,
		},
		'driver-side': { type: 'string', describe: 'Which side the driver sits on: left or right' },
		bar: { type: 'string', describe: 'What goes in the bar: info-display, dock or both' },
		'time-zone': { type: 'string', describe: 'The time zone the car is in, like Europe/Berlin' },
		'model-3d': { type: 'string', describe: 'A 3D model of the car, a .glb file' },
		drawing: { type: 'string', describe: 'A drawing of the car seen from above, an .svg file' },
		picture: { type: 'string', describe: 'A picture of the car, a .png or .jpg file' },
		'reverse-camera': { type: 'boolean', describe: 'The car has a reverse camera on USB' },
		dir: { type: 'string', describe: 'The folder to create it in (the default is here)' },
		'dry-run': {
			type: 'boolean',
			describe: 'Only check the answers and say where it would go, without creating anything',
		},
	},
	async run({ flags, positionals }) {
		intro("Create your car's app");
		const cwd = process.cwd();
		const project = await findProject(cwd);
		// Next to a car's app or an extension rather than inside it.
		const defaultParent = project ? dirname(project.dir) : cwd;
		const asking = isInteractive() && flags.yes !== true;

		const start = await pickStart(flags, asking);
		const names = start === 'miata' ? undefined : carNames(await askName(flags, positionals[0]));
		const folderName = names?.packageName ?? miataFolder;

		if (start === 'miata') {
			const ignored = setupFlags.filter((flag) => flags[flag] !== undefined);
			if (positionals[0]) ignored.unshift('a name');
			if (ignored.length > 0) {
				log.warn(
					`The Miata app is copied as it is, so ${ignored.map((flag) => (flag.includes(' ') ? flag : `--${flag}`)).join(', ')} ${ignored.length === 1 ? 'was' : 'were'} left out. Change it in ${theme.code('lib/main.dart')} instead.`,
				);
			}
		}

		const target = await pickTarget(flags, cwd, defaultParent, folderName, asking);
		const setup = names ? await askSetup(flags, cwd, asking) : undefined;

		if (flags['dry-run'] === true) {
			outro(`It would go in ${theme.code(relative(cwd, target) || '.')}`);
			return {
				changed: false,
				from: start,
				name: names?.name ?? null,
				packageName: folderName,
				path: target,
				setup: setup ?? null,
			};
		}

		const core = await step('Finding the newest SmartifyOS', () => newestCore());
		const label = isReleaseTag(core.source.ref) ? core.version : core.source.ref;
		log.info(`Made for SmartifyOS ${theme.strong(label)}`);

		let manual: string[] = [];
		try {
			if (names && setup) {
				manual = await step(
					'Copying the app template',
					() => createFromTemplate(target, names, setup, core),
					() => `Created ${theme.code(relative(cwd, target) || '.')} for ${names.name}`,
				);
			} else {
				await step(
					'Copying the Miata app',
					() => createFromMiata(target, core),
					() => `Copied the Miata app to ${theme.code(relative(cwd, target) || '.')}`,
				);
			}
			await addMissingPlatforms(target, folderName);
			await step('Fetching packages', () =>
				runOrThrow(
					'flutter',
					['pub', 'get'],
					{ message: "The packages for your car's app could not be fetched." },
					{ cwd: target },
				),
			);
		} catch (error) {
			await removeFolder(target);
			throw error;
		}

		// Answers written into calls end up on one long line, which this puts right.
		if (names) await run('dart', ['format', 'lib'], { cwd: target });
		await step(
			'Checking that it builds',
			() => checkBuilds(target),
			() => 'It builds',
		);

		const committed = await step('Making it a git repository', () =>
			commitFirst(
				target,
				names
					? `Create ${names.name} from the SmartifyOS template`
					: 'Copy the Miata app from SmartifyOS',
			),
		);
		if (!committed) {
			log.warn('It could not be committed, so it has no history yet. Everything else is ready.');
		}

		if (manual.length > 0) {
			log.warn(
				[
					`These could not be written into ${theme.code('lib/main.dart')}, add them yourself:`,
					...manual.map((line) => `  ${theme.code(line)}`),
				].join('\n'),
			);
		}

		const folder = relative(cwd, target) || '.';
		nextSteps(
			[
				{ kind: 'open-folder', text: theme.code(`cd ${folder}`), path: target },
				{
					kind: 'edit-main',
					text: names
						? `Everything about ${names.name} is set up in ${theme.code('lib/main.dart')}.`
						: `It is the Miata's, so give it your car's name, picture and the rest in ${theme.code('lib/main.dart')}.`,
					path: 'lib/main.dart',
				},
				{ kind: 'run', text: `${theme.code(`${binaryName} run`)}  tries it on this computer` },
				{
					kind: 'add-extension',
					text: `${theme.code(`${binaryName} extension add <url>`)}  adds an extension`,
				},
				{
					kind: 'export-installer',
					text: `${theme.code(`${binaryName} export installer`)}  puts it on a USB stick for the car`,
				},
			],
			{ numbered: false },
		);
		outro(`${theme.success(theme.strong(names?.name ?? 'The Miata app'))} is ready`);

		return {
			changed: true,
			from: start,
			name: names?.name ?? null,
			packageName: names?.packageName ?? miataFolder,
			path: target,
			smartifyOs: label,
			setup: setup ?? null,
			manual,
			committed,
		};
	},
};

/** Internal: the minimal app or the Miata app. */
async function pickStart(flags: Flags, asking: boolean): Promise<Start> {
	if (typeof flags.from === 'string') {
		const from = flags.from.trim().toLowerCase();
		if (from === 'minimal' || from === 'miata') return from;
		throw new CliError(`There is nothing called "${flags.from}" to start from.`, {
			hint: 'Use --from minimal for an app set up for your car, or --from miata for the Miata app.',
		});
	}
	if (!asking) return 'minimal';
	return await select<Start>({
		message: 'What should it start from?',
		options: [
			{
				value: 'minimal',
				label: 'A new app, set up for your car',
				hint: 'only what every car needs, recommended',
			},
			{
				value: 'miata',
				label: 'A copy of the Miata app',
				hint: 'the example car with everything in it, to learn from',
			},
		],
		initialValue: 'minimal',
	});
}

/** Internal: the car's name, from the flags or asked. */
async function askName(flags: Flags, positional: string | undefined): Promise<string> {
	const given = typeof flags.name === 'string' ? flags.name : positional;
	if (given) return given;
	return await text({
		message: 'What is your car called? Phones see this name when they pair with it.',
		placeholder: 'Miata',
		validate: (value) => problemWith(() => carNames(value ?? '')),
	});
}

/** Internal: the folder to create the app in, which must not be there yet. */
async function pickTarget(
	flags: Flags,
	cwd: string,
	defaultParent: string,
	folderName: string,
	asking: boolean,
): Promise<string> {
	let parent = typeof flags.dir === 'string' ? resolve(cwd, flags.dir) : defaultParent;
	if (typeof flags.dir !== 'string' && asking) {
		const shown = relative(cwd, defaultParent) || '.';
		parent = resolve(
			cwd,
			await text({
				message: 'Where should its folder go?',
				initialValue: shown,
				defaultValue: shown,
			}),
		);
	}

	const target = join(parent, folderName);
	if (existsSync(target)) {
		throw new CliError(`There is a folder called ${folderName} there already.`, {
			hint: 'Pick another name, or another place with --dir.',
		});
	}
	return target;
}

/** Internal: everything about the car that differs from car to car, from flags or asked. */
async function askSetup(flags: Flags, cwd: string, asking: boolean): Promise<CarSetup> {
	let model = typeof flags.car === 'string' ? flags.car.trim() : undefined;
	if (model === undefined && asking) {
		model = (
			await text({
				message: 'What car is it? This shows on the About page (you can leave this empty).',
				placeholder: 'Mazda MX-5 NB 1.8',
			})
		).trim();
	}

	let layout = typeof flags.layout === 'string' ? flags.layout.trim().toLowerCase() : undefined;
	if (layout !== undefined && !layouts.some((choice) => choice.id === layout)) {
		throw new CliError(`There is no layout called "${flags.layout}".`, {
			hint: `Pick one of ${layouts.map((choice) => choice.id).join(', ')}.`,
		});
	}
	layout ??= asking
		? await select({
				message: 'How should the screen be laid out? The driver can switch in Settings.',
				options: layouts.map((choice) => ({
					value: choice.id,
					label: choice.label,
					hint: choice.hint,
				})),
				initialValue: 'classic',
			})
		: 'classic';

	let driverSide: DriverSide | undefined;
	if (typeof flags['driver-side'] === 'string') {
		const side = flags['driver-side'].trim().toLowerCase();
		if (side !== 'left' && side !== 'right') {
			throw new CliError(`The driver sits on the left or the right, not "${side}".`, {
				hint: 'Use --driver-side left or --driver-side right.',
			});
		}
		driverSide = side;
	}
	driverSide ??= asking
		? await select<DriverSide>({
				message: 'Which side does the driver sit on?',
				options: [
					{ value: 'left', label: 'Left', hint: 'most of the world' },
					{
						value: 'right',
						label: 'Right',
						hint: 'the UK, Ireland, Japan, Australia, India and others',
					},
				],
				initialValue: 'left',
			})
		: 'left';

	let bar: BarChoice | undefined;
	if (typeof flags.bar === 'string') {
		bar = barFlag[flags.bar.trim().toLowerCase()];
		if (!bar) {
			throw new CliError(`The bar cannot hold "${flags.bar}".`, {
				hint: 'Use --bar info-display, --bar dock or --bar both.',
			});
		}
	}
	bar ??= asking
		? await select<BarChoice>({
				message: 'What goes in the bar along the edge of the screen?',
				options: [
					{
						value: 'infoDisplay',
						label: 'The info display',
						hint: 'the speed, and whatever else your car reports',
					},
					{ value: 'dock', label: 'A dock', hint: 'the apps the driver uses most' },
					{ value: 'infoDisplayAndDock', label: 'Both' },
				],
				initialValue: 'infoDisplay',
			})
		: 'infoDisplay';

	let timeZone = typeof flags['time-zone'] === 'string' ? flags['time-zone'].trim() : undefined;
	if (timeZone !== undefined && !isTimeZone(timeZone)) {
		throw new CliError(`"${timeZone}" is not a time zone.`, {
			hint: 'Use the standard name, Region/City, like Europe/Berlin or America/New_York.',
		});
	}
	timeZone ??= asking
		? (
				await text({
					message: 'Which time zone is the car in?',
					initialValue: localTimeZone(),
					defaultValue: localTimeZone(),
					validate: (value) =>
						isTimeZone(value ?? '')
							? undefined
							: 'Use the standard name, Region/City, like Europe/Berlin.',
				})
			).trim()
		: localTimeZone();

	const looks = await askLooks(flags, cwd, asking);

	const reverseCamera =
		flags['reverse-camera'] === true ||
		(flags['reverse-camera'] === undefined &&
			asking &&
			(await confirm({
				message: 'Does the car have a reverse camera, a camera plugged in over USB?',
				initialValue: false,
			})));

	return {
		...(model ? { model } : {}),
		layout,
		driverSide,
		bar,
		timeZone,
		looks,
		reverseCamera,
	};
}

/** Internal: how each look is asked for and named in a flag. */
const lookFlags: Record<keyof CarLooks, string> = {
	model3D: 'model-3d',
	drawing2D: 'drawing',
	image: 'picture',
};

/**
 * Internal: the files of the car's pictures, from the flags, or one of them asked for.
 * These are paths on this computer, which become the app's assets once it exists.
 */
async function askLooks(flags: Flags, cwd: string, asking: boolean): Promise<CarLooks> {
	const looks: CarLooks = {};
	for (const look of Object.keys(lookFlags) as (keyof CarLooks)[]) {
		const value = flags[lookFlags[look]];
		if (typeof value !== 'string') continue;
		const path = cleanPath(value, cwd);
		const problem = lookProblem(path, look);
		if (problem) throw new CliError(problem, { hint: `Check --${lookFlags[look]}.` });
		looks[look] = path;
	}

	const given = Object.keys(looks).length > 0;
	if (given || !asking) return looks;

	const look = await select<keyof CarLooks | 'none'>({
		message: 'Do you have a 3D model, a drawing or a picture of the car? It shows on the screen.',
		options: [
			{ value: 'none', label: 'Not now', hint: 'you can add one to lib/main.dart later' },
			{ value: 'model3D', label: 'A 3D model', hint: 'a .glb file, from Blender for example' },
			{ value: 'drawing2D', label: 'A drawing seen from above', hint: 'an .svg file' },
			{ value: 'image', label: 'A picture', hint: 'a .png or .jpg file' },
		],
		initialValue: 'none',
	});
	if (look === 'none') return looks;

	looks[look] = cleanPath(
		await text({
			message: 'Where is the file? You can drag it in here.',
			validate: (value) => lookProblem(cleanPath(value ?? '', cwd), look),
		}),
		cwd,
	);
	return looks;
}

/** Internal: why a file cannot be this look of the car, or nothing when it can. */
function lookProblem(path: string, look: keyof CarLooks): string | undefined {
	if (!path || !existsSync(path)) return `There is no file at ${path || 'that path'}.`;
	const allowed = lookExtensions[look];
	if (!allowed.includes(extname(path).toLowerCase())) {
		return `That has to be ${allowed.length === 1 ? 'a' : 'one of'} ${allowed.join(', ')} file.`;
	}
	return undefined;
}

/**
 * Internal: a path as someone typed or dragged it in: quotes taken off, `\ ` the way a
 * terminal escapes a space, and `~` for their home folder.
 */
function cleanPath(input: string, cwd: string): string {
	let path = input.trim();
	if (/^(['"]).*\1$/.test(path)) path = path.slice(1, -1);
	else if (process.platform !== 'win32') path = path.replace(/\\(.)/g, '$1');
	if (!path) return '';
	if (path === '~' || path.startsWith('~/')) path = join(homedir(), path.slice(1));
	return resolve(cwd, path);
}

/** Internal: the message of whatever `check` throws, for a prompt's validation. */
function problemWith(check: () => unknown): string | undefined {
	try {
		check();
		return undefined;
	} catch (error) {
		return error instanceof CliError ? (error.hint ?? error.message) : String(error);
	}
}

/**
 * Internal: the template, renamed for the car, with its pictures, its pubspec pointed at
 * SmartifyOS and the answers in `lib/main.dart`.
 *
 * @returns what could not be written into `lib/main.dart`.
 */
async function createFromTemplate(
	target: string,
	names: CarNames,
	setup: CarSetup,
	core: CoreAt,
): Promise<string[]> {
	const missing = new CliError(`SmartifyOS ${core.source.ref} has no template for a new car.`, {
		hint: `Start from the Miata app instead, with ${theme.code(`${binaryName} create --from miata`)}.`,
	});
	await withCoreFolder(core.source.ref, appTemplateFolder, missing, (dir) =>
		copyFolder(dir, target, (text) => renameCarText(text, names)),
	);

	const looks: CarLooks = {};
	for (const look of Object.keys(setup.looks) as (keyof CarLooks)[]) {
		const file = setup.looks[look];
		if (!file) continue;
		const asset = lookAsset(names, look, file);
		await Bun.write(join(target, asset), Bun.file(file));
		looks[look] = asset;
	}

	const pubspecPath = join(target, 'pubspec.yaml');
	const pubspec = await Bun.file(pubspecPath).text();
	const assets = Object.values(looks).filter((asset): asset is string => Boolean(asset));
	await Bun.write(pubspecPath, finishAppPubspec(pubspec, core, assets));

	const mainPath = join(target, 'lib', 'main.dart');
	const main = setUpMain(await Bun.file(mainPath).text(), { ...setup, looks });
	await Bun.write(mainPath, main.source);
	return main.manual;
}

/** Internal: the Miata app as it is, with its pubspec pointed at SmartifyOS. */
async function createFromMiata(target: string, core: CoreAt): Promise<void> {
	const missing = new CliError(`SmartifyOS ${core.source.ref} has no Miata app.`, {
		hint: `Start from a new app instead, with ${theme.code(`${binaryName} create --from minimal`)}.`,
	});
	await withCoreFolder(core.source.ref, miataFolder, missing, (dir) => copyFolder(dir, target));

	const pubspecPath = join(target, 'pubspec.yaml');
	const pubspec = await Bun.file(pubspecPath).text();
	await Bun.write(pubspecPath, finishAppPubspec(pubspec, core));
}

/**
 * Internal: the Linux part, which the car runs, and this computer's, which `run` tries it
 * on, when the app does not have them yet.
 */
async function addMissingPlatforms(target: string, packageName: string): Promise<void> {
	const platforms = [...new Set(['linux', desktopPlatform()])].filter(
		(platform) => !existsSync(join(target, platform)),
	);
	if (platforms.length === 0) return;
	const shown = { linux: 'Linux', macos: 'macOS', windows: 'Windows' } as Record<string, string>;
	const names = platforms.map((platform) => shown[platform] ?? platform).join(' and ');
	await step(`Adding the parts for ${names}`, () => addPlatforms(target, platforms, packageName));
}

/** Internal: analyzes the new app, which has to build before anyone gets it. */
async function checkBuilds(target: string): Promise<void> {
	const errors = await analyzeErrors([join(target, 'lib')], packageConfigPath(target));
	if (errors.length === 0) return;
	const lines = errors
		.slice(0, 10)
		.map((problem) => `${relative(target, problem.file)}:${problem.line}  ${problem.message}`);
	throw new CliError("The new car's app does not build.", {
		details: { problems: errors },
		hint: `That is a bug in SmartifyOS, not something you did. Please report it at https://github.com/SmartifyOS/SmartifyOS-CLI/issues with this:\n${lines.join('\n')}`,
	});
}
