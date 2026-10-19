import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError } from '../../utils/errors.ts';
import { dartStringValue } from './appearance.ts';
import { dartString } from './create.ts';
import { formatDart, writeDart } from './dart-file.ts';
import {
	addImportLine,
	appendElement,
	argumentValue,
	callsAt,
	closingBracket,
	codeOnly,
	declarationAround,
	keepOnlyCall,
	onlyMatch,
	removeArgument,
	removeElement,
	setArgument,
} from './main-dart.ts';

/**
 * The parts of a car's app the CLI makes for its owner: windows (each with its icon in the app
 * list), quick settings tiles and home screen widgets.
 *
 * Each is a file of its own in a folder of its kind, written so the owner only has to fill in
 * what it shows or does, and handed to `SmartifyOs().init` in `lib/main.dart`. The CLI reads them
 * back, renames them and changes their icon, by the shape it wrote them in: a file changed beyond
 * that is still listed, with what could not be read left out.
 */

export type PartKind = 'window' | 'tile' | 'widget';

/** The ways each kind can be made. */
export type PartVariant = 'fullscreen' | 'floating' | 'toggle' | 'button' | 'card' | 'pinned';

/** One of the icons a part can be made with, from Flutter's `Icons`. */
export interface PartIcon {
	/** Its name in `Icons`, `local_gas_station`. */
	id: string;
	label: string;
}

/**
 * The icons offered when making a part, the ones a car is likely to want. Any other icon from
 * Flutter's `Icons` can be written into the file by hand.
 */
export const partIcons: PartIcon[] = [
	{ id: 'directions_car', label: 'Car' },
	{ id: 'speed', label: 'Gauge' },
	{ id: 'local_gas_station', label: 'Fuel' },
	{ id: 'battery_full', label: 'Battery' },
	{ id: 'bolt', label: 'Power' },
	{ id: 'thermostat', label: 'Temperature' },
	{ id: 'water_drop', label: 'Fluid' },
	{ id: 'air', label: 'Fan' },
	{ id: 'ac_unit', label: 'Air conditioning' },
	{ id: 'event_seat', label: 'Seat' },
	{ id: 'lightbulb', label: 'Light' },
	{ id: 'lock', label: 'Lock' },
	{ id: 'door_front_door', label: 'Door' },
	{ id: 'videocam', label: 'Camera' },
	{ id: 'map', label: 'Map' },
	{ id: 'route', label: 'Trip' },
	{ id: 'music_note', label: 'Music' },
	{ id: 'volume_up', label: 'Sound' },
	{ id: 'timer', label: 'Timer' },
	{ id: 'build', label: 'Tools' },
	{ id: 'notifications', label: 'Alert' },
	{ id: 'info', label: 'Info' },
	{ id: 'settings', label: 'Settings' },
	{ id: 'dashboard', label: 'Dashboard' },
	{ id: 'star', label: 'Star' },
];

/** Everything that differs between the kinds. */
interface KindSpec {
	/** Said to the owner: `window`, `quick settings tile`. */
	noun: string;
	/** Where its files go, inside `lib`. */
	folder: string;
	variants: PartVariant[];
	icon: string;
	/** The ids SmartifyOS's own parts of this kind have, which a new one must not take. */
	builtIn: string[];
	register: RegisterSpec;
}

/**
 * Where something the CLI makes is handed to SmartifyOS:
 * `SmartifyOs().init(appList: AppListConfig(entries: [...]))`.
 */
export interface RegisterSpec {
	/** The argument of `SmartifyOs().init`: `appList`. */
	argument: string;
	config: string;
	/** The list argument of the config: `entries`. */
	list: string;
	/** The import the config needs. */
	import: string;
	/** Said above the config when it is added. */
	comment: string;
}

