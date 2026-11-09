import { Session } from 'node:inspector';
import { measurementEnabled, recordGeneratedSource } from './source-snapshots.mjs';

// An in-process inspector session opens no socket. scriptParsed plus getScriptSource
// records the actual generated code, including tsx's inline map, before cleanup.
if (measurementEnabled()) {
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
