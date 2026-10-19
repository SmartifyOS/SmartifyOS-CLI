import { requireCar } from '../core/project/find.ts';
import { parseOrder, partIcons, partNames } from '../core/project/parts.ts';
import {
	addRow,
	builtInPages,
	changePage,
	changeRow,
	createPage,
	editPageFile,
	findPage,
	findRow,
	listPages,
	moveRow,
	type PageChanged,
	type RowChange,
	type RowKind,
	removePage,
	removeRow,
	type SettingsPageInfo,
	settingsFolder,
} from '../core/project/settings.ts';
import { runGroup } from '../ui/group.ts';
import { isJsonMode } from '../ui/json.ts';
import { intro, log, outro } from '../ui/output.ts';
import { confirm, isInteractive, note, select, text } from '../ui/prompt.ts';
import { theme } from '../ui/theme.ts';
import { CliError } from '../utils/errors.ts';
import { binaryName } from './flags.ts';
import type { Command, Flags } from './types.ts';

/** What `--kind` takes for each kind of row, and how it is offered. */
const rowWords: Record<RowKind, { flag: string; label: string; hint: string }> = {
	toggle: { flag: 'switch', label: 'A switch', hint: 'on or off, like seat heating' },
	choice: {
		flag: 'choice',
		label: 'A choice',
		hint: 'one of a few options, like Low, Medium, High',
	},
	action: { flag: 'button', label: 'A button', hint: 'runs code of yours, like Reset trip' },
	info: { flag: 'info', label: 'Information', hint: 'shows a value, like the next service' },
};

const onOff = (flags: Flags, name: string): boolean | undefined => {
	const value = flags[name];
	if (value === undefined) return undefined;
	if (value === 'on' || value === 'true' || value === 'yes') return true;
	if (value === 'off' || value === 'false' || value === 'no') return false;
	throw new CliError(`--${name} takes on or off.`);
};

/** Internal: the page named, or one asked for. */
async function pickPage(appDir: string, query: string | undefined): Promise<SettingsPageInfo> {
	const pages = await listPages(appDir);
	if (pages.length === 0) {
		throw new CliError('Your app has no settings pages of its own yet.', {
			hint: `Make one with ${binaryName} settings create.`,
		});
	}
	if (query) {
		const found = findPage(pages, query);
		if (!found) {
			throw new CliError(`Your app has no settings page called ${query}.`, {
				hint: `It has ${pages.map((page) => page.title ?? page.id).join(', ')}.`,
			});
		}
		return found;
	}
	return await select<SettingsPageInfo>({
		message: 'Which page?',
		options: pages.map((page) => ({
			value: page,
			label: page.title ?? page.file,
			hint: page.file,
		})),
	});
}

/** Internal: the row of a page named, or one asked for, with where it is. */
async function pickRow(page: SettingsPageInfo, query: string | undefined): Promise<number> {
	if (page.rows.length === 0) {
		throw new CliError(`${page.title ?? page.file} has no rows yet.`, {
			hint: `Add one with ${binaryName} settings add-row.`,
		});
	}
	if (query) {
		const row = findRow(page, query);
		if (!row) {
			throw new CliError(`${page.title ?? page.file} has no row called ${query}.`, {
				hint: `It has ${page.rows.map((known) => known.title ?? known.id ?? '?').join(', ')}.`,
			});
		}
		return page.rows.indexOf(row);
	}
	return await select<number>({
		message: 'Which row?',
		options: page.rows.map((row, index) => ({
			value: index,
			label: row.title ?? row.id ?? `Row ${index + 1}`,
			hint: row.kind ? rowWords[row.kind].label : 'written in code',
		})),
	});
}

/** Internal: the pages a page can go in: SmartifyOS's, then the car's own. */
async function parentChoices(appDir: string, except?: string) {
	const own = (await listPages(appDir)).filter((page) => page.id && page.id !== except);
	return [
		...builtInPages.map((page) => ({ value: page.id, label: page.title })),
		...own.map((page) => ({
			value: page.id as string,
			label: page.title ?? (page.id as string),
			hint: 'yours',
		})),
	];
}

function checkIcon(icon: string): string {
	if (/^[a-z][a-z0-9_]*$/.test(icon)) return icon;
	throw new CliError(`"${icon}" is not the name of an icon.`, {
		hint: `Use a name from Flutter's Icons, like ${partIcons
			.slice(0, 4)
			.map((known) => known.id)
			.join(', ')}.`,
	});
}