export const kinds: Record<PartKind, KindSpec> = {
	window: {
		noun: 'window',
		folder: 'windows',
		variants: ['fullscreen', 'floating'],
		icon: 'dashboard',
		builtIn: ['settings', 'home_widgets', 'reverse_camera'],
		register: {
			argument: 'appList',
			config: 'AppListConfig',
			list: 'entries',
			import: "import 'package:smartify_os_core/app_list.dart';",
			comment: 'Your own windows, each with its icon in the app list.',
		},
	},
	tile: {
		noun: 'quick settings tile',
		folder: 'quick_settings',
		variants: ['toggle', 'button'],
		icon: 'bolt',
		builtIn: ['do_not_disturb', 'bluetooth'],
		register: {
			argument: 'quickSettings',
			config: 'QuickSettingsConfig',
			list: 'tiles',
			import: "import 'package:smartify_os_core/quick_settings.dart';",
			comment: 'Your own tiles in the quick settings, the shade pulled down from the top.',
		},
	},
	widget: {
		noun: 'home screen widget',
		folder: 'home_widgets',
		variants: ['card', 'pinned'],
		icon: 'info',
		builtIn: [
			'bluetooth_player',
			'quick_settings',
			'clock',
			'info_display',
			'car',
			'reverse_camera',
		],
		register: {
			argument: 'homeWidgets',
			config: 'HomeWidgetsConfig',
			list: 'widgets',
			import: "import 'package:smartify_os_core/home_widgets.dart';",
			comment: 'Your own widgets and cards on the home screen.',
		},
	},
};

/** Every spelling of a part's name. */
export interface PartNames {
	/** As the driver reads it: `Trip computer`. */
	name: string;
	/** Its id and the start of its file's name: `trip_computer`. */
	snake: string;
	/** `TripComputer`. */
	pascal: string;
	/** `tripComputer`. */
	camel: string;
}

/**
 * Every spelling of a part's name, from the name the driver reads.
 *
 * @throws {CliError} when it cannot be a name, saying why.
 */
