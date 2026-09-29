const DEFAULT_API_BASE = 'http://localhost:4100';

const input = document.getElementById('apiBase');
const saveBtn = document.getElementById('saveBtn');
const savedMsg = document.getElementById('savedMsg');

chrome.storage.sync.get('apiBase').then(({ apiBase }) => {
  input.value = apiBase || DEFAULT_API_BASE;
});

saveBtn.addEventListener('click', async () => {
  const value = input.value.trim().replace(/\/$/, '');
  await chrome.storage.sync.set({ apiBase: value || DEFAULT_API_BASE });
  savedMsg.classList.remove('hidden');
  setTimeout(() => savedMsg.classList.add('hidden'), 1500);
});
