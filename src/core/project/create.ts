import { extname } from 'node:path';
import { CliError } from '../../utils/errors.ts';
import { withAssets } from '../pubspec/assets.ts';
import { entryNames } from '../pubspec/blocks.ts';
import { parsePubspec, sourceOf } from '../pubspec/read.ts';
import { type CoreAt, corePackage, neededOverrides } from '../smartify-os.ts';
import { withCore, withExtension } from './block.ts';
import { addImportLine, setArgument } from './main-dart.ts';

/**
 * Turning SmartifyOS's app template into someone's own car.
 *
 * The template names the car in exactly two spellings, `my_car` (in the package name) and
 * `My car` (wherever a person reads it), so naming it is a plain replace of those two, like
 * the extension template. What else differs from car to car is asked once and written into
 * `lib/main.dart` as arguments of the calls the template makes, see {@link setUpMain}.
 */

/** Every spelling of a car's name. */
export interface CarNames {
	/** As the driver and the phone read it: `Golf 4`. */
	name: string;
	/** `golf_4`. */
	snake: string;
	/** `smartify_os_golf_4_app`, which is also the folder's name. */
	packageName: string;
}

/**
 * Every spelling of a car's name, from the name as the driver should read it.
 *
 * It ends up inside quotes in Dart and YAML, so quotes, `$` and backslashes are refused
 * rather than escaped.
 *
 * @throws {CliError} when it cannot be a name, saying why.
 */
export function carNames(input: string): CarNames {
	const name = input.trim().replace(/\s+/g, ' ');

	if (!/^[\p{L}\p{N}][\p{L}\p{N} .,&+()-]*$/u.test(name) || name.length > 40) {
		throw new CliError(`"${input}" cannot be the name of a car.`, {
			hint: 'Start it with a letter or a digit, keep it short, and leave out quotes and symbols, like "Miata" or "Golf 4".',
		});
	}

	const snake = name
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
	if (!snake) {
		throw new CliError(`"${name}" has no letter from A to Z or digit in it.`, {
			hint: 'It is also the name of a folder, which needs at least one, like "Golf" or "MX-5".',
		});
	}

	return { name, snake, packageName: `smartify_os_${snake}_app` };
}

/** Renames both spellings the template uses in a piece of text. */
export function renameCarText(text: string, names: CarNames): string {
	return text.replaceAll('my_car', names.snake).replaceAll('My car', names.name);
}

/** One of the layouts SmartifyOS ships, the way the owner is offered it. */
export interface LayoutChoice {
	/** Its `id`, also the name of its constant in `Layouts`. */
	id: string;
	label: string;
	hint: string;
}

/**
 * The layouts SmartifyOS ships, in `Layouts` in core. One that is not listed here can still
 * be picked in `lib/main.dart`, or by the driver in Settings.
 */
export const layouts: LayoutChoice[] = [
	{
		id: 'classic',
		label: 'Classic',
		hint: 'the car filling the screen, cards sliding in above it',
	},
	{ id: 'split', label: 'Split', hint: 'the car in a panel, widgets next to it' },
	{ id: 'sidebar', label: 'Sidebar', hint: "a bar down the driver's side, next to open apps" },
	{ id: 'tiles', label: 'Tiles', hint: "a grid of widgets like a phone's, and a dock" },
	{ id: 'focus', label: 'Focus', hint: 'the speed, big, and very little else' },
	{ id: 'portrait', label: 'Portrait', hint: 'for a screen standing upright' },
];

export type DriverSide = 'left' | 'right';

/** What sits in the bar, by the name of its `BarContent` constructor. */
export type BarChoice = 'infoDisplay' | 'dock' | 'infoDisplayAndDock';

/** The pictures of the car the owner has, as paths inside the app's `assets`. */
export interface CarLooks {
	model3D?: string | undefined;
	drawing2D?: string | undefined;
	image?: string | undefined;
}

/** Everything about a new car that is asked while creating it. */
export interface CarSetup {
	/** The car itself, for the About page: `Mazda MX-5 NB 1.8`. */
	model?: string | undefined;
	layout: string;
	driverSide: DriverSide;
	bar: BarChoice;
	timeZone: string;
	looks: CarLooks;
	reverseCamera: boolean;
}

/** The file extensions each look takes. */
export const lookExtensions: Record<keyof CarLooks, string[]> = {
	model3D: ['.glb'],
	drawing2D: ['.svg'],
	image: ['.png', '.jpg', '.jpeg', '.webp'],
};

/** Where a picture of the car goes in its app: `assets/golf_4_model.glb`. */
export function lookAsset(names: CarNames, look: keyof CarLooks, file: string): string {
	const extension = extname(file).toLowerCase();
	const suffix = look === 'model3D' ? '_model' : look === 'drawing2D' ? '_drawing' : '';
	return `assets/${names.snake}${suffix}${extension}`;
}

/** The time zone this computer is in, which is the likeliest one for the car too. */
export function localTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Whether a time zone name is one the standard list has, like `Europe/Berlin`. */
export function isTimeZone(name: string): boolean {
	if (!name.trim()) return false;
	try {
		new Intl.DateTimeFormat('en', { timeZone: name.trim() });
		return true;
	} catch {
		return false;
	}
}

