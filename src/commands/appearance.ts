import {
	type Appearance,
	type AppearanceChange,
	type AppearanceChanged,
	type CarLookName,
	carLooks,
	changeAppearance,
	readAppearance,
	readPartNames,
	themes,
} from '../core/project/appearance.ts';
import { type BarChoice, type DriverSide, layouts } from '../core/project/create.ts';
import { carFiles, requireCar } from '../core/project/find.ts';
import { isJsonMode } from '../ui/json.ts';
import { intro, log, outro } from '../ui/output.ts';
import { isInteractive, note, select, text } from '../ui/prompt.ts';
import { theme as colors } from '../ui/theme.ts';
import { CliError } from '../utils/errors.ts';
import { barFlag, cleanPath, lookFlags, lookProblem } from './create.ts';
import { binaryName } from './flags.ts';
import type { Command, Flags } from './types.ts';

/** How each way to draw the car is said, and what `--look` calls it. */
const lookNames: Record<CarLookName, { label: string; flag: string }> = {
	model3D: { label: 'the 3D model', flag: 'model-3d' },
	drawing2D: { label: 'the drawing', flag: 'drawing' },
	image: { label: 'the picture', flag: 'picture' },
};

const barNames: Record<BarChoice, string> = {
	infoDisplay: 'the info display',
	dock: 'a dock of apps',
	infoDisplayAndDock: 'the info display and a dock',
};

/**
 * Changes how the car's app looks: the layout and theme it starts with, which side the driver
 * sits on, what is in the bar, and the car on the screen.
 */
export const appearanceCommand: Command = {
	name: 'appearance',
	summary: 'Change how the screen looks',
	description: `Changes how your car's app looks: the layout and theme it starts with, which side the driver sits on, what is in the bar, and the 3D model, drawing or picture of the car. The driver can still pick another layout and theme in Settings. It writes into lib/main.dart, where you can change it by hand too. Without flags it asks what to change, with --show or --json it only says how it is set up now. Run it in your car's app folder.`,
	examples: [
		`${binaryName} appearance`,
		`${binaryName} appearance --layout split --theme slate --driver-side right`,
		`${binaryName} appearance --model-3d ~/Downloads/golf.glb --look model-3d`,
		`${binaryName} appearance --show`,
	],
	flags: {
		layout: {
			type: 'string',
			describe: `The layout it starts with: ${layouts.map((layout) => layout.id).join(', ')}, or one of your car's own`,
		},
		theme: {
			type: 'string',
			describe: `The theme it wears in every layout: ${themes.map((t) => t.id).join(', ')}, one of your car's own, or none for each layout's own`,
		},
		'driver-side': { type: 'string', describe: 'Which side the driver sits on: left or right' },
		bar: { type: 'string', describe: 'What goes in the bar: info-display, dock or both' },
		'model-3d': { type: 'string', describe: 'A 3D model of the car, a .glb file, or none' },
		drawing: {
			type: 'string',
			describe: 'A drawing of the car seen from above, an .svg file, or none',
		},
		picture: { type: 'string', describe: 'A picture of the car, a .png or .jpg file, or none' },
		look: {
			type: 'string',
			describe: 'Which of them the car starts with: model-3d, drawing, picture, or first',
		},
		show: { type: 'boolean', describe: 'Only say how it is set up now, and change nothing' },
	},
	async run({ flags }) {
		const app = await requireCar();
		const mainPath = carFiles(app).main;
		const current = readAppearance(await Bun.file(mainPath).text());
		const change = changeFromFlags(flags, process.cwd());
		const nothingGiven = Object.keys(change).length === 0;

		if (flags.show === true || (nothingGiven && (isJsonMode() || !isInteractive()))) {
			if (!isJsonMode()) note(describe(current), 'How your car looks');
			const partNames = await readPartNames(app.dir, current.car);
			return {
				changed: false,
				appearance: current,
				manual: [],
				assets: [],
				restart: false,
				partNames,
			};
		}

		intro('Change how the screen looks');
		if (nothingGiven) Object.assign(change, await ask(current, process.cwd()));

		const result = await changeAppearance(app.dir, change);
		report(result);
		return { ...result, partNames: await readPartNames(app.dir, result.appearance.car) };
	},
};