/** Internal: what was changed, for the terminal, and what was left in the code. */
function report(changed: PageChanged, message: string): PageChanged & { changed: true } {
	if (changed.kept.length > 0) {
		log.warn(
			`You wrote code in ${changed.kept.map((name) => theme.code(name)).join(', ')}, so it is still in ${theme.code(changed.page.file)}, though nothing on the page uses it any more.`,
		);
	}
	outro(message);
	return { ...changed, changed: true };
}

const createCommand: Command = {
	name: 'create',
	aliases: ['new'],
	summary: 'Make a settings page',
	description: `Makes a settings page of your own in ${settingsFolder}/, which opens from its row on the page you put it in, and hands it to SmartifyOS in lib/main.dart. Then add rows to it with add-row. Run it in your car's app folder.`,
	usage: '[name]',
	examples: [
		`${binaryName} settings create`,
		`${binaryName} settings create "Seat heating" --in vehicle --icon event_seat`,
	],
	flags: {
		in: {
			type: 'string',
			describe:
				'The page it goes in: vehicle, display, sound, root for Settings itself, or one of yours',
		},
		icon: { type: 'string', describe: "Its icon from Flutter's Icons, like settings" },
	},
	async run({ flags, positionals }) {
		intro('Make a settings page');
		const app = await requireCar();
		const names = partNames(
			positionals[0] ??
				(await text({
					message: 'What is it called? The driver reads this in Settings.',
					placeholder: 'Seat heating',
					validate: (value) => problemWith(() => partNames(value ?? '')),
				})),
		);
		const parent =
			typeof flags.in === 'string'
				? flags.in
				: isInteractive()
					? await select({
							message: 'Which page does it go in?',
							options: await parentChoices(app.dir),
							initialValue: 'vehicle',
						})
					: 'root';
		const icon =
			typeof flags.icon === 'string'
				? checkIcon(flags.icon)
				: isInteractive()
					? await select({
							message: 'Which icon?',
							options: partIcons.map((known) => ({
								value: known.id,
								label: known.label,
								hint: known.id,
							})),
							initialValue: 'settings',
						})
					: 'settings';
		const { page, manual } = await createPage(app.dir, names, parent, icon);
		log.success(`Made ${theme.code(page.file)}`);
		if (manual)
			log.warn(
				`There is no clear place for it in ${theme.code('lib/main.dart')}, so add ${manual}`,
			);
		outro(`Add rows to it with ${theme.code(`${binaryName} settings add-row "${names.name}"`)}.`);
		return { changed: true, page, kept: [], manual };
	},
};

const listCommand: Command = {
	name: 'list',
	aliases: ['ls'],
	summary: 'List the settings pages of your app',
	description: `Lists your own settings pages, the ones in ${settingsFolder}/ and any written some other way elsewhere in lib/, with their rows. Run it in your car's app folder.`,
	examples: [`${binaryName} settings list`],
	async run() {
		const app = await requireCar();
		const pages = await listPages(app.dir);
		if (!isJsonMode()) {
			if (pages.length === 0) {
				log.info(
					`Your app has no settings pages of its own yet. Make one with ${theme.code(`${binaryName} settings create`)}.`,
				);
			}
			for (const page of pages) {
				const rows = page.rows.map(
					(row) =>
						`${row.title ?? row.id ?? '?'}  ${theme.dim(row.kind ? rowWords[row.kind].label.toLowerCase() : 'written in code')}${row.saved ? theme.dim(`, remembered as ${row.saved.name}`) : ''}`,
				);
				note(
					rows.join('\n') || theme.dim('no rows yet'),
					`${page.title ?? page.id}  ${theme.dim(page.file)}`,
				);
			}
		}
		return { pages };
	},
};

