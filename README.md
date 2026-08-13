# TTAKTScanner Web

TTAKTScanner Web is the iPhone/Android browser edition of the scanner. It has no API key, token, cloud OCR, database, or sign-in. The camera image is scanned and read in the visitor's browser.

## What it does

- Separate **Təhvil-təslim aktı** and **Konteyner aktı** panels
- Camera/photo selection, fast colour-preserving scan preview, and manual rotate
- Local OCR for the invoice code before the `nömrəli fakturaya əsasən` anchor
- Local OCR for all receipt values below the `Qəbz` column header
- Multiple pages, JPG export, one-PDF export, reset/new document, and Web Share / WhatsApp handoff
- Safari “Add to Home Screen” support after the first visit

## GitHub and Vercel deployment

1. Create a new **private** GitHub repository and upload the full contents of this folder.
2. In Vercel, choose **Add New → Project**, import that GitHub repository, then deploy.
3. No environment variables, API key, token, database, or build setting is required. Vercel reads the included configuration and serves this as a static site.
4. Open the Vercel HTTPS address from Safari on the iPhone and allow camera access. Safari can also use **Share → Add to Home Screen**.

On iPhone, browsers cannot silently write a file straight to the Photos gallery. The JPG button therefore opens the iOS share sheet when supported; choose **Save Image** there. WhatsApp sharing also opens the native iOS share sheet, where WhatsApp is selected by the user.

## Privacy and copyright

OCR, scan, PDF, and document images are processed locally in the browser. The first site load downloads the included browser OCR/scan modules; the document itself is not sent to an OCR/API service.

`Developed by Javanshir Suleymanov © 2026. All rights reserved.`

Keep the GitHub repository private. A browser application is downloaded by the visitor, so no client-side website can technically prevent a determined person from copying or changing browser code. Copyright notice and repository access control provide the appropriate ownership protection; sensitive data should never be embedded in the site.
