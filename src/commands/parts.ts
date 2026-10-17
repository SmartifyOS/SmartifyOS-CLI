import { requireCar } from '../core/project/find.ts';
import {
	createPart,
	editPart,
	findPart,
	kinds,
	listParts,
	type Part,
	type PartKind,
	type PartVariant,
	partIcons,
	partNames,
	removePart,
} from '../core/project/parts.ts';
import { runGroup } from '../ui/group.ts';
import { isJsonMode } from '../ui/json.ts';
import { intro, log, outro } from '../ui/output.ts';
import { confirm, isInteractive, note, select, text } from '../ui/prompt.ts';
import { theme } from '../ui/theme.ts';
import { CliError } from '../utils/errors.ts';
import { binaryName } from './flags.ts';
import type { Command, Flags } from './types.ts';

/** How each kind and each of its variants is offered. */
const words: Record<
	PartKind,
	{
		title: string;
		plural: string;
		example: string;
		where: string;
		variants: Partial<Record<PartVariant, { flag: string; label: string; hint: string }>>;
	}
> = {
	window: {
		title: 'Window',
		plural: 'windows',
		example: 'Trip computer',
		where: 'It opens from its icon in the app list.',
		variants: {
			fullscreen: {
				flag: 'fullscreen',
				label: 'Full screen',
				hint: 'fills the screen, like most apps',
			},
			floating: { flag: 'floating', label: 'Floating', hint: 'smaller, over the home screen' },
		},
	},
	tile: {
		title: 'Quick settings tile',
		plural: 'quick settings tiles',
		example: 'Interior light',
		where: 'It is in the quick settings, the shade pulled down from the top.',
		variants: {
			toggle: { flag: 'switch', label: 'A switch', hint: 'turns something on and off' },
			button: { flag: 'button', label: 'A button', hint: 'does the same thing every time' },
		},
	},
	widget: {
		title: 'Home screen widget',
		plural: 'home screen widgets',
		example: 'Oil temperature',
		where: 'It is on the home screen.',
		variants: {
			card: { flag: 'card', label: 'A card', hint: 'shows up by itself, can be swiped away' },
			pinned: { flag: 'pinned', label: 'Always there', hint: 'stays where the driver puts it' },
		},
	},
};

function variantFlags(kind: PartKind): string {
	return kinds[kind].variants.map((variant) => words[kind].variants[variant]?.flag).join(' or ');
}

/** A group of commands for one kind of part: `window create`, `window list` and so on. */
function partCommand(kind: PartKind): Command {
	const spec = kinds[kind];
	const say = words[kind];
	const group: Command = {
		name: kind,
		aliases: [`${kind}s`],
		summary: `Make and change the ${say.plural} of your app`,
		description: `${say.title}s of your own, each a file in lib/${spec.folder}/ that SmartifyOS is handed in lib/main.dart. Make one and fill in what it ${kind === 'tile' ? 'does' : 'shows'}, rename it, give it another icon, or take it out again.`,
		examples: [
			`${binaryName} ${kind} create`,
			`${binaryName} ${kind} create "${say.example}" --kind ${words[kind].variants[spec.variants[0] as PartVariant]?.flag}`,
			`${binaryName} ${kind} list`,
		],
		subcommands: [createCommand(kind), listCommand(kind), editCommand(kind), removeCommand(kind)],
		async run() {
			await runGroup(group);
		},
	};
	return group;
}

