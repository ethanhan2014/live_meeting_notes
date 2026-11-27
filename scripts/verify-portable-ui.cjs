const assert = require('node:assert/strict');

async function verify() {
  let page, pages = [], connectionError = '';
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      pages = await (await fetch('http://127.0.0.1:9238/json/list')).json();
      page = pages.find(value => value.url.includes('tauri.localhost'));
      if (page) break;
    } catch (error) { connectionError = error.message; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!page) console.error('[portable-check] Browser targets: ' + JSON.stringify(pages.map(value => value.url)) + '; connection: ' + connectionError);
  assert.ok(page, 'The portable app did not open its local interface.');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let state;
    for (let id = 1; Date.now() < deadline; id++) {
      const response = new Promise(resolve => { socket.onmessage = event => { const value = JSON.parse(event.data); if (value.id === id) resolve(value); }; });
      socket.send(JSON.stringify({id, method:'Runtime.evaluate', params:{awaitPromise:true, returnByValue:true,
        expression:'window.meeting ? window.meeting.state().then(s => ({platform:s.platform,active:s.active,error:s.error,key:s.settings.apiKey,hasApiKey:s.hasApiKey})) : null'}}));
      const result = await Promise.race([response, new Promise((_, reject) => setTimeout(() => reject(new Error('The app state request timed out.')), 10000))]);
      state = result.result?.result?.value;
      if (state) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(state?.platform, 'win32');
    assert.equal(state.active, false);
    assert.equal(state.error, null);
    assert.equal(state.key, '');
    assert.equal(state.hasApiKey, process.argv[2] === 'private');
    console.log('Portable GUI and private backend startup passed.');
  } finally { socket.close(); }
}
verify().catch(error => { console.error(error.message); process.exitCode = 1; });
