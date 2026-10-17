import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { withAssets } from '../pubspec/assets.ts';
import { type BarChoice, type CarLooks, type DriverSide, dartString, layouts } from './create.ts';
import { writeDart } from './dart-file.ts';
import { addImportLine, argumentValue, removeArgument, setArgument } from './main-dart.ts';

/**
 * How a car's app looks and what its About page says, read from and written into its
 * `lib/main.dart`: the arguments of `SmartifyOs().init` and the configs inside it.
 *
 * Like everything else the CLI writes into Dart the owner may have changed, a setting is only
 * read or written where its one place can be found without doubt. A setting written as code
 * the CLI cannot read (`layout: myLayout`) is reported as code rather than guessed at, and a
 * change with no clear place to go is handed back as the line to add by hand.
 */

/** One of the themes SmartifyOS ships, the way the owner is offered it. */
export interface ThemeChoice {
	/** Its `id`, also the name of its constant in `Themes`. */
	id: string;
	label: string;
	hint: string;
}

/** The themes SmartifyOS ships, in `Themes` in core. Every layout is made for one of them. */
export const themes: ThemeChoice[] = [
	{ id: 'glass', label: 'Glass', hint: 'dark, rounded and frosted glass' },
	{ id: 'slate', label: 'Slate', hint: 'solid dark panels on near black' },
	{ id: 'carbon', label: 'Carbon', hint: 'flat grey on black with a blue accent' },
	{ id: 'frost', label: 'Frost', hint: 'light frosted white panels' },
	{ id: 'midnight', label: 'Midnight', hint: 'pure black with hairline outlines' },
	{ id: 'horizon', label: 'Horizon', hint: 'deep blue frosted glass' },
	{ id: 'retro', label: 'Retro', hint: 'teal lines on black, like a 90s dashboard' },
];

/** The ways a car can be drawn, by their names in `CarLook`. */
export type CarLookName = keyof CarLooks;

export const carLooks: CarLookName[] = ['model3D', 'drawing2D', 'image'];

/** How the car's app looks, as its `lib/main.dart` says. */
export interface Appearance {
	/** The layout it starts with, by id. Null when it is written as code, see {@link code}. */
	layout: string | null;
	/** The theme it wears in every layout until the driver picks one, null for each layout's own. */
	theme: string | null;
	driverSide: DriverSide | null;
	bar: BarChoice | null;
	/** The pictures of the car, as paths inside the app, and which of them it starts with. */
	car: {
		model3D: string | null;
		drawing2D: string | null;
		image: string | null;
		look: CarLookName | null;
	};
	/** What the About page says about the car. */
	about: { name: string | null; model: string | null; extra: Record<string, string> };
	/**
	 * Settings written as code the CLI cannot read, by name, as they are written:
	 * `{ layout: 'miataRoadsterLayout' }`. Changing one replaces the code.
	 */
	code: Record<string, string>;
}

/** What to change. Anything left out stays as it is. */
export interface AppearanceChange {
	layout?: string;
	/** Null goes back to each layout wearing its own. */
	theme?: string | null;
	driverSide?: DriverSide;
	bar?: BarChoice;
	/** Paths inside the app (see {@link placeAsset}), or null to take one out. */
	model3D?: string | null;
	drawing2D?: string | null;
	image?: string | null;
	/** Null goes back to the first way the car can be drawn. */
	look?: CarLookName | null;
	/** What the car is called, on the About page and for phones pairing with it. */
	name?: string;
	/** The car itself, for the About page. Empty takes it off. */
	model?: string;
	/** Rows at the bottom of the About page, by label. An empty value takes that row off. */
	extra?: Record<string, string>;
}

/** Internal: a call in `lib/main.dart` and where it sits, for putting arguments into it. */
interface Config {
	/** The class whose constructor it is, or `SmartifyOs().init`. */
	name: string;
	call: RegExp;
	/** The argument of the parent call it is the value of. */
	argument?: string;
	parent?: Config;
	import?: string;
	/** Said above it when it is added to `SmartifyOs().init`. */
	comment?: string[];
}

function config(
	name: string,
	parent: Config,
	argument: string,
	more: Partial<Config> = {},
): Config {
	return { name, call: new RegExp(`\\b${name}\\s*\\(`), parent, argument, ...more };
}

