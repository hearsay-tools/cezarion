// The POSIX downgrade escape hatch loads only the active build's command identity.
import { oldCommandNotice } from './home/command.ts';

const notice = oldCommandNotice(process.argv[2]);
if (notice) console.error(notice);