const editCommand: Command = {
	name: 'edit',
	summary: 'Change a settings page',
	description:
		"Changes a page of your own: its name, the line under it, its icon, the page it goes in, or where its row sits there. Run it in your car's app folder.",
	usage: '<page>',
	examples: [`${binaryName} settings edit "Seat heating" --in display`],
	flags: {
		title: { type: 'string', describe: 'What the driver reads' },
		subtitle: { type: 'string', describe: 'The line under it, or "" for none' },
		icon: { type: 'string', describe: "Its icon from Flutter's Icons" },
		in: { type: 'string', describe: 'The page it goes in' },
		order: {
			type: 'string',
			describe: 'Where its row sits, smaller first, or "" for the usual place',
		},
	},
	async run({ flags, positionals }) {
		intro('Change a settings page');
		const app = await requireCar();
		const page = await pickPage(app.dir, positionals[0]);
		const change: {
			title?: string;
			subtitle?: string;
			icon?: string;
			parent?: string;
			order?: number | null;
		} = {};
		if (typeof flags.title === 'string') change.title = flags.title;
		if (typeof flags.subtitle === 'string') change.subtitle = flags.subtitle;
		if (typeof flags.icon === 'string') change.icon = checkIcon(flags.icon);
		if (typeof flags.in === 'string') change.parent = flags.in;
		if (typeof flags.order === 'string') change.order = parseOrder(flags.order);
		if (Object.keys(change).length === 0) {
			const what = await select<'title' | 'parent' | 'icon'>({
				message: 'What do you want to change?',
				options: [
					{ value: 'title', label: 'Its name', hint: page.title ?? '' },
					{ value: 'parent', label: 'The page it goes in', hint: page.parent ?? '' },
					{ value: 'icon', label: 'Its icon', hint: page.icon ?? '' },
				],
			});
			if (what === 'title')
				change.title = await text({
					message: 'What should it be called?',
					initialValue: page.title ?? '',
				});
			if (what === 'parent') {
				change.parent = await select({
					message: 'Which page does it go in?',
					options: await parentChoices(app.dir, page.id ?? undefined),
				});
			}
			if (what === 'icon') {
				change.icon = await select({
					message: 'Which icon?',
					options: partIcons.map((known) => ({
						value: known.id,
						label: known.label,
						hint: known.id,
					})),
				});
			}
		}
		return report(
			await editPageFile(app.dir, page, (source) => ({ source: changePage(source, page, change) })),
			`Changed ${theme.code(page.file)}`,
		);
	},
};

const removeCommand: Command = {
	name: 'remove',
	aliases: ['rm', 'delete'],
	summary: 'Take a settings page out of your app',
	description:
		"Takes one of your settings pages out of lib/main.dart and deletes its file, with every row and everything written in it. Run it in your car's app folder.",
	usage: '<page>',
	examples: [`${binaryName} settings remove "Seat heating"`],
	async run({ flags, positionals }) {
		intro('Remove a settings page');
		const app = await requireCar();
		const page = await pickPage(app.dir, positionals[0]);
		if (flags.yes !== true) {
			const sure = await confirm({
				message: `Delete ${page.file}, with everything written in it?`,
				initialValue: false,
			});
			if (!sure) {
				outro(`Kept it ${theme.dim('(nothing was changed)')}`);
				return { changed: false, page, kept: [] };
			}
		}
		await removePage(app.dir, page);
		outro(`Took ${page.title ?? page.file} out of your app`);
		return { changed: true, page, kept: [] };
	},
};

const rowFlags = {
	title: { type: 'string', describe: 'What the driver reads' },
	subtitle: { type: 'string', describe: 'The line under it, or "" for none' },
	section: { type: 'string', describe: 'The heading it goes under, or "" for none' },
	remember: {
		type: 'string',
		describe: 'A switch or choice: on to keep it between drives in a SavedValue, or off',
	},
	code: {
		type: 'string',
		describe: 'A switch or choice: on to run a function of yours when it changes, or off',
	},
	default: {
		type: 'string',
		describe: 'What it is until the driver changes it: on or off, or the option',
	},
	option: { type: 'string', multiple: true, describe: 'A choice: an option, again for more' },
	value: { type: 'string', describe: 'Information: what it shows' },
} as const;