/**
 * A string as a Dart literal, in double quotes when that saves escaping an apostrophe:
 * `"Driver's seat"`, the way `dart format` users write it.
 */
export function dartString(value: string): string {
	const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
	const special = quote === '"' ? /[\\"$]/g : /[\\'$]/g;
	return `${quote}${value.replace(special, (char) => `\\${char}`)}${quote}`;
}

/** Internal: the calls of the template's `lib/main.dart` the answers go into. */
const calls = {
	init: /\bSmartifyOs\s*\(\s*\)\s*\.\s*init\s*\(/,
	about: /\bAboutConfig\s*\(/,
	layouts: /\bLayoutsConfig\s*\(/,
	bar: /\bBarConfig\s*\(/,
	dateTime: /\bDateTimeConfig\s*\(/,
};

/** Internal: one argument to set, and how to tell the owner when it could not be. */
interface Setting {
	call: RegExp;
	callName: string;
	name: string;
	value: string;
	before?: string;
	comment?: string[];
	import?: string;
}

/** Internal: the arguments that say what the owner answered. */
function settings(setup: CarSetup): Setting[] {
	const list: Setting[] = [
		{
			call: calls.layouts,
			callName: 'LayoutsConfig',
			name: 'layout',
			value: `Layouts.${setup.layout}`,
		},
		{
			call: calls.layouts,
			callName: 'LayoutsConfig',
			name: 'driverSide',
			value: `DriverSide.${setup.driverSide}`,
		},
		{ call: calls.bar, callName: 'BarConfig', name: 'content', value: `BarContent.${setup.bar}()` },
		{
			call: calls.dateTime,
			callName: 'DateTimeConfig',
			name: 'timeZone',
			value: dartString(setup.timeZone),
		},
	];

	if (setup.model) {
		list.push({
			call: calls.about,
			callName: 'AboutConfig',
			name: 'model',
			value: dartString(setup.model),
		});
	}

	const looks = (Object.keys(lookExtensions) as (keyof CarLooks)[]).flatMap((look) => {
		const path = setup.looks[look];
		if (!path) return [];
		const config =
			look === 'model3D'
				? 'CarModel3DConfig'
				: look === 'drawing2D'
					? 'CarDrawing2DConfig'
					: 'CarImageConfig';
		return [`${look}: ${config}(path: ${dartString(path)})`];
	});
	if (looks.length > 0) {
		list.push({
			call: calls.init,
			callName: 'SmartifyOs().init',
			name: 'car',
			value: `const CarConfig(${looks.join(', ')})`,
			before: 'extensions',
			comment: [
				'The car, wherever a layout shows it. A 3D model can be turned and sized',
				'with `rotation` and `scale` in its CarModel3DConfig.',
			],
			import: "import 'package:smartify_os_core/car.dart';",
		});
	}

	if (setup.reverseCamera) {
		list.push({
			call: calls.init,
			callName: 'SmartifyOs().init',
			name: 'reverseCamera',
			value: 'const ReverseCameraConfig()',
			before: 'extensions',
			comment: [
				'The reverse camera, any USB camera. It fills the screen while the car is',
				'in reverse, once something calls SmartifyOsReverseCamera.setReversing.',
			],
			import: "import 'package:smartify_os_core/reverse_camera.dart';",
		});
	}

	return list;
}

/**
 * Writes the owner's answers into the template's `lib/main.dart`.
 *
 * Each answer is one argument of a call the template makes (`LayoutsConfig(layout: ...)`),
 * set whether the template wrote it or not. Should the template ever stop making one of
 * those calls, that answer is left out and comes back in `manual`, as the line to add by
 * hand, rather than failing a car that otherwise works.
 */
export function setUpMain(source: string, setup: CarSetup): { source: string; manual: string[] } {
	let result = source;
	const manual: string[] = [];

	for (const setting of settings(setup)) {
		const edited = setArgument(result, setting.call, setting.name, setting.value, {
			...(setting.before ? { before: setting.before } : {}),
			...(setting.comment ? { comment: setting.comment } : {}),
		});
		if (edited === undefined) {
			manual.push(`${setting.name}: ${setting.value} in ${setting.callName}(...)`);
			continue;
		}
		result = setting.import ? addImportLine(edited, setting.import) : edited;
	}

	return { source: result, manual };
}

/**
 * A new car's `pubspec.yaml`: SmartifyOS from where the CLI gets it, every extension the way
 * the CLI writes one, and the pictures of the car among the assets.
 *
 * The template and the Miata app find SmartifyOS by path inside the SmartifyOS repository,
 * which is no use anywhere else, so it is pointed at the release (or branch) they were
 * copied from. An extension the Miata app names as a git dependency is moved to the
 * overrides, where `extension update` looks for it.
 */
export function finishAppPubspec(text: string, core: CoreAt, assets: string[] = []): string {
	let result = withCore(text, core.source, neededOverrides(core.pubspecText));

	const pubspec = parsePubspec(result, 'pubspec.yaml');
	for (const name of entryNames(result, 'dependencies')) {
		if (name === corePackage) continue;
		const source = sourceOf(pubspec.dependencies?.[name]);
		if (source.kind === 'git' && source.ref) {
			result = withExtension(result, name, { url: source.url, path: source.path, ref: source.ref });
		}
	}

	return withAssets(result, assets);
}
