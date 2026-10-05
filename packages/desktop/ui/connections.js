document.getElementById('connect').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.target.querySelector('button');
  button.disabled = true;
  const error = document.getElementById('error');
  error.textContent = '';
  try { await window.__TAURI_INTERNALS__.invoke('connect_remote', { endpoint: document.getElementById('endpoint').value }); }
  catch (message) { error.textContent = String(message); }
  finally { button.disabled = false; }
});