function createCommand(kind: PartKind): Command {
	const spec = kinds[kind];
	const say = words[kind];
	return {
		name: 'create',
		aliases: ['new'],
		summary: `Make a ${spec.noun}`,
		description: `Makes a ${spec.noun} of your own in lib/${spec.folder}/ and hands it to SmartifyOS in lib/main.dart. ${say.where} Then change what it ${kind === 'tile' ? 'does' : 'shows'} in its file. Run it in your car's app folder.`,
		usage: '[name]',
		examples: [
			`${binaryName} ${kind} create`,
			`${binaryName} ${kind} create "${say.example}" --kind ${say.variants[spec.variants[1] as PartVariant]?.flag} --icon ${spec.icon}`,
		],
		flags: {
			kind: { type: 'string', describe: `What kind: ${variantFlags(kind)}` },
			icon: {
				type: 'string',
				describe: `Its icon from Flutter's Icons, like ${spec.icon} or speed`,
			},
		},
		async run({ flags, positionals }) {
			intro(`Make a ${spec.noun}`);
			const app = await requireCar();
			const names = partNames(
				positionals[0] ??
					(await text({
						message: `What is it called? The driver reads this.`,
						placeholder: say.example,
						validate: (value) => problemWith(() => partNames(value ?? '')),
					})),
			);
			const variant = await askVariant(kind, flags);
			const icon = await askIcon(kind, flags.icon);

			const { part, manual } = await createPart(app.dir, kind, variant, names, icon);
			log.success(`Made ${theme.code(part.file)}`);
			if (manual)
				log.warn(
					`There is no clear place for it in ${theme.code('lib/main.dart')}, so add ${manual}`,
				);
			outro(
				`${say.where} Change what it ${kind === 'tile' ? 'does' : 'shows'} in ${theme.code(`${part.file}:${part.line}`)}.`,
			);
			return { changed: true, part, manual };
		},
	};
}

async function askVariant(kind: PartKind, flags: Flags): Promise<PartVariant> {
	const spec = kinds[kind];
	const say = words[kind];
	if (typeof flags.kind === 'string') {
		const found = spec.variants.find((variant) => say.variants[variant]?.flag === flags.kind);
		if (!found) {
			throw new CliError(`"${flags.kind}" is not a kind of ${spec.noun}.`, {
				hint: `Use --kind ${variantFlags(kind)}.`,
			});
		}
		return found;
	}
	if (!isInteractive() || flags.yes === true) return spec.variants[0] as PartVariant;
	return await select<PartVariant>({
		message: 'What kind?',
		options: spec.variants.map((variant) => ({
			value: variant,
			label: say.variants[variant]?.label ?? variant,
			hint: say.variants[variant]?.hint ?? '',
		})),
	});
}

async function askIcon(kind: PartKind, given: unknown, current?: string): Promise<string> {
	if (typeof given === 'string') return checkIcon(given);
	if (!isInteractive()) return current ?? kinds[kind].icon;
	return await select({
		message: 'Which icon?',
		options: partIcons.map((icon) => ({ value: icon.id, label: icon.label, hint: icon.id })),
		initialValue: current ?? kinds[kind].icon,
	});
}

/** Internal: an icon's name in Flutter's `Icons`, which goes into the code as it is. */
function checkIcon(icon: string): string {
	if (/^[a-z][a-z0-9_]*$/.test(icon)) return icon;
	throw new CliError(`"${icon}" is not the name of an icon.`, {
		hint: `Use a name from Flutter's Icons, like ${partIcons
			.slice(0, 4)
			.map((known) => known.id)
			.join(', ')}.`,
	});
}

function listCommand(kind: PartKind): Command {
	const say = words[kind];
	return {
		name: 'list',
		aliases: ['ls'],
		summary: `List the ${say.plural} of your app`,
		description: `Lists the ${say.plural} in lib/${kinds[kind].folder}/, with their files and whether lib/main.dart hands them to SmartifyOS. Run it in your car's app folder.`,
		examples: [`${binaryName} ${kind} list`],
		async run() {
			const app = await requireCar();
			const parts = await listParts(app.dir, kind);
			if (!isJsonMode()) {
				if (parts.length === 0) {
					log.info(
						`Your app has no ${say.plural} of its own yet. Make one with ${theme.code(`${binaryName} ${kind} create`)}.`,
					);
				} else {
					note(
						parts
							.map(
								(part) =>
									`${part.name ?? part.id ?? part.file}  ${theme.dim(part.file)}${part.registered ? '' : theme.dim('  (not in lib/main.dart)')}`,
							)
							.join('\n'),
						`${say.title}s`,
					);
				}
			}
			return { parts };
		},
	};
}

