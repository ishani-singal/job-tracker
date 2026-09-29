# Job Tracker Quick Add (browser extension)

Chrome/Edge (Manifest V3) extension. Click the toolbar icon on any job posting tab,
review the auto-parsed fields, and save it straight to job-tracker as a new Application.

## Load it (Edge or Chrome — same steps)

1. Go to `edge://extensions` (or `chrome://extensions`).
2. Turn on **Developer mode** (toggle, usually top-right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Pin the extension to the toolbar if you want quick access.

## Configuration

The extension defaults to `http://100.96.199.11:4100` (job-tracker's API on the
Tailscale network). If that address ever changes, click the gear icon in the popup
(or right-click the extension icon → Options) and update it — stored via
`chrome.storage.sync`, so it follows you across signed-in browser instances.

## Usage

1. Navigate to a job posting (Amazon, Workday, LinkedIn, Greenhouse, etc.).
2. Click the extension icon — it calls `POST /jobs/parse` with the tab's URL and
   pre-fills company/role/JD/salary/experience level.
3. Review and edit anything that looks off, then **Save Application** — this calls
   `POST /applications`, the same endpoint the web app's "Add Application" dialog uses.
4. If parsing fails, the fields stay editable so you can fill them in by hand.
