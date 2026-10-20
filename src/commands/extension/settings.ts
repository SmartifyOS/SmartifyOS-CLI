import {
	changeExtensionSettings,
	type ExtensionSettingChange,
	readExtensionFields,
	readExtensionSettings,
} from '../../core/extension/settings.ts';
import { findEntry, packageData, readCar } from '../../core/project/car.ts';
import { type ConfigValue, parseValue } from '../../core/project/config.ts';
import { carFiles, requireCar } from '../../core/project/find.ts';
import { isJsonMode } from '../../ui/json.ts';
import { intro, log, outro } from '../../ui/output.ts';
import { note } from '../../ui/prompt.ts';
import { theme } from '../../ui/theme.ts';
import { CliError } from '../../utils/errors.ts';
import { binaryName } from '../flags.ts';
import type { Command, Flags } from '../types.ts';
import { pickInstalled } from './pick.ts';

/**
 * Reads and changes an extension's settings: the arguments its class takes where the car's app
 * hands it to SmartifyOS, in `lib/main.dart`.
 */
export const extensionSettingsCommand: Command = {
	name: 'settings',
	summary: "Change an extension's settings",
	description:
		"Reads and changes the settings an extension takes in lib/main.dart, where your app switches it on, like the voice assistant's wake word. What each setting is comes from the extension's own code. On or off, numbers, text, times, colours and lists of names can be changed here, anything else only in lib/main.dart. Values are typed like config's. Run it in your car's app folder.",
	usage: '[name] [setting] [value]',
	examples: [
		`${binaryName} extension settings voice_assistant`,
		`${binaryName} extension settings voice_assistant wakeWord "Hey Miata"`,
		`${binaryName} extension settings voice_assistant --set duckLevel=0.3 --unset keepModelsLoadedFor`,
		`${binaryName} extension settings voice_assistant --add "wakeWordSpellings=Hey Miyata"`,
	],
	flags: {
		set: {
			type: 'string',
			multiple: true,
			describe: 'Change a setting, as name=value, again for more',
		},
		unset: {
			type: 'string',
			multiple: true,
			describe: "Take a setting out, so the extension's default is used, again for more",
		},
		add: { type: 'string', multiple: true, describe: 'Put a name into a list, as name=value' },
		remove: {
			type: 'string',
			multiple: true,
			describe: 'Take a name out of a list, as name=value',
		},
	},
	async run({ flags, positionals }) {
		const app = await requireCar();
		const state = await readCar(app);
		if (state.extensions.length === 0) {
			throw new CliError('This car has no extensions.', {
				hint: `Add one with ${binaryName} extension add <url>.`,
			});
		}
		const extension = await pickInstalled(state.extensions, positionals[0], 'Which extension?');
		if (!extension.root) {
			throw new CliError(`${extension.title} has not been fetched yet.`, {
				hint: `Run ${binaryName} update, which fetches everything your car runs.`,
			});
		}
		const entry = await findEntry(extension.name, extension.root);
		if (!entry) {
			throw new CliError(`${extension.title} has no extension class this can read.`, {
				hint: 'Its settings are written in lib/main.dart by hand.',
			});
		}

		const fields = await readExtensionFields(extension.root, entry);
		const mainPath = carFiles(app).main;
		const changes = changesFrom(flags, positionals.slice(1), fields);
		const about = { extension: packageData(extension) };

		if (changes.length === 0) {
			const current = readExtensionSettings(await Bun.file(mainPath).text(), entry, fields);
			if (!isJsonMode()) note(describe(current), `${extension.title}'s settings`);
			return { ...about, changed: false, manual: [], ...current };
		}

		intro(`Change ${extension.title}'s settings`);
		const result = await changeExtensionSettings(mainPath, entry, fields, changes);
		if (result.manual.length > 0) {
			log.warn(
				`Some of it has no clear place in ${theme.code('lib/main.dart')}, so make it there by hand:\n${result.manual.join('\n')}`,
			);
		}
		outro(
			result.changed
				? `Changed. If your car's app is running, press ${theme.code('R')} to restart it.`
				: `It was set up that way already ${theme.dim('(nothing was changed)')}`,
		);
		return { ...about, ...result };
	},
};

function strings(value: Flags[string]): string[] {
	return (Array.isArray(value) ? value : [value]).filter(
		(item): item is string => typeof item === 'string',
	);
}

/** Internal: `name=value` split at the first `=`. */
function pair(flag: string, given: string): [string, string] {
	const at = given.indexOf('=');
	if (at <= 0)
		throw new CliError(`--${flag} ${given} needs a value.`, {
			hint: `Give it as --${flag} name=value.`,
		});
	return [given.slice(0, at).trim(), given.slice(at + 1)];
}

/** Internal: every change the flags and words ask for, checked against the settings there are. */
function changesFrom(
	flags: Flags,
	words: string[],
	fields: Awaited<ReturnType<typeof readExtensionFields>>,
): ExtensionSettingChange[] {
	const field = (name: string) => {
		const found = fields.find((known) => known.key === name);
		if (!found) {
			throw new CliError(`There is no setting called ${name}.`, {
				hint: `It has ${fields.map((known) => known.key).join(', ') || 'none'}.`,
			});
		}
		return found;
	};
	const changes: ExtensionSettingChange[] = [];
	const set = (name: string, value: string) =>
		changes.push({
			op: 'set',
			key: name,
			value: parseValue(field(name), name, value) as ConfigValue,
		});

	if (words.length > 2) throw new CliError('Give one setting and one value.');
	const [name, value] = words;
	if (name !== undefined && value !== undefined) set(name, value);
	for (const given of strings(flags.set)) set(...pair('set', given));
	for (const given of strings(flags.unset))
		changes.push({ op: 'unset', key: field(given.trim()).key });
	for (const op of ['add', 'remove'] as const) {
		for (const given of strings(flags[op])) {
			const [list, id] = pair(op, given);
			if (field(list).type !== 'ids') throw new CliError(`${list} is not a list of names.`);
			changes.push({ op, key: list, id: id.trim() });
		}
	}
	return changes;
}

/** Internal: every setting with what it is, for the terminal. */
function describe(current: ReturnType<typeof readExtensionSettings>): string {
	if (current.fields.length === 0) return 'It has no settings.';
	const width = Math.max(...current.fields.map((field) => field.key.length));
	const rows = current.fields.map((field) => {
		const code = current.code[field.key];
		const value = current.values[field.key];
		const shown = code
			? `set in code, ${code.code}`
			: value !== undefined
				? JSON.stringify(value)
				: theme.dim(`default, ${field.defaultCode ?? JSON.stringify(field.default)}`);
		return `${field.key.padEnd(width)}  ${shown}`;
	});
	return [
		...rows,
		...(current.switchedOn
			? []
			: ['', 'It is not switched on in lib/main.dart, so none of it is set.']),
	].join('\n');
}
