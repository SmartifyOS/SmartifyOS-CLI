import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { addExamplePlatforms } from '../../core/extension/create.ts';
import { runInTerminal, runStreaming } from '../../core/process.ts';
import { requireExtension } from '../../core/project/find.ts';
import { emit, forwardInput, isJsonMode } from '../../ui/json.ts';
import { intro, log } from '../../ui/output.ts';
import { step } from '../../ui/project.ts';
import { theme } from '../../ui/theme.ts';
import { CliError } from '../../utils/errors.ts';
import { binaryName } from '../flags.ts';
import type { Command } from '../types.ts';
import { findSmartifyOs } from './smartify-os.ts';

/** Flutter's name for the desktop this runs on. */
function desktop(): 'macos' | 'linux' | 'windows' {
	if (process.platform === 'darwin') return 'macos';
	if (process.platform === 'win32') return 'windows';
	if (process.platform === 'linux') return 'linux';
	throw new CliError('SmartifyOS runs on macOS, Linux and Windows computers, not on this one.');
}

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

		const platform = desktop();
		intro('Run an extension');

		await findSmartifyOs(extension.dir);

		if (!existsSync(join(example, platform))) {
			await step(`Setting the example app up for ${platform}`, () =>
				addExamplePlatforms(example, [platform]),
			);
		}

		log.info(`Starting it. Press ${theme.code('r')} to see a change, ${theme.code('q')} to stop.`);
		const code = isJsonMode()
			? await runForProgram(['run', '-d', platform], example)
			: await runInTerminal('flutter', ['run', '-d', platform], example);
		if (code !== 0) {
			throw new CliError('The example app stopped with an error.', {
				hint: 'What Flutter printed above says why.',
			});
		}
		return { platform };
	},
};

/**
 * Internal: `flutter run` for a program. What Flutter prints arrives as `output` events, and
 * `{"input": "r"}` on stdin is the same as pressing r.
 */
async function runForProgram(args: string[], cwd: string): Promise<number> {
	const flutter = runStreaming('flutter', args, cwd, (stream, text) =>
		emit({ type: 'output', stream, text }),
	);
	const stop = forwardInput((text) => flutter.write(text));
	try {
		return await flutter.exited;
	} finally {
		stop();
	}
}
