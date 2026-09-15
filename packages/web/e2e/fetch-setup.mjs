// AgentBrowser deliberately shells out synchronously. While the test process is blocked,
// Node cannot consume socket-close events from fixture servers. A later API assertion can
// then reuse an expired connection (UND_ERR_SOCKET). Do not pool these Node-side test
// requests; browser traffic and the server's own connection policy remain unchanged.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  request.headers.set('connection', 'close');
  return nativeFetch(request);
};
