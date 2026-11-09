import { Session } from 'node:inspector';
import { measurementEnabled, recordGeneratedSource } from './source-snapshots.mjs';

let directory;

// An in-process inspector session opens no socket. scriptParsed plus getScriptSource
// records the actual generated code, including tsx's inline map, before cleanup.
export function startInspector() {
  if (!measurementEnabled() || directory === process.env.NODE_V8_COVERAGE) return;
  directory = process.env.NODE_V8_COVERAGE;
  const session = new Session();
  session.connect();
  session.on('Debugger.scriptParsed', ({ params }) => {
    if (!params.url.startsWith('file:')) return;
    session.post('Debugger.getScriptSource', { scriptId: params.scriptId }, (error, response) => {
      if (!error) recordGeneratedSource(params.url, response.scriptSource);
    });
  });
  session.post('Debugger.enable');
}

startInspector();
