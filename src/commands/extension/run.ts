import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { addExamplePlatforms } from '../../core/extension/create.ts';
import { desktopPlatform } from '../../core/flutter.ts';
import { requireExtension } from '../../core/project/find.ts';
import { runAttached } from '../../ui/attached.ts';
import { intro, log } from '../../ui/output.ts';
import { step } from '../../ui/project.ts';
import { theme } from '../../ui/theme.ts';
import { CliError } from '../../utils/errors.ts';
import { binaryName } from '../flags.ts';
import type { Command } from '../types.ts';
import { findSmartifyOs } from './smartify-os.ts';

/**
 * Runs the extension's example app, SmartifyOS with just this extension in it, on this
 * computer.
 */
export const extensionRunCommand: Command = {
	name: 'run',
	summary: 'Try your extension on this computer',
	description:
		"Starts the example app of the extension you are in: SmartifyOS with your extension in it, on this computer. Save a change and press r in the terminal to see it straight away, q to stop. Run it in your extension's folder.",
	examples: [`${binaryName} extension run`],
	async run() {
		const extension = await requireExtension();
		const example = join(extension.dir, 'example');
		if (!existsSync(join(example, 'pubspec.yaml'))) {
			throw new CliError('This extension has no example app to run.', {
				hint: `Extensions made with ${theme.code(`${binaryName} extension create`)} have one in their example folder.`,
			});
		}

		const platform = desktopPlatform();
		intro('Run an extension');

		await findSmartifyOs(extension.dir);

		if (!existsSync(join(example, platform))) {
			await step(`Setting the example app up for ${platform}`, () =>
				addExamplePlatforms(example, [platform]),
			);
		}

		log.info(`Starting it. Press ${theme.code('r')} to see a change, ${theme.code('q')} to stop.`);
		const code = await runAttached('flutter', ['run', '-d', platform], example);
		if (code !== 0) {
			throw new CliError('The example app stopped with an error.', {
				hint: 'What Flutter printed above says why.',
			});
		}
		return { platform };
	},
};
