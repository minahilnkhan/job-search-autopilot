# Job Search Autopilot: Chrome extension

Fills job application forms in your own Chrome from the local app. You review the form and press Submit; the extension never submits and never touches a CAPTCHA.

## Set up (once)

1. Start the app (`npm run dev`). It builds the extension into `extension/dist`.
2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, press **Load unpacked**, and pick this `extension` folder.
3. Pin the extension, click it, and paste the pairing code from the app's **Settings → Chrome extension**.

After pulling an update, restart `npm run dev` and press the reload icon on the extension in `chrome://extensions`.

## Use

In the app's Review, press **Open in my browser** on an approved application. On the job page, click the extension and press **Fill this form**. Answer anything it asks in the side panel, check the form, submit, then press **I submitted it**.

## How it works

- `src/fill.ts` is injected into the job page's frames when you press Fill. It uses the app's own form reader (`server/src/submit/describe.ts`) and matching rules (`server/src/submit/plan.ts`).
- `src/panel.ts` is the side panel. It talks to the app at `http://127.0.0.1:3001/api/extension/*` with the pairing code in an `X-Autopilot-Token` header.
- Permissions: Greenhouse, Lever and Ashby pages are allowed up front; any other site asks for your OK the first time (**Allow on this site**).
