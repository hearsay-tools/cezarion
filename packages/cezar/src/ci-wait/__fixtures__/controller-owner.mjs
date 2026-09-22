import { CiToolController } from '../controller.ts';
const controller = await CiToolController.start();
const session = controller.provision(async () => { throw new Error('No registration in lifetime fixture'); });
process.send(session);
// IPC control channel deliberately keeps the otherwise-unrefed owner alive.
process.on('message', () => {});