export function partNames(input: string): PartNames {
	const name = input.trim().replace(/\s+/g, ' ');
	if (!name || name.length > 40 || /[\\$]/.test(name)) {
		throw new CliError(`"${input}" cannot be the name of one.`, {
			hint: 'Keep it short and leave out $ and backslashes, like "Trip computer".',
		});
	}
	const snake = name
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		// "Driver's seat" is drivers_seat.
		.replace(/['\u2019]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
	if (!/^[a-z]/.test(snake)) {
		throw new CliError(`"${name}" has to start with a letter from A to Z.`, {
			hint: 'It also names a file and a class in your app, like "Trip computer".',
		});
	}
	const words = snake.split('_');
	const pascal = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
	return { name, snake, pascal, camel: pascal.charAt(0).toLowerCase() + pascal.slice(1) };
}

/** What the CLI knows about one part in a car's app. */
export interface Part {
	kind: PartKind;
	/** Its id, unique among its kind: `trip_computer`. */
	id: string | null;
	/** What the driver reads, null when it is not written as plain text. */
	name: string | null;
	variant: PartVariant | null;
	/** Its name in Flutter's `Icons`, null when it is anything else. */
	icon: string | null;
	/** Its file, relative to the app: `lib/windows/trip_computer_window.dart`. */
	file: string;
	/** What `lib/main.dart` hands to SmartifyOS: `TripComputerWindow.appListEntry`. */
	symbol: string | null;
	/**
	 * Whether the app hands it to SmartifyOS: `lib/main.dart` does, or another file of the app uses
	 * it (an app list of the owner's own, say).
	 */
	registered: boolean;
	/**
	 * What of it the CLI can change: all of it for one in a file of its own, the way the CLI makes
	 * them, and nothing for one written some other way (several in a list, say), which is listed
	 * but left to its owner.
	 */
	canChange: { name: boolean; icon: boolean; order: boolean; appList: boolean; remove: boolean };
	/** Where it sits among the others of its kind, smaller first. Null when not written, SmartifyOS's 100. */
	order: number | null;
	/** A window: whether its icon is in the app list. Null for the other kinds. */
	inAppList: boolean | null;
	/** Where its name and icon are written, another file for a window in an app list of the owner's own. */
	nameAt: { file: string; line: number };
	/** The line where what it shows or does is written, to start there. */
	line: number;
}

/** Internal: where a part's file goes and what it is called in Dart. */
function shape(kind: PartKind, names: PartNames): { file: string; symbol: string } {
	const folder = `lib/${kinds[kind].folder}`;
	switch (kind) {
		case 'window':
			return {
				file: `${folder}/${names.snake}_window.dart`,
				symbol: `${names.pascal}Window.appListEntry`,
			};
		case 'tile':
			return { file: `${folder}/${names.snake}_tile.dart`, symbol: `${names.camel}Tile` };
		case 'widget':
			return { file: `${folder}/${names.snake}_widget.dart`, symbol: `${names.camel}Widget` };
	}
}

/** Internal: the first line containing `marker`, counted from 1, or 1. */
function lineOf(source: string, marker: RegExp): number {
	const at = source.search(marker);
	return at === -1 ? 1 : source.slice(0, at).split('\n').length;
}

/** Where to start writing in each kind's file: the placeholder the owner replaces. */
const starts: Record<PartKind, RegExp> = {
	window: /child: /,
	tile: /debugPrint\(/,
	widget: /children: \[/,
};

/** A new part's file, ready to be filled in. */
export function partSource(
	kind: PartKind,
	variant: PartVariant,
	names: PartNames,
	icon: string,
): string {
	const { file } = shape(kind, names);
	const name = dartString(names.name);
	const iconCode = iconSource(kind, icon);

	if (kind === 'window') {
		const floating = variant === 'floating';
		const window = floating
			? `SmartifyOsFloatingWindow(
      title: title,
      widthFactor: 0.6,
      heightFactor: 0.6,
      child: Center(child: Text('Change what it shows in ${file}')),
    )`
			: `SmartifyOsWindow(
      title: title,
      child: Center(child: Text('Change what it shows in ${file}')),
    )`;
		return `import 'package:flutter/material.dart';
import 'package:smartify_os_core/app_list.dart';
import 'package:smartify_os_core/navigator.dart';
import 'package:smartify_os_core/widgets.dart';

/// A window of your own${floating ? ', floating over the home screen' : ''}.
/// It opens from its icon in the app list, the grid button in the bar.
///
/// What it shows is up to you: change what [build] returns below. Its name
/// and icon can be changed in the SmartifyOS editor too.
class ${names.pascal}Window extends StatelessWidget {
  const ${names.pascal}Window({super.key});

  /// What it is called, at the top of the window and under its icon.
  static const title = ${name};

  /// Its icon in the app list. lib/main.dart hands it to SmartifyOS.
  static final appListEntry = AppListEntry(
    id: '${names.snake}',
    title: title,
    icon: ${iconCode},
    onOpen: (context) =>
        SmartifyOsNavigator.push(context, const ${names.pascal}Window()),
  );

  @override
  Widget build(BuildContext context) {
    return const ${window};
  }
}
`;
	}

	if (kind === 'tile') {
		const toggle = variant === 'toggle';
		return `import 'package:flutter/material.dart';
import 'package:smartify_os_core/quick_settings.dart';

/// A tile of your own in the quick settings, the shade pulled down from the
/// top of the screen. ${toggle ? 'It switches something on and off.' : 'It does the same thing every time it is tapped.'}
///
/// What it does is up to you: write it in [${toggle ? '_switched' : '_tapped'}] below. Its name and
/// icon can be changed in the SmartifyOS editor too.
const ${names.camel}Tile = QuickSettingsTile.${toggle ? 'toggle' : 'button'}(
  id: '${names.snake}',
  label: ${name},
  icon: ${iconCode},
  ${toggle ? 'onChanged: _switched' : 'onTap: _tapped'},
);

${
	toggle
		? `/// Runs every time the tile is switched, with whether it is on now. The tile
/// remembers its position by itself.
void _switched(QuickSettingsContext qs, bool on) {
  // For example, ask a device on the CAN bus to do it:
  // SmartifyOsCan.sendMessage(Lights.interior, {Lights.on: on});
  debugPrint('${names.name.replace(/'/g, "\\'")} is \${on ? 'on' : 'off'}');
}`
		: `/// Runs every time the tile is tapped.
void _tapped(QuickSettingsContext qs) {
  // For example, ask a device on the CAN bus to do it:
  // SmartifyOsCan.sendMessage(Trunk.open, {});
  debugPrint('${names.name.replace(/'/g, "\\'")} was tapped');
}`
}
`;
	}

	const pinned = variant === 'pinned';
	return `import 'package:flutter/material.dart';
import 'package:smartify_os_core/home_widgets.dart';
import 'package:smartify_os_core/theme.dart';

/// ${
		pinned
			? `A widget of your own on the home screen, which stays where it is put.
/// The driver adds it by holding an area of the home screen, and a layout of
/// your own can put it in one of its areas.`
			: `A card of your own on the home screen. It shows up by itself where the
/// layout puts cards, and the driver can swipe it away.`
	}
///
/// What it shows is up to you: change [_${names.pascal}View] below. Its name and
/// icon can be changed in the SmartifyOS editor too.
final ${names.camel}Widget = HomeWidget${pinned ? '.pinned' : ''}(
  id: '${names.snake}',
  title: ${name},
  icon: ${iconCode},
  builder: (home) => const _${names.pascal}View(),
);

/// What it shows, in whatever box the layout gives it.
class _${names.pascal}View extends StatelessWidget {
  const _${names.pascal}View();

  @override
  Widget build(BuildContext context) {
    final text = context.smartifyOsText;
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(${name}, style: text.title),
        Text(
          'Change what it shows in ${file}',
          style: text.dim(text.small),
        ),
      ],
    );
  }
}
`;
}

/** Internal: an icon as the file holds it. A tile is const as a whole, so its icon needs no const of its own. */
function iconSource(kind: PartKind, icon: string): string {
	return kind === 'tile' ? `Icon(Icons.${icon})` : `const Icon(Icons.${icon})`;
}

/** Internal: the calls a part's name, id and icon are arguments of, by kind. */
const calls: Record<PartKind, RegExp> = {
	window: /\bAppListEntry\s*\(/,
	tile: /\bQuickSettingsTile\s*\.\s*(?:toggle|button)\s*\(/,
	widget: /\bHomeWidget(?:\s*\.\s*pinned)?\s*\(/,
};

/** Internal: the argument of each kind's call that holds what the driver reads. */
const nameArguments: Record<PartKind, string> = { window: 'title', tile: 'label', widget: 'title' };

/** Internal: `Icon(Icons.x)` as `x`, null when it is anything else. */
function iconName(code: string | null | undefined): string | null {
	return /^(?:const\s+)?Icon\(\s*Icons\.([a-z0-9_]+)\s*\)$/.exec(code?.trim() ?? '')?.[1] ?? null;
}

/**
 * Internal: a string argument as the driver reads it, also when it is written as a constant of
 * the app's own (`id: counterWidgetId`, with `const counterWidgetId = 'counter';` in `code`).
 */
export function stringValue(argument: string | null | undefined, code: string): string | null {
	const value = argument?.trim() ?? '';
	if (!/^[A-Za-z_]\w*$/.test(value)) return dartStringValue(value) ?? null;
	const constant = new RegExp(
		`\\bconst\\s+(?:String\\s+)?${value}\\s*=\\s*(r?'[^'\\n]*'|r?"[^"\\n]*")\\s*;`,
	).exec(code)?.[1];
	return constant ? (dartStringValue(constant) ?? null) : null;
}