/** Internal: the change the flags ask for, checked. */
function changeFromFlags(flags: Flags, cwd: string): AppearanceChange {
	const change: AppearanceChange = {};

	if (typeof flags.layout === 'string') change.layout = checkId(flags.layout, 'layout');
	if (typeof flags.theme === 'string') {
		change.theme = flags.theme === 'none' ? null : checkId(flags.theme, 'theme');
	}

	const side = flags['driver-side'];
	if (typeof side === 'string') {
		if (side !== 'left' && side !== 'right') {
			throw new CliError(`"${side}" is not a side.`, { hint: 'Use --driver-side left or right.' });
		}
		change.driverSide = side;
	}

	if (typeof flags.bar === 'string') {
		const bar = barFlag[flags.bar];
		if (!bar) {
			throw new CliError(`"${flags.bar}" is not something the bar can hold.`, {
				hint: 'Use --bar info-display, dock or both.',
			});
		}
		change.bar = bar;
	}

	for (const look of carLooks) {
		const flag = lookFlags[look];
		const value = flags[flag];
		if (typeof value !== 'string') continue;
		if (value === 'none') {
			change[look] = null;
			continue;
		}
		const path = cleanPath(value, cwd);
		const problem = lookProblem(path, look);
		if (problem) throw new CliError(problem, { hint: `Check --${flag}.` });
		change[look] = path;
	}

	if (typeof flags.look === 'string') {
		if (flags.look === 'first') change.look = null;
		else {
			const look = carLooks.find((name) => lookNames[name].flag === flags.look);
			if (!look) {
				throw new CliError(`"${flags.look}" is not a way to draw the car.`, {
					hint: 'Use --look model-3d, drawing, picture or first.',
				});
			}
			change.look = look;
		}
	}

	return change;
}

/** Internal: a layout's or theme's id, which ends up in Dart as a name or in quotes. */
function checkId(id: string, what: 'layout' | 'theme'): string {
	if (/^[A-Za-z0-9_]+$/.test(id)) return id;
	const known = what === 'layout' ? layouts.map((layout) => layout.id) : themes.map((t) => t.id);
	throw new CliError(`"${id}" cannot be the name of a ${what}.`, {
		hint: `Use one of ${known.join(', ')}, or the id one of your car's own ${what}s has.`,
	});
}

/** Internal: asks what to change, for someone at a terminal who gave no flags. */
async function ask(current: Appearance, cwd: string): Promise<AppearanceChange> {
	const pictures = carLooks
		.filter((look) => current.car[look])
		.map((look) => lookNames[look].label);
	const what = await select<'layout' | 'theme' | 'side' | 'bar' | 'car'>({
		message: 'What do you want to change?',
		options: [
			{
				value: 'layout',
				label: 'The layout',
				hint: layoutName(current.layout, current.code.layout),
			},
			{ value: 'theme', label: 'The theme', hint: themeName(current.theme, current.code.theme) },
			{ value: 'side', label: "The driver's side", hint: current.driverSide ?? 'set in code' },
			{
				value: 'bar',
				label: 'What is in the bar',
				hint: current.bar ? barNames[current.bar] : 'set in code',
			},
			{ value: 'car', label: 'The car on the screen', hint: pictures.join(', ') || 'none yet' },
		],
	});

	switch (what) {
		case 'layout':
			return {
				layout: await select({
					message: 'Which layout should the car start with?',
					options: layouts.map((layout) => ({
						value: layout.id,
						label: layout.label,
						hint: layout.hint,
					})),
					...(current.layout ? { initialValue: current.layout } : {}),
				}),
			};
		case 'theme':
			return {
				theme: await select<string | null>({
					message: 'Which theme should it wear? The driver can pick another in Settings.',
					options: [
						{
							value: null,
							label: "Each layout's own",
							hint: 'the theme every layout was made for',
						},
						...themes.map((t) => ({ value: t.id, label: t.label, hint: t.hint })),
					],
					initialValue: current.theme,
				}),
			};
		case 'side':
			return {
				driverSide: await select<DriverSide>({
					message: 'Which side does the driver sit on?',
					options: [
						{ value: 'left', label: 'Left' },
						{ value: 'right', label: 'Right' },
					],
					initialValue: current.driverSide ?? 'left',
				}),
			};
		case 'bar':
			return {
				bar: await select<BarChoice>({
					message: 'What goes in the bar?',
					options: (Object.keys(barNames) as BarChoice[]).map((bar) => ({
						value: bar,
						label: barNames[bar].replace(/^./, (c) => c.toUpperCase()),
					})),
					initialValue: current.bar ?? 'infoDisplay',
				}),
			};
		case 'car':
			return await askCar(current, cwd);
	}
}

