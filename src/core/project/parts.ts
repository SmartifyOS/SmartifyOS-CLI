import { existsSync, readdirSync } from 'node:fs';
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
	closingBracket,
	codeOnly,
	onlyMatch,
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
	/** Where it is handed to SmartifyOS: `SmartifyOs().init(appList: AppListConfig(entries: [...]))`. */
	register: { argument: string; config: string; list: string; import: string; comment: string };
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
	/** Whether `lib/main.dart` hands it to SmartifyOS. */
	registered: boolean;
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

/** Reads a part back from its file. */
export function readPart(kind: PartKind, file: string, source: string, main: string): Part {
	const code = codeOnly(source);
	const call = calls[kind];
	const id = dartStringValue(argumentValue(source, call, 'id') ?? '') ?? null;
	const iconCode = argumentValue(source, call, 'icon') ?? '';
	const icon = /^(?:const\s+)?Icon\(\s*Icons\.([a-z0-9_]+)\s*\)$/.exec(iconCode)?.[1] ?? null;

	let name: string | null;
	let variant: PartVariant | null;
	let symbol: string | null;
	if (kind === 'window') {
		const className = /\bclass\s+([A-Za-z_]\w*)\s+extends\b/.exec(code)?.[1];
		const title = /\bstatic\s+const\s+(?:String\s+)?title\s*=\s*(r?['"][^\n]*['"])\s*;/.exec(
			source,
		)?.[1];
		name = title ? (dartStringValue(title) ?? null) : null;
		variant = code.includes('SmartifyOsFloatingWindow(') ? 'floating' : 'fullscreen';
		symbol = className ? `${className}.appListEntry` : null;
	} else if (kind === 'tile') {
		const found =
			/\b(?:final|const)\s+([A-Za-z_]\w*)\s*=\s*QuickSettingsTile\s*\.\s*(toggle|button)\b/.exec(
				code,
			);
		name = dartStringValue(argumentValue(source, call, 'label') ?? '') ?? null;
		variant = (found?.[2] as PartVariant | undefined) ?? null;
		symbol = found?.[1] ?? null;
	} else {
		const found = /\b(?:final|const)\s+([A-Za-z_]\w*)\s*=\s*HomeWidget(\s*\.\s*pinned)?\s*\(/.exec(
			code,
		);
		name = dartStringValue(argumentValue(source, call, 'title') ?? '') ?? null;
		variant = found ? (found[2] ? 'pinned' : 'card') : null;
		symbol = found?.[1] ?? null;
	}

	const registered =
		symbol !== null &&
		new RegExp(`\\b${symbol.replace('.', '\\s*\\.\\s*')}\\b`).test(codeOnly(main));
	return {
		kind,
		id,
		name,
		variant,
		icon,
		file,
		symbol,
		registered,
		line: lineOf(source, starts[kind]),
	};
}

/** Every part of a kind in the app, in its folder, in order of file name. */
export async function listParts(appDir: string, kind: PartKind): Promise<Part[]> {
	const folder = join(appDir, 'lib', kinds[kind].folder);
	if (!existsSync(folder)) return [];
	const main = await mainSource(appDir);
	const files = readdirSync(folder)
		.filter((name) => name.endsWith('.dart'))
		.sort();
	const parts: Part[] = [];
	for (const name of files) {
		const file = `lib/${kinds[kind].folder}/${name}`;
		const part = readPart(kind, file, await Bun.file(join(appDir, file)).text(), main);
		// Something else that lives in the folder, not one of these.
		if (part.symbol) parts.push(part);
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

/** Internal: the app's package name, which its own imports start with. */
async function packageName(appDir: string): Promise<string> {
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
	const { config, list, argument, comment } = kinds[kind].register;
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
	// A window or a widget is never const, so the list and the config around it cannot be.
	return edited
		.replace(new RegExp(`\\bconst\\s+(${config}\\s*\\()`), '$1')
		.replace(new RegExp(`(\\b${list}\\s*:\\s*)const\\s+\\[`), '$1[');
}

/** Internal: takes `symbol` out of the list its kind is handed to SmartifyOS in. */
export function unregister(source: string, kind: PartKind, symbol: string): string {
	const { config, list } = kinds[kind].register;
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

	const mainPath = join(appDir, 'lib', 'main.dart');
	const before = await mainSource(appDir);
	const importLine = `import 'package:${await packageName(appDir)}/${file.slice('lib/'.length)}';`;
	const registered = register(before, kind, symbol);
	let manual: string | null = null;
	if (registered === undefined) {
		const { config, list } = spec.register;
		manual = `${symbol} in ${list}: of ${config}(...), and ${importLine}`;
	} else {
		await writeDart(
			mainPath,
			before,
			addImportLine(addImportLine(registered, spec.register.import), importLine),
		);
	}

	const source = await Bun.file(join(appDir, file)).text();
	return { part: readPart(kind, file, source, await mainSource(appDir)), manual };
}

/** Renames a part or gives it another icon, in its file. Undefined is "leave it". */
export async function editPart(
	appDir: string,
	part: Part,
	change: { name?: string; icon?: string },
): Promise<Part> {
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

	await writeDart(path, before, source);
	return readPart(part.kind, part.file, await Bun.file(path).text(), await mainSource(appDir));
}

function cannotEdit(part: Part, what: string): CliError {
	return new CliError(`The ${what} of ${part.name ?? part.file} is not where it can be changed.`, {
		hint: `Change it by hand in ${part.file}.`,
	});
}

/** Takes a part out of the app: out of `lib/main.dart`, and its file. */
export async function removePart(appDir: string, part: Part): Promise<void> {
	const mainPath = join(appDir, 'lib', 'main.dart');
	const before = await mainSource(appDir);
	let source = part.symbol ? unregister(before, part.kind, part.symbol) : before;
	const importLine = new RegExp(
		`^[ \\t]*import\\s+['"]package:[^/'"]+/${part.file.slice('lib/'.length).replace(/[.]/g, '\\.')}['"];[ \\t]*\\r?\\n`,
		'm',
	);
	source = source.replace(importLine, '');
	await writeDart(mainPath, before, source);
	await rm(join(appDir, part.file), { force: true });
}