/** Internal: an `order:` argument as a number, null when there is none or it is not a plain one. */
function orderValue(argument: string | null | undefined): number | null {
	const value = argument?.trim() ?? '';
	return /^-?\d+$/.test(value) ? Number(value) : null;
}

/**
 * An order as given on the command line or by the editor: a whole number, or empty for none,
 * which is SmartifyOS's own 100.
 *
 * @throws {CliError} when it is neither.
 */
export function parseOrder(input: string): number | null {
	const value = input.trim();
	if (value === '') return null;
	if (/^-?\d+$/.test(value)) return Number(value);
	throw new CliError(`"${input}" is not an order.`, {
		hint: 'Use a whole number, smaller comes first, or "" for the usual place.',
	});
}

/** Internal: whether the rest of the app names `symbol` itself, `TripComputerWindow.appListEntry`. */
function mentions(rest: string, symbol: string | null): boolean {
	return (
		symbol !== null &&
		new RegExp(`\\b${symbol.replace('.', '\\s*\\.\\s*')}\\b`).test(codeOnly(rest))
	);
}

/** Internal: the line `index` is on, counted from 1. */
function lineAt(source: string, index: number): number {
	return source.slice(0, index).split('\n').length;
}

/** Internal: the call of its kind a part's id, name and icon are read from. */
interface Entry {
	file: string;
	/** The file's source with every other call of the kind blanked out. */
	source: string;
	/** Where the call starts, undefined when there is none. */
	at: number | undefined;
}

/** Internal: an `AppListEntry` anywhere in the app that opens the window `className`. */
function appListEntryOf(sources: Map<string, string>, className: string): Entry | undefined {
	const opens = new RegExp(`\\b${className}\\b`);
	for (const [file, source] of sources) {
		const code = codeOnly(source);
		for (const at of callsAt(code, calls.window)) {
			const close = closingBracket(code, code.indexOf('(', at));
			if (opens.test(code.slice(at, close))) {
				return { file, source: keepOnlyCall(source, calls.window, at), at };
			}
		}
	}
	return undefined;
}

/**
 * Reads a part back from its file of its own, with `rest` the code of the app besides it (see
 * {@link besides}) and `sources` all of the app, for a window whose icon in the app list is
 * written somewhere else.
 */
