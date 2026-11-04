import { type FlutterGpuSync, switchOnFlutterGpu } from '../core/flutter-gpu.ts';
import { log } from './output.ts';
import { theme } from './theme.ts';

/**
 * Switches Flutter GPU on in every platform the car's app has, before it runs or is built,
 * and says what has to be written by hand when a file has no place for it.
 */
export async function ensureFlutterGpu(appDir: string): Promise<FlutterGpuSync> {
	const sync = await switchOnFlutterGpu(appDir);
	if (sync.manual.length > 0) {
		log.warn(
			`The 3D car needs Flutter GPU, and it could not be switched on for you here, so do it by hand:\n${sync.manual.map((line) => theme.dim(line)).join('\n')}`,
		);
	}
	return sync;
}