/** Internal: a row change from the flags, a default checked against what the row is. */
function rowChange(
	flags: Flags,
	kind: RowKind | null,
	options: { value: string; label: string }[],
): RowChange {
	const change: RowChange = {};
	if (typeof flags.title === 'string') change.title = partNames(flags.title).name;
	if (typeof flags.subtitle === 'string') change.subtitle = flags.subtitle;
	if (typeof flags.section === 'string') change.section = flags.section;
	if (typeof flags.value === 'string') change.value = flags.value;
	const remember = onOff(flags, 'remember');
	if (remember !== undefined) change.remember = remember;
	const code = onOff(flags, 'code');
	if (code !== undefined) change.code = code;
	if (Array.isArray(flags.option)) change.options = flags.option.map(String);
	if (typeof flags.default === 'string') {
		if (kind === 'toggle') change.default = onOff(flags, 'default') ?? false;
		else {
			// An option by its label or its value, among the new ones if they change too.
			const labels = change.options ?? options.map((option) => option.label);
			const byLabel = labels.find(
				(label) => label.toLowerCase() === String(flags.default).toLowerCase(),
			);
			const known = options.find(
				(option) => option.value === flags.default || option.label === byLabel,
			);
			change.default = known?.value ?? (byLabel ? partNames(byLabel).snake : String(flags.default));
		}
	}
	return change;
}

const addRowCommand: Command = {
	name: 'add-row',
	summary: 'Add a row to a settings page',
	description:
		"Adds a row at the end of one of your settings pages: a switch, a choice, a button or information. A switch or a choice remembers its value between drives in a SavedValue the rest of your app can read, unless --remember off. A button runs a function of yours, which starts out further down the page's file. Run it in your car's app folder.",
	usage: '<page> [title]',
	examples: [
		`${binaryName} settings add-row "Seat heating" "Driver seat" --kind switch`,
		`${binaryName} settings add-row "Seat heating" Level --kind choice --option Low --option Medium --option High`,
		`${binaryName} settings add-row "Seat heating" "Reset" --kind button`,
	],
	flags: {
		kind: { type: 'string', describe: 'What kind: switch, choice, button or info' },
		...rowFlags,
	},
	async run({ flags, positionals }) {
		intro('Add a row');
		const app = await requireCar();
		const page = await pickPage(app.dir, positionals[0]);
		let kind: RowKind;
		if (typeof flags.kind === 'string') {
			const found = (Object.keys(rowWords) as RowKind[]).find(
				(known) => rowWords[known].flag === flags.kind,
			);
			if (!found)
				throw new CliError(`"${flags.kind}" is not a kind of row.`, {
					hint: 'Use --kind switch, choice, button or info.',
				});
			kind = found;
		} else {
			kind = await select<RowKind>({
				message: 'What kind of row?',
				options: (Object.keys(rowWords) as RowKind[]).map((known) => ({
					value: known,
					label: rowWords[known].label,
					hint: rowWords[known].hint,
				})),
			});
		}
		const title = partNames(
			positionals[1] ??
				(typeof flags.title === 'string'
					? flags.title
					: await text({
							message: 'What does it say?',
							validate: (value) => problemWith(() => partNames(value ?? '')),
						})),
		).name;
		const change = rowChange({ ...flags, title: undefined }, kind, []);
		if (kind === 'choice' && !change.options && isInteractive() && !isJsonMode()) {
			const answer = await text({
				message: 'What can be picked? Separate them with commas.',
				placeholder: 'Low, Medium, High',
			});
			change.options = answer
				.split(',')
				.map((label) => label.trim())
				.filter(Boolean);
		}
		let added: string | undefined;
		const changed = await editPageFile(app.dir, page, (source) => {
			const result = addRow(source, page, kind, title, change);
			added = result.row.id ?? undefined;
			return { source: result.source };
		});
		const row = changed.page.rows.find((known) => known.id === added);
		if (row?.saved)
			log.info(`Read it anywhere in your app with ${theme.code(`${row.saved.name}.value`)}.`);
		if (row?.code)
			log.info(`Write what it does in ${theme.code(`${changed.page.file}:${row.code.line}`)}.`);
		return {
			...report(changed, `Added ${title} to ${changed.page.title ?? changed.page.file}`),
			row: row ?? null,
		};
	},
};

