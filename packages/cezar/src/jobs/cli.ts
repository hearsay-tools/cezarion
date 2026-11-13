import { productName } from '../home/display.ts';
import { parseArgs } from 'node:util';
import { commandText } from '../home/command.ts';
import { JobError, SUPERVISE, jobDirectory, jobStatus, startJob, superviseJob, tellStarter } from './job.ts';

const HELP = commandText(`Usage: cez job start <name> [--dir <dir>] -- <command> [args...]
       cez job status <name> [--dir <dir>]

start   Run a long command so that it outlives this shell call, the turn and the
        agent session. Writes its output to a log file and its exit code to an
        exit file in <dir>; each start has files of its own. Prints JSON with
        the long-lived "pid", "log" and "exitFile": pass "pid" and "exitFile"
        to a process wait. Exits 1 and names the running PID while a job of
        that name still runs. A name whose job ended starts again.
status  Print JSON: "state" is "running" or "exited", with "pid", "log",
        "exitFile", and "exitCode" when the exit file holds one.

--dir <dir>  Where the job's files live. Default: $TMPDIR, the task's temp
             directory, which ${productName('Cezar')} removes when the task ends. For a job that
             must outlive the task, name a git-ignored directory in the worktree.
-h, --help   Show this help.

The command runs without a shell. For a pipeline, pass: -- sh -c '<pipeline>'.`);

/** `cez job`: one JSON object on stdout for a result and on stderr for an error; help is text. */
export async function runJobCommand(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  if (argv[0] === SUPERVISE) return superviseJob(argv[1]!, argv[2]!, argv.slice(4), tellStarter);
  const split = argv.indexOf('--');
  const own = split === -1 ? argv : argv.slice(0, split);
  const command = split === -1 ? [] : argv.slice(split + 1);
  if (own.includes('--help') || own.includes('-h')) { console.log(HELP); return 0; }
  try {
    const { values, positionals } = parseArgs({ args: own, options: { dir: { type: 'string' } }, allowPositionals: true });
    const [action, name, ...rest] = positionals;
    if (!name || rest.length > 0 || (action !== 'start' && action !== 'status')) throw new JobError(HELP);
    const dir = jobDirectory(values.dir, env);
    if (action === 'status') {
      if (command.length > 0) throw new JobError(HELP);
      console.log(JSON.stringify(jobStatus(dir, name)));
      return 0;
    }
    console.log(JSON.stringify(await startJob({ name, dir, command, env })));
    return 0;
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'The job command failed' }));
    return 1;
  }
}
