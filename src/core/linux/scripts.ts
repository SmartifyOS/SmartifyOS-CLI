import installScript from './scripts/install.sh' with { type: 'text' };
import linuxScript from './scripts/linux.sh' with { type: 'text' };

/**
 * The scripts that run on a car, or on a machine that builds for one. They are real shell
 * files in ./scripts, so they can be read and tested as what they are, and they are put
 * inside the binary as text, so the CLI can write them out anywhere.
 */
export const scripts = {
	/** The one step every install, build and update runs. */
	'linux.sh': linuxScript,
	/** Sets a new car up, once. */
	'install.sh': installScript,
} as const;