/** Internal: which picture of the car to change, and to what. */
async function askCar(current: Appearance, cwd: string): Promise<AppearanceChange> {
	const look = await select<CarLookName | 'look'>({
		message: 'What do you want to change?',
		options: [
			...carLooks.map((name) => ({
				value: name,
				label: lookNames[name].label.replace(/^the/, 'The'),
				hint: current.car[name] ?? 'none',
			})),
			...(carLooks.filter((name) => current.car[name]).length > 1
				? [{ value: 'look' as const, label: 'Which one it starts with' }]
				: []),
		],
	});

	if (look === 'look') {
		return {
			look: await select<CarLookName | null>({
				message: 'Which one should the car start with? The driver can pick in Settings.',
				options: [
					{ value: null, label: 'The first one', hint: '3D model, drawing, picture' },
					...carLooks
						.filter((name) => current.car[name])
						.map((name) => ({ value: name, label: lookNames[name].label })),
				],
				initialValue: current.car.look,
			}),
		};
	}

	const answer = await text({
		message: `Where is the file? You can drag it in here.${current.car[look] ? ' Type none to take it out.' : ''}`,
		validate: (value) =>
			value?.trim() === 'none' && current.car[look]
				? undefined
				: lookProblem(cleanPath(value ?? '', cwd), look),
	});
	return { [look]: answer.trim() === 'none' ? null : cleanPath(answer, cwd) };
}

function layoutName(id: string | null, code: string | undefined): string {
	if (id === null) return `set in code, ${code}`;
	return layouts.find((layout) => layout.id === id)?.label ?? id;
}

function themeName(id: string | null, code: string | undefined): string {
	if (code !== undefined) return `set in code, ${code}`;
	if (id === null) return "each layout's own";
	return themes.find((t) => t.id === id)?.label ?? id;
}

/** Internal: how it is set up, for the terminal. */
function describe(current: Appearance): string {
	const pictures = carLooks
		.filter((look) => current.car[look])
		.map((look) => `${lookNames[look].label} (${current.car[look]})`);
	const starts = current.car.look ? lookNames[current.car.look].label : undefined;
	return [
		`Layout        ${layoutName(current.layout, current.code.layout)}`,
		`Theme         ${themeName(current.theme, current.code.theme)}`,
		`Driver        ${current.driverSide ? `on the ${current.driverSide}` : `set in code, ${current.code.driverSide}`}`,
		`Bar           ${current.bar ? barNames[current.bar] : `set in code, ${current.code.bar}`}`,
		`Car           ${pictures.join(', ') || 'none'}${starts && pictures.length > 1 ? `, starting with ${starts}` : ''}`,
	].join('\n');
}

/** Internal: what happened, for the terminal. */
function report(result: AppearanceChanged): void {
	for (const asset of result.assets)
		log.success(`Copied it into your car's app as ${colors.code(asset)}`);
	if (result.manual.length > 0) {
		log.warn(
			`Some of it has no clear place in ${colors.code('lib/main.dart')}, so add it by hand:\n${result.manual.join('\n')}`,
		);
	}
	if (!result.changed) {
		outro(`It was set up that way already ${colors.dim('(nothing was changed)')}`);
		return;
	}
	note(describe(result.appearance), 'How your car looks now');
	outro(
		`Changed. If your car's app is running, press ${colors.code('R')} to see it. A layout or theme picked in its Settings stays picked.`,
	);
}
