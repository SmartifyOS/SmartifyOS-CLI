import { withoutExtension } from '../core/project/block.ts';
import { findEntry, findInstalled, type Installed } from '../core/project/car.ts';
import { tryChange, writeLinks } from '../core/project/change.ts';
import { carFiles, requireCar } from '../core/project/find.ts';
import { type SwitchResult, switchOffInFile } from '../core/project/main-dart.ts';
import { entryNames } from '../core/pubspec/blocks.ts';
import { corePackage } from '../core/smartify-os.ts';
import { intro, log, outro } from '../ui/output.ts';
import { followSteps, readCarStep, renderChangeFailure } from '../ui/project.ts';
import { spinner } from '../ui/prompt.ts';
import { renderSwitchOff } from '../ui/switch-on.ts';
import { theme } from '../ui/theme.ts';
import { CliError } from '../utils/errors.ts';
import { binaryName } from './flags.ts';
import type { Command } from './types.ts';

/**
 * Puts the car back on the released SmartifyOS and extensions, undoing `link`.
 */
export const unlinkCommand: Command = {
	name: 'unlink',
	summary: 'Go back to the released SmartifyOS and extensions',
	description:
		"Undoes link: your car uses the released SmartifyOS and extensions again, the ones pubspec.yaml names. Name one to unlink just that one. An extension that was only there because it was linked is taken out again. Run it in your car's app folder.",
	usage: '[name]',
	examples: [
		`${binaryName} unlink`,
		`${binaryName} unlink dashcam`,
		`${binaryName} unlink smartify_os_core`,
	],
	async run({ positionals }) {
		intro('Unlink');
		const app = await requireCar();
		const state = await readCarStep(app);

		if (state.links.size === 0) {
			outro(`Nothing is linked ${theme.dim('(nothing was changed)')}`);
			return;
		}

		const linked = [state.core, ...state.extensions].filter((p) => p.link !== undefined);
		const query = positionals[0];
		const chosen = query ? [pick(linked, query)] : linked;

		const links = new Map(state.links);
		for (const installed of chosen) links.delete(installed.name);

		// Linked without ever being added: they go with the link.
		const released = new Set(entryNames(state.pubspecText, 'dependency_overrides'));
		const temporary = chosen.filter((p) => p.name !== corePackage && !released.has(p.name));
		const switched: SwitchResult[] = [];

		const progress = spinner();
		progress.start(`Unlinking ${chosen.map((p) => p.title).join(', ')}`);
		const result = await tryChange(app, {
			async edit() {
				let pubspecText = state.pubspecText;
				for (const extension of temporary) {
					pubspecText = withoutExtension(pubspecText, extension.name);
					const entry = extension.root
						? await findEntry(extension.name, extension.root)
						: undefined;
					switched.push(await switchOffInFile(carFiles(app).main, entry));
				}
				if (temporary.length > 0) await Bun.write(carFiles(app).pubspec, pubspecText);
				await writeLinks(app, pubspecText, links);
			},
			check: false,
			onStep: followSteps(progress),
		});

		if (!result.ok) {
			progress.error('That did not work');
			renderChangeFailure(result.failure, (name) => name);
			throw new CliError('Nothing was changed.', {
				hint: 'The released versions do not fit together, see above.',
			});
		}

		progress.stop(`Unlinked ${chosen.map((p) => theme.strong(p.title)).join(', ')}`);
		for (const extension of temporary) {
			log.info(`${extension.title} was only in this car while it was linked, so it is out again.`);
		}
		for (const each of switched) renderSwitchOff(each);
		outro(links.size === 0 ? 'Your car uses the released versions again.' : 'All done.');
	},
};

/** Internal: a linked package by name, with SmartifyOS answering to a few names of its own. */
function pick(linked: Installed[], query: string): Installed {
	const core = linked.find((p) => p.name === corePackage);
	if (core && /^(smartify_?os|core|smartify_os_core)$/i.test(query.replace(/\s+/g, '')))
		return core;

	const found = findInstalled(linked, query);
	if (found) return found;
	throw new CliError(`${query} is not linked.`, {
		hint: `Linked right now: ${linked.map((p) => p.name).join(', ')}.`,
	});
}
