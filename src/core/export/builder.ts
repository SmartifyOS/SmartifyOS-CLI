import { hostArch, type LinuxArch, runsOfficialLinux } from '../linux/distro.ts';
import { type Engine, findEngine } from './container.ts';

/**
 * How this computer builds for a car.
 *
 * A Flutter Linux build records the exact library versions it was linked against, so it only
 * starts on the Linux it was built on. So it is built in a container of the official Linux
 * (container.ts), which works on any computer with Docker, or else right here, on a computer
 * that runs the official Linux itself, for its own architecture (build.ts).
 */

/** How this computer builds for a car. */
export type Builder = { kind: 'container'; engine: Engine } | { kind: 'native'; arch: LinuxArch };

export type FindBuilder =
	| { ok: true; builder: Builder }
	| { ok: false; reason: string; hint: string };

/**
 * How this computer can build for a car: in a container when Docker runs, since that leaves
 * the computer itself alone, or else natively on the official Linux.
 */
export async function findBuilder(): Promise<FindBuilder> {
	const engine = await findEngine();
	if (engine.ok) return { ok: true, builder: { kind: 'container', engine: engine.engine } };

	const arch = hostArch();
	if (arch && (await runsOfficialLinux())) return { ok: true, builder: { kind: 'native', arch } };
	return engine;
}
