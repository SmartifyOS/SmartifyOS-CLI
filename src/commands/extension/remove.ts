import { withoutExtension } from '../../core/project/block.ts';
import { findEntry, packageData } from '../../core/project/car.ts';
import { tryChange, writeLinks, writePubspec } from '../../core/project/change.ts';
import { carFiles, requireCar } from '../../core/project/find.ts';
import { type SwitchResult, switchOffInFile } from '../../core/project/main-dart.ts';
import { intro, outro } from '../../ui/output.ts';
import { followSteps, readCarStep, renderChangeFailure } from '../../ui/project.ts';
import { confirm, spinner } from '../../ui/prompt.ts';
import { renderSwitchOff, switchData } from '../../ui/switch-on.ts';
import { theme } from '../../ui/theme.ts';
import { CliError } from '../../utils/errors.ts';
import { binaryName } from '../flags.ts';
import type { Command } from '../types.ts';
import { pickInstalled } from './pick.ts';

/**
 * Takes an extension out of the car.
 */
export const extensionRemoveCommand: Command = {
	name: 'remove',
	aliases: ['uninstall'],
	summary: 'Take an extension out of your car',
	description:
		"Takes an extension out of your car and out of lib/main.dart, and makes sure everything still builds without it, which also catches another extension that still needs it. Run it in your car's app folder.",
	usage: '[name]',
	examples: [`${binaryName} extension remove`, `${binaryName} extension remove android_auto`],
	async run({ flags, positionals }) {
		intro('Remove an extension');
		const app = await requireCar();
		const state = await readCarStep(app);

		if (state.extensions.length === 0) {
			outro(`This car has no extensions ${theme.dim('(nothing was changed)')}`);
			return { changed: false, extension: null };
		}

		const extension = await pickInstalled(
			state.extensions,
			positionals[0],
			'Which extension should go?',
		);

		const go =
			flags.yes === true ||
			(await confirm({ message: `Take ${extension.title} out of your car?`, initialValue: true }));
		if (!go) {
			outro(`Left as it is ${theme.dim('(nothing was changed)')}`);
			return { changed: false, extension: packageData(extension) };
		}

		const entry = extension.root ? await findEntry(extension.name, extension.root) : undefined;
		let switched: SwitchResult | undefined;

		const progress = spinner();
		progress.start(`Taking ${extension.title} out`);
		const result = await tryChange(app, {
			async edit() {
				const text = withoutExtension(state.pubspecText, extension.name);
				await writePubspec(app, text);
				if (extension.link) await writeLinks(app, text, without(state.links, extension.name));
				switched = await switchOffInFile(carFiles(app).main, entry);
			},
			onStep: followSteps(progress),
		});

		if (!result.ok) {
			progress.error(`${extension.title} is still needed`);
			renderChangeFailure(
				result.failure,
				(name) => state.extensions.find((e) => e.name === name)?.title ?? name,
			);
			const manual = switched?.kind === 'manual';
			throw new CliError(`${extension.title} was not removed, nothing was changed.`, {
				details: result.failure,
				hint: manual
					? `Take ${theme.code(`${entry?.className}`)} and its import out of lib/main.dart yourself, then run this again.`
					: 'Something above still uses it. Take that out first, then run this again.',
			});
		}

		progress.stop(`Took ${theme.strong(extension.title)} out of your car`);
		renderSwitchOff(switched);
		outro('All done.');
		return {
			changed: true,
			extension: packageData(extension),
			switchedOff: switchData(switched),
		};
	},
};

/** Internal: the links without one of them. */
function without(links: Map<string, string>, name: string): Map<string, string> {
	const rest = new Map(links);
	rest.delete(name);
	return rest;
}
