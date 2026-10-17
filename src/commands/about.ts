import { type Appearance, changeAppearance, readAppearance } from '../core/project/appearance.ts';
import { carFiles, requireCar } from '../core/project/find.ts';
import { isJsonMode } from '../ui/json.ts';
import { intro, log, outro } from '../ui/output.ts';
import { isInteractive, note, text } from '../ui/prompt.ts';
import { theme } from '../ui/theme.ts';
import { CliError } from '../utils/errors.ts';
import { binaryName } from './flags.ts';
import type { Command } from './types.ts';

/** What the About page says about the car, as the command reports it. */
type About = Appearance['about'];

/**
 * Changes what the About page in Settings says about the car: its name, what car it is, and
 * any rows of its own.
 */
export const aboutCommand: Command = {
	name: 'about',
	summary: 'Change what the About page says about your car',
	description:
		"Changes what the About page in Settings says about your car: what it is called (which is also the name phones see when they pair with it), what car it is, and rows of your own like the VIN. It writes into lib/main.dart. Without flags it asks for the name and the car, with --show or --json it only says what is there now. Run it in your car's app folder.",
	examples: [
		`${binaryName} about`,
		`${binaryName} about --name "Golf" --car "Volkswagen Golf IV 1.6"`,
		`${binaryName} about --extra "VIN=WVWZZZ1JZXW000001" --extra "Colour=Red"`,
		`${binaryName} about --extra "Colour="`,
	],
	flags: {
		name: { type: 'string', describe: 'What the car is called, like "Miata"' },
		car: {
			type: 'string',
			describe: 'What car it is, like "Mazda MX-5 NB", or "" to leave it out',
		},
		extra: {
			type: 'string',
			multiple: true,
			describe: 'A row of your own as Label=value, again for more. Label= takes it off',
		},
		show: { type: 'boolean', describe: 'Only say what is there now, and change nothing' },
	},
	async run({ flags }) {
		const app = await requireCar();
		const current = readAppearance(await Bun.file(carFiles(app).main).text());

		const name = typeof flags.name === 'string' ? checkName(flags.name) : undefined;
		const model = typeof flags.car === 'string' ? flags.car.trim() : undefined;
		const extra = parseExtra(flags.extra);
		const nothingGiven = name === undefined && model === undefined && extra === undefined;

		if (flags.show === true || (nothingGiven && (isJsonMode() || !isInteractive()))) {
			if (!isJsonMode()) note(describe(current.about), 'Your car on the About page');
			return { changed: false, about: current.about, manual: [] };
		}

		intro('Change the About page');
		const change = nothingGiven
			? await ask(current.about)
			: {
					...(name !== undefined ? { name } : {}),
					...(model !== undefined ? { model } : {}),
					...(extra !== undefined ? { extra } : {}),
				};

		const result = await changeAppearance(app.dir, change);
		if (result.manual.length > 0) {
			log.warn(
				`Some of it has no clear place in ${theme.code('lib/main.dart')}, so add it by hand:\n${result.manual.join('\n')}`,
			);
		}
		if (!result.changed) {
			outro(`It said that already ${theme.dim('(nothing was changed)')}`);
		} else {
			note(describe(result.appearance.about), 'Your car on the About page now');
			outro(`Changed. If your car's app is running, press ${theme.code('R')} to see it.`);
		}
		return { changed: result.changed, about: result.appearance.about, manual: result.manual };
	},
};

/** Internal: a name, which ends up in quotes in Dart and is what phones see. */
function checkName(input: string): string {
	const name = input.trim().replace(/\s+/g, ' ');
	if (!name || name.length > 40) {
		throw new CliError(`"${input}" cannot be the name of a car.`, {
			hint: 'Keep it short, like "Miata" or "Golf 4".',
		});
	}
	return name;
}

/** Internal: `--extra Label=value`, as many as given, or undefined for none. */
function parseExtra(values: unknown): Record<string, string> | undefined {
	if (!Array.isArray(values) || values.length === 0) return undefined;
	const extra: Record<string, string> = {};
	for (const value of values) {
		const text = String(value);
		const at = text.indexOf('=');
		const label = at === -1 ? '' : text.slice(0, at).trim();
		if (!label) {
			throw new CliError(`"${text}" is not a row.`, {
				hint: 'Write it as Label=value, like --extra "VIN=WVWZZZ1JZXW000001".',
			});
		}
		extra[label] = text.slice(at + 1).trim();
	}
	return extra;
}

/** Internal: asks for the name and the car, for someone at a terminal who gave no flags. */
async function ask(about: About): Promise<{ name: string; model: string }> {
	const name = await text({
		message: 'What is the car called? Phones see this name too.',
		initialValue: about.name ?? '',
		validate: (value) => (value?.trim() ? undefined : 'It needs a name.'),
	});
	const model = await text({
		message: 'What car is it? Leave it empty to leave it out.',
		initialValue: about.model ?? '',
		placeholder: 'Mazda MX-5 NB 1.8',
	});
	return { name: checkName(name), model: model.trim() };
}

/** Internal: what the About page says, for the terminal. */
function describe(about: About): string {
	return [
		`Name    ${about.name ?? 'SmartifyOS'}`,
		`Car     ${about.model ?? 'not given'}`,
		...Object.entries(about.extra).map(([label, value]) => `${label.padEnd(7)} ${value}`),
	].join('\n');
}
