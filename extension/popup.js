const DEFAULT_API_BASE = 'http://100.96.199.11:4100';

const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');
const errorTextEl = document.getElementById('errorText');
const formEl = document.getElementById('form');
const successEl = document.getElementById('success');
const parseWarningEl = document.getElementById('parseWarning');
const retryBtn = document.getElementById('retryBtn');
const cancelBtn = document.getElementById('cancelBtn');
const optionsBtn = document.getElementById('optionsBtn');
const saveBtn = document.getElementById('saveBtn');

const fields = {
  company: document.getElementById('company'),
  role: document.getElementById('role'),
  jdText: document.getElementById('jdText'),
  salaryRange: document.getElementById('salaryRange'),
  experienceLevel: document.getElementById('experienceLevel'),
};

let currentUrl = '';
let parsedExtra = {};

function showState(name) {
  for (const el of [loadingEl, errorEl, formEl, successEl]) {
    el.classList.toggle('hidden', el.id !== name);
  }
}

async function getApiBase() {
  const stored = await chrome.storage.sync.get('apiBase');
  return stored.apiBase || DEFAULT_API_BASE;
}

async function getActiveTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url || '';
}

async function parseCurrentTab() {
  showState('loading');
  currentUrl = await getActiveTabUrl();

  if (!currentUrl || !/^https?:\/\//.test(currentUrl)) {
    errorTextEl.textContent = 'This tab has no job posting URL to parse.';
    showState('error');
    return;
  }

  const apiBase = await getApiBase();

  try {
    const res = await fetch(`${apiBase}/jobs/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: currentUrl }),
    });
    if (!res.ok) throw new Error(`Parse request failed: ${res.status}`);
    const parsed = await res.json();

    fields.company.value = parsed.company || '';
    fields.role.value = parsed.role || '';
    fields.jdText.value = parsed.jdText || '';
    fields.salaryRange.value = parsed.salaryRange || '';
    fields.experienceLevel.value = parsed.experienceLevel || '';
    parsedExtra = {
      postedDate: parsed.postedDate,
      applyByDate: parsed.applyByDate,
    };

    parseWarningEl.classList.toggle('hidden', !parsed.fetchFailed);
    showState('form');
  } catch (err) {
    errorTextEl.textContent = `Couldn't reach job-tracker at ${apiBase}. Check it's running and reachable, or update the URL in settings.`;
    showState('error');
  }
}

async function saveApplication(event) {
  event.preventDefault();
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  const apiBase = await getApiBase();
  const body = {
    company: fields.company.value.trim(),
    role: fields.role.value.trim() || undefined,
    jobUrl: currentUrl,
    jdText: fields.jdText.value.trim() || undefined,
    salaryRange: fields.salaryRange.value.trim() || undefined,
    experienceLevel: fields.experienceLevel.value.trim() || undefined,
    postedDate: parsedExtra.postedDate || undefined,
    applyByDate: parsedExtra.applyByDate || undefined,
  };

  try {
    const res = await fetch(`${apiBase}/applications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Save failed: ${res.status}`);
    showState('success');
    setTimeout(() => window.close(), 900);
  } catch (err) {
    errorTextEl.textContent = `Couldn't save the application (${err.message}).`;
    showState('error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Application';
  }
}

retryBtn.addEventListener('click', parseCurrentTab);
cancelBtn.addEventListener('click', () => window.close());
optionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
formEl.addEventListener('submit', saveApplication);

parseCurrentTab();
