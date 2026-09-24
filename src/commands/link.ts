import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findEntry, titleOf } from '../core/project/car.ts';
import { tryChange, writeLinks } from '../core/project/change.ts';
import { carFiles, requireCar } from '../core/project/find.ts';
import { ignoreOverrides } from '../core/project/links.ts';
import { type SwitchResult, switchOnInFile } from '../core/project/main-dart.ts';
import { setEntry } from '../core/pubspec/blocks.ts';
import { dependsOnCore, readPubspecIn } from '../core/pubspec/read.ts';
import { coreFolder, corePackage } from '../core/smartify-os.ts';
import { intro, log, outro } from '../ui/output.ts';
import { followSteps, readCarStep, renderChangeFailure } from '../ui/project.ts';
import { spinner, text } from '../ui/prompt.ts';
import { renderSwitchOn } from '../ui/switch-on.ts';
import { theme } from '../ui/theme.ts';
import { CliError } from '../utils/errors.ts';
import { pubPath } from '../utils/pub-path.ts';
import { binaryName } from './flags.ts';
import type { Command } from './types.ts';

/**
 * Points the car's app at a copy of SmartifyOS or of an extension in a folder on this
 * computer, for someone working on one next to their car.
 *
 * Top level rather than under `extension`, since SmartifyOS itself can be linked too.
 */
export const linkCommand: Command = {
	name: 'link',
	summary: 'Use SmartifyOS or an extension from a folder on this computer',
	description:
		"Makes your car use the copy of SmartifyOS or of an extension in a folder on this computer, instead of the released one, so the car runs exactly what you are working on. It also works for an extension that is on no GitHub yet. Nothing in pubspec.yaml changes for that, and unlink puts everything back. Run it in your car's app folder.",
	usage: '<folder>',
	examples: [
		`${binaryName} link ../smartify_os_dashcam`,
		`${binaryName} link ../smartify_os_flutter_test`,
	],
	async run({ positionals }) {
		intro('Link');
		const app = await requireCar();

		const given =
			positionals[0] ??
			(await text({
				message: 'Which folder? The one with the pubspec.yaml of SmartifyOS or of the extension.',
				placeholder: '../smartify_os_dashcam',
				validate: (value) => (value?.trim() ? undefined : 'The folder is needed.'),
			}));
		const folder = packageFolder(resolve(process.cwd(), given));
		const own = await readPubspecIn(folder);
		const name = typeof own?.pubspec.name === 'string' ? own.pubspec.name : undefined;

		if (!own || !name) {
			throw new CliError(`There is no Flutter package in ${given}.`, {
				hint: 'Point it at the folder with the pubspec.yaml of SmartifyOS or of the extension.',
			});
		}
		if (name !== corePackage && !dependsOnCore(own.pubspec)) {
			throw new CliError(`${name} is neither SmartifyOS nor an extension.`, {
				hint: 'Only SmartifyOS and its extensions can be linked.',
			});
		}

		const state = await readCarStep(app);
		const path = pubPath(app.dir, folder);
		const links = new Map(state.links).set(name, path);
		const title = name === corePackage ? 'SmartifyOS' : await titleOf(name, folder);
		const installed = name === corePackage || state.extensions.some((e) => e.name === name);

		if (!installed) {
			log.info(
				`${theme.strong(title)} is not in this car yet, so it is added for as long as it is linked. Once it is on GitHub, add it for good with ${theme.code(`${binaryName} extension add`)}.`,
			);
		}

		let switched: SwitchResult | undefined;
		const progress = spinner();
		progress.start(`Linking ${title}`);
		const result = await tryChange(app, {
			async edit() {
				// Never written to pubspec.yaml as a folder, so the file stays right for anyone
				// else. A package it does not have yet only gets its `any` line.
				let pubspecText = state.pubspecText;
				if (!installed) {
					pubspecText = setEntry(pubspecText, 'dependencies', name, [`${name}: any`]);
					await Bun.write(carFiles(app).pubspec, pubspecText);
				}
				await writeLinks(app, pubspecText, links);
				await ignoreInGit(app.dir);
			},
			async afterFetch() {
				if (installed) return;
				switched = await switchOnInFile(carFiles(app).main, await findEntry(name, folder));
			},
			// Code being worked on does not always build, and that is fine here.
			check: false,
			onStep: followSteps(progress),
		});

		if (!result.ok) {
			progress.error(`${title} could not be linked`);
			renderChangeFailure(result.failure, (n) => n);
			throw new CliError('Nothing was changed.', {
				hint: `The packages of the copy in ${path} do not fit together with the ones in your car.`,
			});
		}

		progress.stop(`Your car uses ${theme.strong(title)} from ${theme.code(path)}`);
		renderSwitchOn(switched, name);
		outro(`Run ${theme.code(`${binaryName} unlink`)} to go back to the released one.`);
	},
};

/**
 * Internal: the SmartifyOS repository has the package in a folder of its own, so linking
 * the repository means linking that folder.
 */
function packageFolder(dir: string): string {
	const inside = join(dir, coreFolder);
	if (!existsSync(join(dir, 'pubspec.yaml')) && existsSync(join(inside, 'pubspec.yaml'))) {
		return inside;
	}
	return dir;
}

/** Internal: keeps `pubspec_overrides.yaml` out of git, since the folders in it are this computer's. */
async function ignoreInGit(appDir: string): Promise<void> {
	const path = join(appDir, '.gitignore');
	const file = Bun.file(path);
	const updated = ignoreOverrides((await file.exists()) ? await file.text() : undefined);
	if (updated !== undefined) await Bun.write(path, updated);
}
