import { aboutCommand } from './about.ts';
import { appearanceCommand } from './appearance.ts';
import { createCommand } from './create.ts';
import { deviceCommand } from './device/index.ts';
import { doctorCommand } from './doctor.ts';
import { exportCommand } from './export/index.ts';
import { extensionCommand } from './extension/index.ts';
import { helpCommand } from './help.ts';
import { linkCommand } from './link.ts';
import { tileCommand, widgetCommand, windowCommand } from './parts.ts';
import { register } from './registry.ts';
import { runCommand } from './run.ts';
import { selfUpdateCommand } from './self-update.ts';
import { setupCommand } from './setup.ts';
import { unlinkCommand } from './unlink.ts';
import { updateCommand } from './update.ts';

/**
 * Where every command is switched on.
 *
 * To add one, write it in its own file in this folder and put it in the `register` call
 * below. The order here is the order the user reads, so keep the common ones first, and
 * mark anything that is about the tool rather than about the car as `utility: true`.
 *
 * Command files import ./registry.ts, never this file. This is the only place that knows
 * about all of them at once, which is what keeps the imports going one way.
 */
register(
	setupCommand,
	createCommand,
	updateCommand,
	extensionCommand,
	runCommand,
	appearanceCommand,
	aboutCommand,
	windowCommand,
	tileCommand,
	widgetCommand,
	exportCommand,
	deviceCommand,
	linkCommand,
	unlinkCommand,
	doctorCommand,
	selfUpdateCommand,
	helpCommand,
);

export { commands, findCommand, visibleCommands } from './registry.ts';