function editCommand(kind: PartKind): Command {
	const spec = kinds[kind];
	return {
		name: 'edit',
		aliases: ['rename'],
		summary: `Rename a ${spec.noun} or give it another icon`,
		description: `Changes the name the driver reads or the icon of one of your ${words[kind].plural}, in its file. Run it in your car's app folder.`,
		usage: '<name>',
		examples: [
			`${binaryName} ${kind} edit "${words[kind].example}" --name "Something else"`,
			`${binaryName} ${kind} edit ${partNames(words[kind].example).snake} --icon star`,
		],
		flags: {
			name: { type: 'string', describe: 'What the driver reads' },
			icon: { type: 'string', describe: "Its icon from Flutter's Icons, like speed" },
		},
		async run({ flags, positionals }) {
			intro(`Change a ${spec.noun}`);
			const app = await requireCar();
			const part = await pickPart(app.dir, kind, positionals[0]);
			const change: { name?: string; icon?: string } = {};
			if (typeof flags.name === 'string') change.name = flags.name;
			if (typeof flags.icon === 'string') change.icon = checkIcon(flags.icon);
			if (Object.keys(change).length === 0) {
				const what = await select<'name' | 'icon'>({
					message: 'What do you want to change?',
					options: [
						{ value: 'name', label: 'Its name', hint: part.name ?? '' },
						{ value: 'icon', label: 'Its icon', hint: part.icon ?? '' },
					],
				});
				if (what === 'name') {
					change.name = await text({
						message: 'What should it be called?',
						initialValue: part.name ?? '',
						validate: (value) => problemWith(() => partNames(value ?? '')),
					});
				} else {
					change.icon = await askIcon(kind, undefined, part.icon ?? undefined);
				}
			}
			const edited = await editPart(app.dir, part, change);
			outro(`Changed ${theme.code(edited.file)}`);
			return { changed: true, part: edited };
		},
	};
}

function removeCommand(kind: PartKind): Command {
	const spec = kinds[kind];
	return {
		name: 'remove',
		aliases: ['rm', 'delete'],
		summary: `Take a ${spec.noun} out of your app`,
		description: `Takes one of your ${words[kind].plural} out of lib/main.dart and deletes its file, with everything written in it. Run it in your car's app folder.`,
		usage: '<name>',
		examples: [`${binaryName} ${kind} remove "${words[kind].example}"`],
		async run({ flags, positionals }) {
			intro(`Remove a ${spec.noun}`);
			const app = await requireCar();
			const part = await pickPart(app.dir, kind, positionals[0]);
			if (flags.yes !== true) {
				const sure = await confirm({
					message: `Delete ${part.file}, with everything written in it?`,
					initialValue: false,
				});
				if (!sure) {
					outro(`Kept it ${theme.dim('(nothing was changed)')}`);
					return { changed: false, part };
				}
			}
			await removePart(app.dir, part);
			outro(`Took ${part.name ?? part.file} out of your app`);
			return { changed: true, part };
		},
	};
}

/** Internal: the part named, or one asked for. */
async function pickPart(appDir: string, kind: PartKind, query: string | undefined): Promise<Part> {
	const parts = await listParts(appDir, kind);
	const say = words[kind];
	if (parts.length === 0) {
		throw new CliError(`Your app has no ${say.plural} of its own yet.`, {
			hint: `Make one with ${binaryName} ${kind} create.`,
		});
	}
	if (query) {
		const found = findPart(parts, query);
		if (!found) {
			throw new CliError(`Your app has no ${kinds[kind].noun} called ${query}.`, {
				hint: `It has ${parts.map((part) => part.name ?? part.id).join(', ')}.`,
			});
		}
		return found;
	}
	return await select<Part>({
		message: 'Which one?',
		options: parts.map((part) => ({ value: part, label: part.name ?? part.file, hint: part.file })),
	});
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

export const windowCommand = partCommand('window');
export const tileCommand = partCommand('tile');
export const widgetCommand = partCommand('widget');