export function readPart(
	kind: PartKind,
	file: string,
	source: string,
	rest: string,
	sources?: Map<string, string>,
): Part {
	const code = codeOnly(source);
	const call = calls[kind];

	let variant: PartVariant | null;
	let symbol: string | null;
	let className: string | undefined;
	if (kind === 'window') {
		className = /\bclass\s+([A-Za-z_]\w*)\s+extends\b/.exec(code)?.[1];
		variant = code.includes('SmartifyOsFloatingWindow(') ? 'floating' : 'fullscreen';
		symbol = className ? `${className}.appListEntry` : null;
	} else if (kind === 'tile') {
		const found =
			/\b(?:final|const)\s+([A-Za-z_]\w*)\s*=\s*QuickSettingsTile\s*\.\s*(toggle|button)\b/.exec(
				code,
			);
		variant = (found?.[2] as PartVariant | undefined) ?? null;
		symbol = found?.[1] ?? null;
	} else {
		const found = /\b(?:final|const)\s+([A-Za-z_]\w*)\s*=\s*HomeWidget(\s*\.\s*pinned)?\s*\(/.exec(
			code,
		);
		variant = found ? (found[2] ? 'pinned' : 'card') : null;
		symbol = found?.[1] ?? null;
	}

	// The CLI writes a window's icon in the app list into its own file, but an owner may have
	// written it anywhere else, an app list of their own say.
	const own = onlyMatch(code, call);
	const entry: Entry = (!own && className && sources && appListEntryOf(sources, className)) || {
		file,
		source,
		at: own?.index,
	};
	const title =
		kind === 'window'
			? /\bstatic\s+const\s+(?:String\s+)?title\s*=\s*(r?['"][^\n]*['"])\s*;/.exec(source)?.[1]
			: undefined;
	const app = `${entry.source}\n${rest}`;
	const name = title
		? (dartStringValue(title) ?? null)
		: stringValue(argumentValue(entry.source, call, nameArguments[kind]), app);
	const line = lineOf(source, starts[kind]);

	return {
		kind,
		id: stringValue(argumentValue(entry.source, call, 'id'), app),
		name,
		variant,
		icon: iconName(argumentValue(entry.source, call, 'icon')),
		file,
		symbol,
		registered: usedIn(rest, symbol),
		canChange: {
			// Where editPart changes them.
			name: kind === 'window' ? title !== undefined : own !== undefined,
			icon: own !== undefined,
			order: own !== undefined,
			appList: kind === 'window' && own !== undefined,
			// Only when nothing but lib/main.dart uses it, which removePart takes it out of.
			remove: !sources || !usedIn(besides(sources, file, 'lib/main.dart'), symbol),
		},
		order: orderValue(argumentValue(entry.source, call, 'order')),
		// One written in an app list of the owner's own is in it.
		inAppList: kind === 'window' ? !own || mentions(rest, symbol) : null,
		nameAt: {
			file: entry.file,
			line: entry.at === undefined ? line : lineAt(entry.source, entry.at),
		},
		line,
	};
}

/**
 * Reads a part written some other way than the CLI writes them: the call at `at` in `file`, one
 * of several there or in a list of the owner's own. It is listed but left to its owner, so the
 * CLI changes nothing of it.
 */
export function readCall(
	kind: PartKind,
	file: string,
	source: string,
	at: number,
	rest: string,
): Part {
	const call = calls[kind];
	const kept = keepOnlyCall(source, call, at);
	const code = codeOnly(source);
	const opening = code.slice(at, code.indexOf('(', at));
	const variant: PartVariant | null =
		kind === 'tile'
			? ((/\b(toggle|button)\b/.exec(opening)?.[1] as PartVariant | undefined) ?? null)
			: kind === 'widget'
				? opening.includes('pinned')
					? 'pinned'
					: 'card'
				: null;
	// What is handed to SmartifyOS: the list it is in, `miataTiles`.
	const symbol = declarationAround(code, at);
	const line = lineAt(source, at);
	return {
		kind,
		id: stringValue(argumentValue(kept, call, 'id'), `${source}\n${rest}`),
		name: stringValue(argumentValue(kept, call, nameArguments[kind]), `${source}\n${rest}`),
		variant,
		icon: iconName(argumentValue(kept, call, 'icon')),
		file,
		symbol,
		// Not in a declaration, it is likely handed over right where it is written.
		registered: symbol === null || file === 'lib/main.dart' || usedIn(rest, symbol),
		canChange: { name: false, icon: false, order: false, appList: false, remove: false },
		order: orderValue(argumentValue(kept, call, 'order')),
		inAppList: kind === 'window' ? true : null,
		nameAt: { file, line },
		line,
	};
}

/**
 * Every part of a kind in the app: first the ones in files of their own in its folder, the way the
 * CLI makes them, then any written some other way anywhere in `lib/`.
 */
export async function listParts(appDir: string, kind: PartKind): Promise<Part[]> {
	const sources = await appSources(appDir);
	const folder = `lib/${kinds[kind].folder}/`;
	const call = calls[kind];
	const files = [...sources.keys()].sort();
	const parts: Part[] = [];
	// The calls those have read already, a window's icon in an app list elsewhere say.
	const read = new Set<string>();
	for (const file of files) {
		if (!file.startsWith(folder) || file.slice(folder.length).includes('/')) continue;
		const source = sources.get(file) ?? '';
		// A file with several tiles or widgets is not one the CLI made, those are read below.
		if (kind !== 'window' && callsAt(codeOnly(source), call).length > 1) continue;
		const part = readPart(kind, file, source, besides(sources, file), sources);
		// Something else that lives in the folder, not one of these.
		if (!part.symbol) continue;
		parts.push(part);
		read.add(`${part.nameAt.file}:${part.nameAt.line}`);
	}
	for (const file of files) {
		const source = sources.get(file) ?? '';
		for (const at of callsAt(codeOnly(source), call)) {
			if (read.has(`${file}:${lineAt(source, at)}`)) continue;
			parts.push(readCall(kind, file, source, at, besides(sources, file)));
		}
	}
	return parts;
}

/** The part of a kind with this id, file name or name, for the commands that take one. */
export function findPart(parts: Part[], query: string): Part | undefined {
	const wanted = query.trim().toLowerCase();
	return parts.find(
		(part) =>
			part.id === wanted ||
			part.name?.toLowerCase() === wanted ||
			part.file.toLowerCase().endsWith(`/${wanted}`) ||
			part.file.toLowerCase().endsWith(`/${wanted}.dart`),
	);
}

async function mainSource(appDir: string): Promise<string> {
	const file = Bun.file(join(appDir, 'lib', 'main.dart'));
	return (await file.exists()) ? await file.text() : '';
}

/** Every Dart file in the app's `lib/`, by its path relative to the app: `lib/app_list.dart`. */
export async function appSources(appDir: string): Promise<Map<string, string>> {
	const sources = new Map<string, string>();
	for await (const path of new Bun.Glob('lib/**/*.dart').scan({ cwd: appDir })) {
		sources.set(path.replaceAll('\\', '/'), await Bun.file(join(appDir, path)).text());
	}
	return sources;
}

/** The code of the app besides some of its files, for {@link usedIn}. */
export function besides(sources: Map<string, string>, ...files: string[]): string {
	return [...sources]
		.filter(([path]) => !files.includes(path))
		.map(([, source]) => source)
		.join('\n');
}

/**
 * Whether the rest of the app hands something to SmartifyOS. `lib/main.dart` does that for what
 * the CLI makes (`TripComputerWindow.appListEntry`), but an owner may do it any other way, like
 * an `AppListEntry` of their own in another file that opens the window, so anything using its
 * name counts: a warning that is wrong is worse than one left out.
 */
export function usedIn(rest: string, symbol: string | null): boolean {
	const name = symbol?.split('.')[0];
	return name !== undefined && new RegExp(`\\b${name}\\b`).test(codeOnly(rest));
}

/** The app's package name, which its own imports start with. */
export async function packageName(appDir: string): Promise<string> {
	const pubspec = await Bun.file(join(appDir, 'pubspec.yaml')).text();
	const name = /^name:\s*([A-Za-z_][\w]*)/m.exec(pubspec)?.[1];
	if (!name) throw new CliError("Your car's app has no name in its pubspec.yaml.");
	return name;
}

const initCall = /\bSmartifyOs\s*\(\s*\)\s*\.\s*init\s*\(/;

/**
 * Internal: puts `element` into the list a kind's parts are handed to SmartifyOS in, adding the
 * config when it is not there. Undefined when there is no clear place for it.
 */
export function register(source: string, kind: PartKind, element: string): string | undefined {
	return registerIn(source, kinds[kind].register, element);
}

/**
 * Puts `element` into the list `spec` names, adding the config when it is not there.
 * Undefined when there is no clear place for it.
 */
export function registerIn(
	source: string,
	spec: RegisterSpec,
	element: string,
): string | undefined {
	const { config, list, argument, comment } = spec;
	const configCall = new RegExp(`\\b${config}\\s*\\(`);
	const code = codeOnly(source);
	const match = onlyMatch(code, configCall);

	let edited: string | undefined;
	if (!match) {
		// No config yet: only when nothing else is handed over under its name.
		if (argumentValue(source, initCall, argument) !== null) return undefined;
		edited = setArgument(source, initCall, argument, `${config}(${list}: [${element}])`, {
			before: 'extensions',
			comment: [comment],
		});
	} else {
		const open = match.index + match[0].length - 1;
		const close = closingBracket(code, open);
		const inside = code.slice(open, close);
		const listMatch = new RegExp(`\\b${list}\\s*:\\s*(const\\s+)?\\[`).exec(inside);
		const value = argumentValue(source, configCall, list);
		if (listMatch) {
			edited = appendElement(
				source,
				code,
				open + listMatch.index + listMatch[0].length - 1,
				element,
			);
		} else if (value === null) {
			edited = setArgument(source, configCall, list, `[${element}]`);
		} else {
			// The list is a variable or something else to add to by hand.
			return undefined;
		}
	}
	if (edited === undefined) return undefined;
	// What goes in is never const, so the list and the config around it cannot be.
	return edited
		.replace(new RegExp(`\\bconst\\s+(${config}\\s*\\()`), '$1')
		.replace(new RegExp(`(\\b${list}\\s*:\\s*)const\\s+\\[`), '$1[');
}

/** Internal: takes `symbol` out of the list its kind is handed to SmartifyOS in. */
export function unregister(source: string, kind: PartKind, symbol: string): string {
	return unregisterIn(source, kinds[kind].register, symbol);
}

/** Takes `symbol` out of the list `spec` names. */
export function unregisterIn(source: string, spec: RegisterSpec, symbol: string): string {
	const { config, list } = spec;
	const code = codeOnly(source);
	const match = onlyMatch(code, new RegExp(`\\b${config}\\s*\\(`));
	if (!match) return source;
	const open = match.index + match[0].length - 1;
	const inside = code.slice(open, closingBracket(code, open));
	const listMatch = new RegExp(`\\b${list}\\s*:\\s*(const\\s+)?\\[`).exec(inside);
	if (!listMatch) return source;
	const pattern = new RegExp(`^${symbol.replace('.', '\\s*\\.\\s*')}$`);
	return removeElement(source, code, open + listMatch.index + listMatch[0].length - 1, (text) =>
		pattern.test(text.trim()),
	);
}

/** What making a part did. */
export interface PartCreated {
	part: Part;
	/** The line to add to `lib/main.dart` by hand, when there was no clear place for it. */
	manual: string | null;
}

/**
 * Makes a part: its file, ready to be filled in, handed to SmartifyOS in `lib/main.dart`.
 *
 * @throws {CliError} when there is one with its name already, or its id is SmartifyOS's own.
 */
export async function createPart(
	appDir: string,
	kind: PartKind,
	variant: PartVariant,
	names: PartNames,
	icon: string,
): Promise<PartCreated> {
	const spec = kinds[kind];
	if (spec.builtIn.includes(names.snake)) {
		throw new CliError(`SmartifyOS has a ${spec.noun} called ${names.name} already.`, {
			hint: 'Give yours another name.',
		});
	}
	const { file, symbol } = shape(kind, names);
	const existing = (await listParts(appDir, kind)).find((part) => part.id === names.snake);
	if (existsSync(join(appDir, file)) || existing) {
		throw new CliError(`Your car's app has a ${spec.noun} called ${names.name} already.`, {
			hint: `It is in ${existing?.file ?? file}. Give the new one another name.`,
		});
	}

	await Bun.write(join(appDir, file), partSource(kind, variant, names, icon));
	await formatDart([join(appDir, file)]);

	const manual = await handOver(appDir, kind, file, symbol);
	const sources = await appSources(appDir);
	const source = sources.get(file) ?? '';
	return { part: readPart(kind, file, source, besides(sources, file), sources), manual };
}

/**
 * Internal: hands `symbol` to SmartifyOS in `lib/main.dart`, with the import of its file.
 * Resolves with what to add by hand instead, when there is no clear place for it.
 */
async function handOver(
	appDir: string,
	kind: PartKind,
	file: string,
	symbol: string,
): Promise<string | null> {
	const spec = kinds[kind].register;
	const before = await mainSource(appDir);
	const importLine = `import 'package:${await packageName(appDir)}/${file.slice('lib/'.length)}';`;
	const registered = register(before, kind, symbol);
	if (registered === undefined) {
		return `${symbol} in ${spec.list}: of ${spec.config}(...), and ${importLine}`;
	}
	await writeDart(
		join(appDir, 'lib', 'main.dart'),
		before,
		addImportLine(addImportLine(registered, spec.import), importLine),
	);
	return null;
}

/**
 * Internal: takes `symbol` out of `lib/main.dart`, and the import of its file once nothing
 * there uses what it has.
 */
async function takeBack(
	appDir: string,
	kind: PartKind,
	file: string,
	symbol: string | null,
): Promise<void> {
	const before = await mainSource(appDir);
	let source = symbol ? unregister(before, kind, symbol) : before;
	const name = symbol?.split('.')[0];
	if (!name || !new RegExp(`\\b${name}\\b`).test(codeOnly(source))) {
		const importLine = new RegExp(
			`^[ \\t]*import\\s+['"]package:[^/'"]+/${file.slice('lib/'.length).replace(/[.]/g, '\\.')}['"];[ \\t]*\\r?\\n`,
			'm',
		);
		source = source.replace(importLine, '');
	}
	await writeDart(join(appDir, 'lib', 'main.dart'), before, source);
}

/** What can be changed of a part. Undefined is "leave it", a null order takes it off. */
export interface PartChange {
	name?: string;
	icon?: string;
	order?: number | null;
	/** A window: whether its icon is in the app list. */
	appList?: boolean;
}

/**
 * Renames a part, gives it another icon or order, in its file, or puts a window into the app
 * list or takes it out, in `lib/main.dart`.
 */
export async function editPart(appDir: string, part: Part, change: PartChange): Promise<Part> {
	for (const what of ['name', 'icon', 'order', 'appList'] as const) {
		if (change[what] !== undefined && !part.canChange[what]) {
			throw cannotEdit(part, what === 'appList' ? 'place in the app list' : what);
		}
	}
	const path = join(appDir, part.file);
	const before = await Bun.file(path).text();
	let source = before;
	const call = calls[part.kind];

	if (change.name !== undefined) {
		const name = dartString(partNames(change.name).name);
		if (part.kind === 'window') {
			const title = /(\bstatic\s+const\s+(?:String\s+)?title\s*=\s*)r?['"][^\n]*['"](\s*;)/;
			if (!title.test(source)) throw cannotEdit(part, 'name');
			source = source.replace(title, `$1${name}$2`);
		} else {
			const edited = setArgument(source, call, part.kind === 'tile' ? 'label' : 'title', name);
			if (edited === undefined) throw cannotEdit(part, 'name');
			source = edited;
		}
	}
	if (change.icon !== undefined) {
		const edited = setArgument(source, call, 'icon', iconSource(part.kind, change.icon));
		if (edited === undefined) throw cannotEdit(part, 'icon');
		source = edited;
	}
	if (change.order === null) {
		source = removeArgument(source, call, 'order') ?? source;
	} else if (change.order !== undefined) {
		const edited = setArgument(source, call, 'order', String(change.order));
		if (edited === undefined) throw cannotEdit(part, 'order');
		source = edited;
	}

	await writeDart(path, before, source);
	if (change.appList !== undefined && change.appList !== part.inAppList && part.symbol) {
		if (!change.appList) await takeBack(appDir, part.kind, part.file, part.symbol);
		else {
			const manual = await handOver(appDir, part.kind, part.file, part.symbol);
			if (manual) {
				throw new CliError('There is no clear place for it in lib/main.dart.', {
					hint: `Add ${manual}`,
				});
			}
		}
	}
	const sources = await appSources(appDir);
	const written = sources.get(part.file) ?? source;
	return readPart(part.kind, part.file, written, besides(sources, part.file), sources);
}

function cannotEdit(part: Part, what: string): CliError {
	return new CliError(`The ${what} of ${part.name ?? part.file} is not where it can be changed.`, {
		hint: `Change it by hand in ${part.nameAt.file}, line ${part.nameAt.line}.`,
	});
}

/** Takes a part out of the app: out of `lib/main.dart`, and its file. */
export async function removePart(appDir: string, part: Part): Promise<void> {
	if (!part.canChange.remove) {
		throw new CliError(`${part.name ?? part.file} cannot be taken out by itself.`, {
			hint: `More of your app than lib/main.dart uses it, take it out by hand starting in ${part.file}.`,
		});
	}
	await takeBack(appDir, part.kind, part.file, part.symbol);
	await rm(join(appDir, part.file), { force: true });
}
