# Akyab Institute Batch-9 Exam Portal

A static entrance-exam and administration portal backed by Firebase Authentication and Cloud Firestore.

## Project structure

```text
akyab-institute-exam-portal/
├── assets/
│   ├── css/
│   │   └── styles.css
│   └── js/
│       ├── app.js
│       └── firebase-config.js
├── .gitignore
├── firestore.rules
├── index.html
└── README.md
```

## Firebase setup

1. Enable **Anonymous** and **Email/Password** sign-in in Firebase Authentication.
2. Create the administrator account `projecty008@gmail.com` in Authentication → Users. Do not enable public account registration.
3. Create a Cloud Firestore database.
4. Publish the rules in `firestore.rules` using the Firebase Console or CLI.
5. Confirm the web configuration and administrator email in `assets/js/firebase-config.js`.
6. Delete the legacy Firestore document `admin_config/credentials` after the new administrator login works.

The included rules separate administrator permissions from anonymous student permissions. Students can read an exact roster record, read the exam, and create/read only submissions owned by their Firebase UID. Administrator writes require the configured Firebase Email/Password identity.

## Run locally

ES modules should be served through a local web server rather than opened directly with `file://`.

```powershell
cd akyab-institute-exam-portal
python -m http.server 8080
```

Then open `http://localhost:8080`.

## Publish with GitHub Pages

1. Create a GitHub repository and upload this folder's contents.
2. Open **Settings → Pages** in the repository.
3. Select **Deploy from a branch**.
4. Select the `main` branch and `/ (root)` directory.
5. Save and wait for the Pages URL to become available.

## Main features

- Database-verified student login
- Candidate roster management
- Section- and part-level passages
- Short answer, multiple-choice, true/false, and essay questions
- Automatic objective scoring
- Essay grading, submission inspection, CSV export, and printing