const editRowCommand: Command = {
	name: 'edit-row',
	summary: 'Change a row of a settings page',
	description:
		"Changes a row of one of your settings pages: what it says, the line under it, its heading, whether it remembers its value or runs code of yours, its options, or what it shows. Run it in your car's app folder.",
	usage: '<page> <row>',
	examples: [
		`${binaryName} settings edit-row "Seat heating" driver_seat --title "Driver's seat"`,
		`${binaryName} settings edit-row "Seat heating" level --option Off --option Low --option High --default Off`,
		`${binaryName} settings edit-row "Seat heating" driver_seat --code on`,
	],
	flags: rowFlags,
	async run({ flags, positionals }) {
		intro('Change a row');
		const app = await requireCar();
		const page = await pickPage(app.dir, positionals[0]);
		const index = await pickRow(page, positionals[1]);
		const row = page.rows[index];
		const change = rowChange(flags, row?.kind ?? null, row?.options ?? []);
		if (Object.keys(change).length === 0) {
			change.title = partNames(
				await text({ message: 'What should it say?', initialValue: row?.title ?? '' }),
			).name;
		}
		const changed = await editPageFile(app.dir, page, (source, elsewhere) =>
			changeRow(source, page, index, change, elsewhere),
		);
		return {
			...report(changed, `Changed ${changed.page.rows[index]?.title ?? 'the row'}`),
			row: changed.page.rows[index] ?? null,
		};
	},
};

const removeRowCommand: Command = {
	name: 'remove-row',
	summary: 'Take a row off a settings page',
	description:
		"Takes a row off one of your settings pages, with its SavedValue unless something else in your app reads it, and its function unless you wrote code in it. Run it in your car's app folder.",
	usage: '<page> <row>',
	examples: [`${binaryName} settings remove-row "Seat heating" level`],
	async run({ positionals }) {
		intro('Take a row off');
		const app = await requireCar();
		const page = await pickPage(app.dir, positionals[0]);
		const index = await pickRow(page, positionals[1]);
		const title = page.rows[index]?.title ?? 'the row';
		const changed = await editPageFile(app.dir, page, (source, elsewhere) =>
			removeRow(source, page, index, elsewhere),
		);
		return report(changed, `Took ${title} off ${changed.page.title ?? changed.page.file}`);
	},
};

const moveRowCommand: Command = {
	name: 'move-row',
	summary: 'Move a row of a settings page up or down',
	description:
		"Moves a row of one of your settings pages one place up or down. Run it in your car's app folder.",
	usage: '<page> <row>',
	examples: [`${binaryName} settings move-row "Seat heating" level --up`],
	flags: {
		up: { type: 'boolean', describe: 'One place up' },
		down: { type: 'boolean', describe: 'One place down' },
	},
	async run({ flags, positionals }) {
		intro('Move a row');
		const app = await requireCar();
		const page = await pickPage(app.dir, positionals[0]);
		const index = await pickRow(page, positionals[1]);
		const direction =
			flags.up === true
				? 'up'
				: flags.down === true
					? 'down'
					: await select<'up' | 'down'>({
							message: 'Which way?',
							options: [
								{ value: 'up', label: 'Up' },
								{ value: 'down', label: 'Down' },
							],
						});
		const other = direction === 'up' ? index - 1 : index + 1;
		if (other < 0 || other >= page.rows.length) {
			outro(
				`It is ${direction === 'up' ? 'at the top' : 'at the bottom'} already ${theme.dim('(nothing was changed)')}`,
			);
			return { changed: false, page, kept: [] };
		}
		const changed = await editPageFile(app.dir, page, (source) => ({
			source: moveRow(source, index, direction),
		}));
		return report(changed, `Moved it ${direction}`);
	},
};

/** The car's own settings pages, and their rows. */
export const settingsCommand: Command = {
	name: 'settings',
	summary: 'Make and change the settings pages of your app',
	description: `Settings pages of your own, each a file in ${settingsFolder}/ that SmartifyOS is handed in lib/main.dart. Make one, put it in a page of Settings, and add switches, choices, buttons and information to it. A switch or a choice can keep its value between drives in a SavedValue the rest of your app reads.`,
	examples: [
		`${binaryName} settings create "Seat heating" --in vehicle`,
		`${binaryName} settings add-row "Seat heating" "Driver seat" --kind switch`,
		`${binaryName} settings list`,
	],
	subcommands: [
		createCommand,
		listCommand,
		editCommand,
		removeCommand,
		addRowCommand,
		editRowCommand,
		removeRowCommand,
		moveRowCommand,
	],
	async run() {
		await runGroup(settingsCommand);
	},
};

/** Internal: the message of whatever `check` throws, for a prompt's validation. */
function problemWith(check: () => unknown): string | undefined {
	try {
		check();
		return undefined;
	} catch (error) {
		return error instanceof CliError ? (error.hint ?? error.message) : String(error);
	}
}
