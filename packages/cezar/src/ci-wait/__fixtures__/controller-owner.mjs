import { CiToolController } from '../controller.ts';
const controller = await CiToolController.start();
const refuse = async () => { throw new Error('No registration in lifetime fixture'); };
const session = controller.provision({ registerWait: refuse, cancelWait: refuse });
process.send(session);
// IPC control channel deliberately keeps the otherwise-unrefed owner alive.
process.on('message', () => {});