const init: Config = {
	name: 'SmartifyOs().init',
	call: /\bSmartifyOs\s*\(\s*\)\s*\.\s*init\s*\(/,
};
const layoutsImport = "import 'package:smartify_os_core/layouts.dart';";
const carImport = "import 'package:smartify_os_core/car.dart';";
const configs = {
	layouts: config('LayoutsConfig', init, 'layouts', { import: layoutsImport }),
	themes: config('ThemesConfig', init, 'themes', {
		import: "import 'package:smartify_os_core/theme.dart';",
		comment: ['The theme every layout wears until the driver picks one in Settings.'],
	}),
	bar: config('BarConfig', init, 'bar', { import: layoutsImport }),
	settings: config('SettingsConfig', init, 'settings', {
		import: "import 'package:smartify_os_core/settings.dart';",
	}),
	bluetooth: config('BluetoothConfig', init, 'bluetooth'),
	car: config('CarConfig', init, 'car', {
		import: carImport,
		comment: [
			'The car, wherever a layout shows it. A 3D model can be turned and sized',
			'with `rotation` and `scale` in its CarModel3DConfig.',
		],
	}),
};
const lookConfigs: Record<CarLookName, Config> = {
	model3D: config('CarModel3DConfig', configs.car, 'model3D', { import: carImport }),
	drawing2D: config('CarDrawing2DConfig', configs.car, 'drawing2D', { import: carImport }),
	image: config('CarImageConfig', configs.car, 'image', { import: carImport }),
};
const about = config('AboutConfig', configs.settings, 'about', {
	import: "import 'package:smartify_os_core/settings.dart';",
});

/**
 * Internal: one argument's value as written, or how the config it belongs in stands when the
 * argument is not there: `missing` when nothing is in the way of adding it, `code` with what
 * is written instead when the config is not a plain constructor call.
 */
function read(
	source: string,
	at: Config,
	name: string,
): string | { missing: true } | { code: string } {
	const value = argumentValue(source, at.call, name);
	if (typeof value === 'string') return value;
	if (value === null || !at.parent || !at.argument) return { missing: true };
	const parent = read(source, at.parent, at.argument);
	return typeof parent === 'string' ? { code: parent } : parent;
}

/** Internal: a Dart string literal's text, or undefined when it is anything else. */
export function dartStringValue(code: string): string | undefined {
	const match = /^r?(['"])(.*)\1$/s.exec(code.trim());
	if (!match) return undefined;
	const body = match[2] ?? '';
	if (code.trim().startsWith('r')) return body;
	if (/(^|[^\\])\$/.test(body)) return undefined;
	return body.replace(/\\(.)/g, '$1');
}

/** Internal: `Layouts.split` as `split`, the same for any `Prefix.name` or `Prefix.name()`. */
function constantName(code: string, prefix: string): string | undefined {
	return new RegExp(`^(?:const\\s+)?${prefix}\\.([A-Za-z_][A-Za-z0-9_]*)(?:\\(\\s*\\))?$`).exec(
		code,
	)?.[1];
}

/** Reads how the app looks and what its About page says from its `lib/main.dart`. */
export function readAppearance(source: string): Appearance {
	const code: Record<string, string> = {};

	/** One setting: its value read by `parse`, or its code when it cannot be. */
	const setting = <T>(
		key: string,
		at: Config,
		name: string,
		parse: (value: string) => T | undefined,
		fallback: T,
	): T | null => {
		const found = read(source, at, name);
		if (typeof found !== 'string' && 'missing' in found) return fallback;
		const written = typeof found === 'string' ? found : found.code;
		const parsed = typeof found === 'string' ? parse(found) : undefined;
		if (parsed !== undefined) return parsed;
		code[key] = written;
		return null;
	};

	const named = (prefix: string) => (value: string) =>
		constantName(value, prefix) ?? dartStringValue(value);
	const look = (key: CarLookName) =>
		setting(key, lookConfigs[key], 'path', dartStringValue, null as string | null);

	const extraCode = read(source, about, 'extra');
	const extra: Record<string, string> = {};
	if (typeof extraCode === 'string') {
		const map = parseStringMap(extraCode);
		if (map) Object.assign(extra, map);
		else code.extra = extraCode;
	}

	return {
		layout: setting('layout', configs.layouts, 'layout', named('Layouts'), 'classic'),
		theme: setting('theme', configs.themes, 'theme', named('Themes'), null as string | null),
		driverSide: setting(
			'driverSide',
			configs.layouts,
			'driverSide',
			(value) => {
				const side = constantName(value, 'DriverSide');
				return side === 'left' || side === 'right' ? side : undefined;
			},
			'left' as DriverSide,
		),
		bar: setting(
			'bar',
			configs.bar,
			'content',
			(value) => {
				const bar = constantName(value, 'BarContent');
				return bar === 'infoDisplay' || bar === 'dock' || bar === 'infoDisplayAndDock'
					? bar
					: undefined;
			},
			'infoDisplay' as BarChoice,
		),
		car: {
			model3D: look('model3D'),
			drawing2D: look('drawing2D'),
			image: look('image'),
			look: setting(
				'look',
				configs.car,
				'look',
				(value) => {
					const name = constantName(value, 'CarLook');
					return carLooks.find((known) => known === name);
				},
				null as CarLookName | null,
			),
		},
		about: {
			name: setting('name', about, 'deviceName', dartStringValue, null as string | null),
			model: setting('model', about, 'model', dartStringValue, null as string | null),
			extra,
		},
		code,
	};
}

/** Internal: `{'VIN': 'X', 'Colour': 'Red'}` as an object, undefined for anything fancier. */
function parseStringMap(code: string): Record<string, string> | undefined {
	const body = /^(?:const\s+)?(?:<String,\s*String>\s*)?\{([\s\S]*)\}$/.exec(code.trim())?.[1];
	if (body === undefined) return undefined;
	const map: Record<string, string> = {};
	const pair = /\s*(r?(['"])(?:\\.|(?!\2).)*\2)\s*:\s*(r?(['"])(?:\\.|(?!\4).)*\4)\s*(,|$)/gy;
	let rest = body.trim();
	if (!rest) return map;
	pair.lastIndex = 0;
	let consumed = 0;
	for (let match = pair.exec(rest); match; match = pair.exec(rest)) {
		const key = dartStringValue(match[1] ?? '');
		const value = dartStringValue(match[3] ?? '');
		if (key === undefined || value === undefined) return undefined;
		map[key] = value;
		consumed = pair.lastIndex;
		if (consumed >= rest.length) break;
	}
	rest = rest.slice(consumed).trim();
	return rest ? undefined : map;
}

/** Internal: a map of strings as Dart, the way a person would write it. */
function dartStringMap(map: Record<string, string>): string {
	const entries = Object.entries(map);
	if (entries.length === 0) return '{}';
	return `{${entries.map(([key, value]) => `${dartString(key)}: ${dartString(value)}`).join(', ')}}`;
}

/**
 * Internal: sets one argument of a config, adding the config to its parent (and that to its
 * own) when it is not there yet and nothing else is in the way.
 */
function put(source: string, at: Config, name: string, value: string): string | undefined {
	const edited = setArgument(source, at.call, name, value);
	if (edited !== undefined) return at.import ? addImportLine(edited, at.import) : edited;

	const parent = at.parent;
	if (!parent || !at.argument) return undefined;
	const found = read(source, parent, at.argument);
	if (typeof found === 'string' || 'code' in found) return undefined;

	// Directly in `SmartifyOs().init`, which is never const itself.
	const constant = parent === init ? 'const ' : '';
	const created = `${constant}${at.name}(${name}: ${value})`;
	if (parent === init) {
		const added = setArgument(source, init.call, at.argument, created, {
			before: 'extensions',
			...(at.comment ? { comment: at.comment } : {}),
		});
		if (added === undefined) return undefined;
		return at.import ? addImportLine(added, at.import) : added;
	}
	const added = put(source, parent, at.argument, created);
	return added !== undefined && at.import ? addImportLine(added, at.import) : added;
}

/**
 * Internal: takes one argument out of a config. Nothing to do when the config is not there at
 * all, and undefined when it is there as code.
 */
function take(source: string, at: Config, name: string): string | undefined {
	const removed = removeArgument(source, at.call, name);
	if (removed !== undefined) return removed;
	const found = at.parent && at.argument ? read(source, at.parent, at.argument) : undefined;
	return found && typeof found !== 'string' && 'missing' in found ? source : undefined;
}

/**
 * Writes a change into `lib/main.dart`.
 *
 * @returns the new source, and every part of the change that has no clear place, as the line
 * to add by hand.
 */
export function setAppearance(
	source: string,
	change: AppearanceChange,
): { source: string; manual: string[] } {
	let result = source;
	const manual: string[] = [];

	const apply = (edited: string | undefined, line: string) => {
		if (edited === undefined) manual.push(line);
		else result = edited;
	};
	const set = (at: Config, name: string, value: string) =>
		apply(put(result, at, name, value), `${name}: ${value} in ${at.name}(...)`);
	const unset = (at: Config, name: string) =>
		apply(take(result, at, name), `take ${name} out of ${at.name}(...)`);

	if (change.layout !== undefined) {
		const builtIn = layouts.some((layout) => layout.id === change.layout);
		set(
			configs.layouts,
			'layout',
			builtIn ? `Layouts.${change.layout}` : dartString(change.layout),
		);
	}
	if (change.driverSide !== undefined) {
		set(configs.layouts, 'driverSide', `DriverSide.${change.driverSide}`);
	}
	if (change.theme === null) unset(configs.themes, 'theme');
	else if (change.theme !== undefined) {
		const builtIn = themes.some((theme) => theme.id === change.theme);
		set(configs.themes, 'theme', builtIn ? `Themes.${change.theme}` : dartString(change.theme));
	}
	if (change.bar !== undefined) set(configs.bar, 'content', `BarContent.${change.bar}()`);

	for (const look of carLooks) {
		const path = change[look];
		if (path === null) unset(configs.car, look);
		else if (path !== undefined) set(lookConfigs[look], 'path', dartString(path));
	}
	if (change.look === null) unset(configs.car, 'look');
	else if (change.look !== undefined) set(configs.car, 'look', `CarLook.${change.look}`);

	if (change.name !== undefined) {
		set(about, 'deviceName', dartString(change.name));
		// The name phones see too, where the app gives one.
		if (typeof read(result, configs.bluetooth, 'name') === 'string') {
			set(configs.bluetooth, 'name', dartString(change.name));
		}
	}
	if (change.model === '') unset(about, 'model');
	else if (change.model !== undefined) set(about, 'model', dartString(change.model));

	if (change.extra !== undefined) {
		const current = readAppearance(result);
		if (current.code.extra !== undefined) {
			manual.push(`the rows ${dartStringMap(change.extra)} in extra: of AboutConfig(...)`);
		} else {
			const extra: Record<string, string> = { ...current.about.extra };
			for (const [label, value] of Object.entries(change.extra)) {
				if (value) extra[label] = value;
				else delete extra[label];
			}
			if (Object.keys(extra).length === 0) unset(about, 'extra');
			else set(about, 'extra', dartStringMap(extra));
		}
	}

	return { source: result, manual };
}

/**
 * Where a file on this computer goes in the app: the path it has when it is in the app
 * already, otherwise `assets/` and its name, which is where it is copied.
 */
export function assetPath(appDir: string, file: string): { asset: string; copy: boolean } {
	const absolute = resolve(file);
	const inside = relative(resolve(appDir), absolute);
	if (inside && !inside.startsWith('..') && !isAbsolute(inside)) {
		return { asset: inside.split(sep).join('/'), copy: false };
	}
	const name = basename(absolute, extname(absolute))
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '_')
		.replace(/^_+|_+$/g, '');
	return { asset: `assets/${name || 'car'}${extname(absolute).toLowerCase()}`, copy: true };
}

/** Copies a file into the app, unless it is in there already, and gives back its path there. */
export async function placeAsset(appDir: string, file: string): Promise<string> {
	const { asset, copy } = assetPath(appDir, file);
	if (copy) await Bun.write(join(appDir, asset), Bun.file(resolve(file)));
	return asset;
}

/** What {@link changeAppearance} did. */
export interface AppearanceChanged {
	changed: boolean;
	/** How it looks now. */
	appearance: Appearance;
	/** Every part of the change that has to be made by hand, as the line to add. */
	manual: string[];
	/** The files of the car that were copied in, as paths inside the app. */
	assets: string[];
	/**
	 * A running app only shows it after a restart: a picture of the car came or went, which
	 * the app reads when it starts.
	 */
	restart: boolean;
}

/**
 * Changes how the car's app looks: copies the pictures of the car into it, lists them in its
 * pubspec, and writes the rest into `lib/main.dart`.
 *
 * Pictures of the car are given as files on this computer, which become paths inside the app.
 * `lib/main.dart` is formatted again afterwards when it was formatted before, so a change reads
 * like the rest of it, and an owner's own style is left alone.
 */
export async function changeAppearance(
	appDir: string,
	change: AppearanceChange,
): Promise<AppearanceChanged> {
	const mainPath = join(appDir, 'lib', 'main.dart');
	const pubspecPath = join(appDir, 'pubspec.yaml');
	const placed: AppearanceChange = { ...change };
	const assets: string[] = [];
	for (const look of carLooks) {
		const file = change[look];
		if (typeof file !== 'string') continue;
		const asset = await placeAsset(appDir, file);
		placed[look] = asset;
		assets.push(asset);
	}
	if (assets.length > 0) {
		const pubspec = await Bun.file(pubspecPath).text();
		const withThem = withAssets(pubspec, assets);
		if (withThem !== pubspec) await Bun.write(pubspecPath, withThem);
	}

	const before = await Bun.file(mainPath).text();
	const { source, manual } = setAppearance(before, placed);
	await writeDart(mainPath, before, source);
	const after = await Bun.file(mainPath).text();

	return {
		changed: after !== before || assets.length > 0,
		appearance: readAppearance(after),
		manual,
		assets,
		restart: carLooks.some((look) => change[look] !== undefined),
	};
}
