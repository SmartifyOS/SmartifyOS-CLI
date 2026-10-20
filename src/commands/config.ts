import {
	type ConfigChange,
	type ConfigElement,
	type ConfigReport,
	type ConfigValue,
	changeConfig,
	configFields,
	type Field,
	fieldFor,
	parseValue,
	readConfig,
} from '../core/project/config.ts';
import { carFiles, requireCar } from '../core/project/find.ts';
import { isJsonMode } from '../ui/json.ts';
import { intro, log, outro, writeLine } from '../ui/output.ts';
import { note } from '../ui/prompt.ts';
import { theme } from '../ui/theme.ts';
import { CliError } from '../utils/errors.ts';
import { binaryName } from './flags.ts';
import type { Command, Flags } from './types.ts';

/**
 * Reads and changes any setting of `SmartifyOs().init` that is plain data, by its key, like
 * `git config`. It is what the editor's setup pages are written with.
 */
export const configCommand: Command = {
	name: 'config',
	summary: 'Change any setting of your car in lib/main.dart',
	usage: '[key] [value]',
	description: `Reads and changes the settings your car's app hands SmartifyOS in lib/main.dart, each by its key: the path of names from SmartifyOs().init down to it, like car.model3D.scale. Anything not written there is SmartifyOS's own default. A setting written as code (a variable, say) is never guessed at: it is shown as code, and a change that would go inside it is printed for you to make by hand. Values are typed plainly: on or off, numbers, 3s or 500ms, #F5C542, 0,180,0, 1024x600, a,b,c, none for nothing, or JSON. How the screen looks and the About page have their own commands, appearance and about. Run it in your car's app folder.`,
	examples: [
		`${binaryName} config`,
		`${binaryName} config car.model3D.scale 0.8`,
		`${binaryName} config --set bluetooth.autoConnect=off --set gps.accuracy=high`,
		`${binaryName} config --unset car.model3D.scale`,
		`${binaryName} config --add layouts.hiddenLayouts=portrait`,
		`${binaryName} config --add 'infoDisplay.values={"id":"rpm","label":"Engine speed","unit":"RPM"}'`,
		`${binaryName} config --move 'infoDisplay.views[2]=0'`,
		`${binaryName} config --list`,
	],
	flags: {
		set: {
			type: 'string',
			multiple: true,
			describe: 'Change a setting, as key=value, again for more',
		},
		unset: {
			type: 'string',
			multiple: true,
			describe: "Take a setting out, so SmartifyOS's default is used, again for more",
		},
		add: {
			type: 'string',
			multiple: true,
			describe: 'Put something at the end of a list, as key=value, again for more',
		},
		remove: {
			type: 'string',
			multiple: true,
			describe: 'Take something out of a list, as key[2] by its place or key=name, again for more',
		},
		move: {
			type: 'string',
			multiple: true,
			describe: 'Move something in a list to another place, as key[2]=0, again for more',
		},
		list: { type: 'boolean', describe: 'Say every setting there is, and change nothing' },
	},
	async run({ flags, positionals }) {
		if (flags.list === true) {
			const fields = configFields();
			if (!isJsonMode()) listFields(fields);
			return { fields };
		}

		const app = await requireCar();
		const mainPath = carFiles(app).main;
		const changes = changesFrom(flags, positionals);

		if (changes.length === 0) {
			const current = readConfig(await Bun.file(mainPath).text());
			const [key] = positionals;
			if (!isJsonMode()) {
				if (key) showOne(current, key);
				else note(describe(current), 'How your car is set up');
			}
			return { changed: false, manual: [], fields: configFields(), ...current };
		}

		intro('Change how your car is set up');
		const result = await changeConfig(app.dir, changes);
		if (result.manual.length > 0) {
			log.warn(
				`Some of it has no clear place in ${theme.code('lib/main.dart')}, so make it there by hand:\n${result.manual.join('\n')}`,
			);
		}
		if (!result.changed)
			outro(`It was set up that way already ${theme.dim('(nothing was changed)')}`);
		else {
			outro(
				`Changed. If your car's app is running, press ${theme.code('R')} to restart it, since SmartifyOS reads these when it starts.`,
			);
		}
		return { ...result, fields: configFields() };
	},
};

/** Internal: `key=value` split at the first `=`. */
function pair(flag: string, given: string): [string, string] {
	const at = given.indexOf('=');
	if (at <= 0) {
		throw new CliError(`--${flag} ${given} needs a value.`, {
			hint: `Give it as --${flag} key=value.`,
		});
	}
	return [given.slice(0, at).trim(), given.slice(at + 1)];
}

function strings(value: Flags[string]): string[] {
	return (Array.isArray(value) ? value : [value]).filter(
		(item): item is string => typeof item === 'string',
	);
}

/** Internal: every change the flags and the words after the command ask for, checked. */
function changesFrom(flags: Flags, positionals: string[]): ConfigChange[] {
	const changes: ConfigChange[] = [];
	if (positionals.length > 2) {
		throw new CliError('Give one key and one value.', {
			hint: `Put a value with spaces in quotes, or use --set key=value for several.`,
		});
	}
	const set = (key: string, value: string) => {
		const { field } = fieldFor(key);
		changes.push({ op: 'set', key, value: parseValue(field, key, value) });
	};

	const [key, value] = positionals;
	if (key !== undefined && value !== undefined) set(key, value);
	for (const given of strings(flags.set)) set(...pair('set', given));
	for (const given of strings(flags.unset)) {
		fieldFor(given);
		changes.push({ op: 'unset', key: given.trim() });
	}
	for (const given of strings(flags.add)) {
		const [list, element] = pair('add', given);
		const { field } = fieldFor(list);
		if (field.type !== 'list' && field.type !== 'ids') {
			throw new CliError(`${list} is not a list.`, { hint: `Change it with --set ${list}=...` });
		}
		if (field.type === 'list' && !element.trim().startsWith('{')) {
			throw new CliError(`Give the new ${field.className} as JSON.`, {
				hint: `Like --add '${list}={"${field.fields?.[0]?.key}":"..."}'.`,
			});
		}
		// An element of a list is checked like a config of its own.
		const parsed =
			field.type === 'ids'
				? element.trim()
				: parseValue({ ...field, type: 'section' }, list, element);
		changes.push({ op: 'add', key: list, value: parsed });
	}
	for (const given of strings(flags.remove)) {
		const at = given.indexOf('=');
		const list = (at === -1 ? given : given.slice(0, at)).trim();
		fieldFor(list);
		changes.push({
			op: 'remove',
			key: list,
			...(at === -1 ? {} : { id: given.slice(at + 1).trim() }),
		});
	}
	for (const given of strings(flags.move)) {
		const [element, to] = pair('move', given);
		fieldFor(element);
		if (!/^\d+$/.test(to.trim())) {
			throw new CliError(`"${to}" is not a place in a list.`, {
				hint: 'Give where it goes, 0 for first.',
			});
		}
		changes.push({ op: 'move', key: element, to: Number(to) });
	}
	return changes;
}

/** Internal: a value the way a person would type it. */
function shown(field: Pick<Field, 'type'> | undefined, value: ConfigValue): string {
	if (value === null) return 'none';
	if (typeof value === 'boolean') return value ? 'on' : 'off';
	if (field?.type === 'duration' && typeof value === 'number') {
		return value % 1000 === 0 ? `${value / 1000}s` : `${value}ms`;
	}
	if (Array.isArray(value)) {
		return value
			.map((item) => (typeof item === 'string' ? item : shownElement(item as ConfigElement)))
			.join(', ');
	}
	if (typeof value === 'object') {
		return 'x' in value ? `${value.x}, ${value.y}, ${value.z}` : `${value.width}x${value.height}`;
	}
	return String(value);
}

function shownElement(element: ConfigElement): string {
	if (element.asCode) return element.asCode;
	const parts = [
		...Object.entries(element.values).map(([name, value]) => `${name}=${shown(undefined, value)}`),
		...Object.entries(element.code).map(([name, code]) => `${name}=${code}`),
	];
	return `(${parts.join(' ')})`;
}

/** Internal: everything that is written, one line each, for the terminal. */
function describe(report: ConfigReport): string {
	const fields = new Map(configFields().map((field) => [field.key, field]));
	const rows: [string, string][] = [];
	for (const [key, value] of Object.entries(report.values)) {
		const field = fields.get(key);
		if (field?.type === 'section') continue;
		rows.push([key, shown(field, value)]);
	}
	for (const [key, { code }] of Object.entries(report.code))
		rows.push([key, `set in code, ${code}`]);
	if (rows.length === 0) return "Nothing is set, so it is all SmartifyOS's own defaults.";
	rows.sort(([a], [b]) => a.localeCompare(b));
	const width = Math.max(...rows.map(([key]) => key.length));
	return [
		...rows.map(([key, value]) => `${key.padEnd(width)}  ${value}`),
		'',
		`Anything else is SmartifyOS's own default, see ${binaryName} config --list.`,
	].join('\n');
}

/** Internal: one setting, for the terminal. */
function showOne(report: ConfigReport, key: string): void {
	const { field } = fieldFor(key);
	const code = Object.entries(report.code).find(([at]) => key === at || key.startsWith(`${at}.`));
	if (code) {
		writeLine(`Set in code on line ${code[1].line}: ${code[1].code}`);
		return;
	}
	const value = report.values[key];
	if (value !== undefined) writeLine(shown(field, value));
	else
		writeLine(`${shown(field, field.default)} ${theme.dim("(not set, SmartifyOS's own default)")}`);
}

/** Internal: every setting there is, for the terminal. */
function listFields(fields: Field[]): void {
	const rows = fields
		.filter((field) => field.type !== 'section' && field.type !== 'code')
		.map((field) => {
			const fallback =
				field.type === 'list'
					? `of ${field.className}(${field.fields?.map((inner) => inner.key).join(', ')})`
					: `default ${shown(field, field.default)}`;
			const values = field.type === 'enum' ? `, one of ${field.values?.join(', ')}` : '';
			return [field.key, `${field.describe}, ${fallback}${values}`] as const;
		});
	const width = Math.max(...rows.map(([key]) => key.length));
	for (const [key, about] of rows)
		writeLine(`${theme.code(key.padEnd(width))}  ${theme.dim(about)}`);
}
